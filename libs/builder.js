'use strict';

// Requires
var fs = require('fs');
var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var uuid = require('node-uuid');
var winSpawn = require('win-spawn');
var wrench = require('wrench');
var async = require('async');
var mkdirp = require('mkdirp');
var cloudStorage = require('./cloudStorage.js');
var crypto = require('crypto');
var JobQueue = require('./jobQueue.js');
var touch = require('touch');
var domain = require('domain');
var Deploys = require( 'webhook-deploy-configuration' );
var miss = require( 'mississippi' );
var throughConcurrent = require( 'through2-concurrent' )
var path = require( 'path' )
var glob = require( 'glob' )
var setupBucket = require('./creator.js').setupBucket;
var utils = require('./utils.js');

// Util streams
var usingArguments = utils.usingArguments;
var sink = utils.sink;
var uploadIfDifferent = utils.uploadIfDifferent;
var redirectTemplateForDestination = utils.redirectTemplateForDestination;

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

function noop () {}

/**
 * The main build worker. The way this works is that it first checks to
 * see if it has a local up-to-date copy of the site, if it doesn't then it
 * downloads them from the cloud storage archive. After downloading it simply
 * runs `grunt build` in the sites directory, then uploads the result to cloud storage.
 *
 * @param  {Object}   config     Configuration options from Grunt
 * @param  {Object}   logger     Object to use for logging, deprecated, not used
 */
module.exports.start = function (config, logger) {
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);

  var self = this;
  var firebaseUrl = config.get('firebase') || '';

  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com/buckets');

  var buildFolderRoot = '../build-folders';
  var setupBucketOptions = {
    cloudStorage: cloudStorage,
    cloudflare: config.get( 'cloudflare' ),
  }


  /**
   *  Reports the status to firebase, used to display messages in the CMS
   *
   *  @param site    The name of the site
   *  @param message The Message to send
   *  @param status  The status code to send (same as command line status codes)
   */
  var reportStatus = function(site, message, status) {
    var messagesRef = self.root.root().child('/management/sites/' + site + '/messages/');
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: 'BUILD' }, function() {
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limit(1).once('child_added', function(snap) {
            snap.ref().remove();
          });
        }
      });
    });
  };

  /**
   * Downloads the site archive from cloud storage
   * Tries to download {sitename}_{branch}.zip, if that is not
   * available, it falls back to downloading {sitename}
   * This is useful for the time between branch deploys on a site.
   * Regardless of what file is pulled down, it is saved with
   * {sitename}_{branch}.zip, since this is also used for the 
   * command delegator queue lock id.
   *
   * @param buildFolders The folder to write the archive to
   * @param siteName     For the templates that we want
   * @param branch      
   * @param callback     Callback to call when downloaded
   */
  var downloadSiteZip = function(buildFolders, sitename, branch, callback) {
  	var branchFileName = Deploys.utilities.fileForSiteBranch( sitename, branch )
    cloudStorage.objects.get(config.get('sitesBucket'), branchFileName, function(err, data) {
    	if ( err ) {
    		var defaultFileName = sitename + '.zip'
    		cloudStorage.objects.get(config.get('sitesBucket'), defaultFileName, onDownload)
    	} else {
    		onDownload( err, data )
    	}

	    function onDownload ( err, data ) {
	    	if ( err ) callback( err )
	    	console.log( 'download-site-zip:err' )
	      console.log( err )

	      if(fs.existsSync(buildFolders + '/' + branchFileName )) {
	        fs.unlinkSync(buildFolders + '/' + branchFileName);
	      }

	      fs.writeFileSync(buildFolders + '/' + branchFileName, data);

	      callback( null, branchFileName );
	    }
	  })

	  return branchFileName.slice( 0, branchFileName.indexOf( '.zip' ) )
  }

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    console.log('Waiting for commands'.red);

    // Wait for a build job, extract info from payload
    jobQueue.reserveJob('build', 'build', buildJob);

  });

  function buildJob (payload, identifier, data, client, jobCallback) {
    console.log('Triggered command!');
    console.log('payload')
    console.log(JSON.stringify(payload))
    console.log('identifier')
    console.log(identifier)
    console.log('data')
    console.log(JSON.stringify(data))

    var userid = data.userid;
    var site = data.sitename;
    var branch = data.branch;
    var deploys = data.deploys;
    var noDelay = data.noDelay || false;

    console.log('Processing Command For '.green + site.red);

    self.root.root().child('management/sites/' + site).once('value', function(siteData) {
      var siteValues = siteData.val();

      // If the site does not exist, may be stale build, should no longer happen
      if(!siteValues) {
        jobCallback();
        return;
      }

      // Create build-folders if it isnt there
      mkdirp.sync('../build-folders/');

      var siteName = siteData.name();
      var buildFolderRoot = '../build-folders';
      var buildFolder = buildFolderRoot + '/' + Deploys.utilities.nameForSiteBranch( site, branch );

      /**
       * Do the site build.
       * 
       * @param  {string}    buildFolder
       * @param  {Function}  processSiteCallback callback
       * @return {undefined}
       */
      function processSite(buildFolder, processSiteCallback) { 
        console.log( 'process-site:', buildFolder )
        // Only admin or the site owners can trigger a build
        if(_(siteValues.owners).has(escapeUserId(userid)) || _(siteValues.users).has(escapeUserId(userid)) || userid === 'admin')
        {
          // If build time is defined, we build it now, then put in a job back to beanstalk with a delay
          // to build it later as well.
          var now = Date.now();
          var buildtime = data.build_time ? Date.parse(data.build_time) : now;
          var buildDiff = Math.floor((buildtime - now)/1000);

          var deploysToConsider = deploys.filter( function isDeployForBranch ( deploy ) { return branch === deploy.branch } )
          var maxParallel = config.get( 'builder' ).maxParallel;

          var pipelineArgs = {
            siteName: siteName,
            siteKey: siteValues.key,
            // queueDelayedJob args
            buildJobIdentifier: identifier,
            buildJobData: data,
            buildDiff: buildDiff,
            noDelay: noDelay,
            // make deploy buckets
            deploys: deploysToConsider,
            // buildSite args
            buildFolder: buildFolder,
            builtFolder: path.join( buildFolder, '.build' )
          }

          miss.pipe(
            usingArguments( pipelineArgs ),
            queueDelayedJob(),
            installDependencies(),
            makeDeployBuckets(),
            buildUploadSite( { maxParallel: maxParallel } ),
            addCmsRedirects(),
            subpublishAlumni(),
            // wwwOrNonRedirects(),
            deleteRemoteFilesNotInBuild(),
            sink(),
            onPipelineComplete)

          // Called at the end of processing the stream above. Or, if the stream
          // emits an error, this is called and the stream is closed.
          function onPipelineComplete ( error ) {
            console.log( 'built-pipeline-complete' )
            if ( error ) {
              if ( typeof error.reportStatus ) {
                reportStatus( siteName, error.reportStatus.message, error.reportStatus.status )
                console.log( error.reportStatus.message );
              }
            } else {
              var buckets = deploysToConsider.map( function ( deploy) { return deploy.bucket } )
              reportStatus( siteName, 'Built and uploaded to ' + buckets.join(', ') + '.', 0 )
            }

            processSiteCallback( error )
          }

          function queueDelayedJob () {
            return miss.through.obj( function ( args, enc, next ) {
              if ( args.buildDiff > 0 && !args.noDelay ) {
                // push job back into beanstalk, then upload
                args.buildJobData[ 'noDelay' ] = true;
                return client.put(1, buildDiff, (60 * 3), JSON.stringify({ identifier: args.buildJobIdentifier, payload: args.buildJobData }), function() {
                  next( null, args )
                })
              }
              else next( null, args )
            } )
          }

          /**
           * installDependencies. A transform stream that expects an object with:
           * - buildFolder
           * - siteName
           * 
           * Using these, it works `npm install` within the `buildFolder`
           * 
           * @return {object} stream Transform stream that handles the work.
           */
          function installDependencies () {
            return miss.through.obj( function ( args, enc, next ) {
              runInDir( 'npm', args.buildFolder, [ 'install' ], function ( error ) {
                if ( error ) {
                  console.log( error );
                  error.reportStatus = {
                    site: args.siteName,
                    message: 'Failed to build, errors encountered in build process',
                    status: 1,
                  }
                  return next( error )
                }
                else next( null, args )
              } )
            } )
          }

          function makeDeployBuckets () {
            return miss.through.obj( function ( args, enc, next ) {
              console.log( 'make-deploy-buckets:start' )
              var setupBucketTasks = args.deploys.map( makeDeployBucketTask )
              async.parallel( setupBucketTasks, function ( error ) {
                console.log( 'make-deploy-buckets:end' )
                console.log( error )
                if ( error ) return next( error )
                next( null, args)
              } )
              
            } )

            function makeDeployBucketTask ( deploy ) {
              return function makeBucketTask ( makeBucketTaskComplete ) {
                setupBucket( Object.assign( setupBucketOptions, { siteBucket: deploy.bucket } ), function ( error, bucketSetupResults ) {
                  if ( error ) return makeBucketTaskComplete( error )
                  makeBucketTaskComplete()
                } )
              }
            }
          }

          /**
           * buildUploadSite is a transform stream that expects an object `args` with
           * keys { buildFolder }.
           *
           * Using the build folder, a build-order is determined, and then executed.
           * As files are written by the build processes, they are passed into a
           * sub-stream that will compare their MD5 hash to the file currently in
           * the bucket at that location. If it is different, the built file is uploaded.
           * 
           * @param  {object} options
           * @param  {number} options.maxParallel?  Max number of build workers to spawn.
           * @return {object} stream                Transform stream that handles the work.
           */
          function buildUploadSite ( options ) {
            if ( !options ) options = {}
            var maxParallel = options.maxParallel || 1;

            return miss.through.obj( function ( args, enc, next ) {
              console.log( 'build-upload-site:start' )
              var buckets = args.deploys.map( function ( deploy ) { return deploy.bucket; } )
              var buildEmitterOptions = {
                maxParallel: maxParallel,
              }
              
              miss.pipe(
                usingArguments( { buildFolder: args.buildFolder } ),
                removeBuild(),
                cacheData(),                  // adds { cachedData }
                getBuildOrder(),              // adds { buildOrder }
                feedBuilds(),                 // pushes { buildFolder, command, flags }
                runBuildEmitter( buildEmitterOptions ),  // pushes { builtFile, builtFilePath }
                uploadIfDifferent( { buckets: buckets } ),
                sink(),
                function onComplete ( error ) {
                  console.log( 'build-upload-site:end' )
                  console.log( error )
                  if ( error ) return next( error )
                  next( null, args)
                } )

            } )

            function removeBuild () {
              return miss.through.obj( function ( args, enc, next ) {
                runInDir( 'grunt', args.buildFolder, [ 'clean' ], function ( error ) {
                  next( null, args)
                } )
              } )
            }

            // Transform stream expecting `args` object with shape.
            // { buildFolder: String }
            // adds { cacheData: String } and pushes.
            function cacheData () {
              return miss.through.obj( function ( args, enc, next ) {
                console.log( 'build-upload-site:cache-data:start' )
                var cacheFilePath = path.join( '.build', 'data.json' )
                runInDir( 'grunt', args.buildFolder, [ 'download-data', '--toFile=' + cacheFilePath ], function ( error ) {
                  console.log( 'build-upload-site:cache-data:end' )
                  console.log( error )
                  if ( error ) return next( error )
                  args.cachedData = cacheFilePath;
                  next( null, args )
                } )
              } )
            }

            /**
             * getBuildOrder expects an object with key { buildFolder }, a string
             * for the path in which to run the `build-order` command.
             * The build order is pulled, and compared against the sorted ordrer.
             * The final sorted ordered is added to the incoming 
             * adds a key { buildOrder }
             * 
             * @return {object} stream  Transform stream that handles the work.
             */
            function getBuildOrder () {
              var keyFromSubStreamToMergeAsBuildOrder = 'sortedBuildOrder';
              return miss.through.obj( function ( args, enc, next ) {
                  console.log( 'build-upload-site:get-build-order:start' )
                  miss.pipe(
                    usingArguments( { buildFolder: args.buildFolder } ),
                    writeBuildOrder(), // adds ( buildOrder : String, defaultBuildOrder : String )
                    sortBuildOrder( keyFromSubStreamToMergeAsBuildOrder ),  // adds ( sortedBuildOrder : [String] )
                    sink( mergeStreamArgs ),
                    function onComplete ( error ) {
                      console.log( 'build-upload-site:get-build-order:end' )
                      console.log( error )
                      if ( error ) return next( error )
                    } )

                  function mergeStreamArgs ( streamArgs ) {
                    next( null, Object.assign( args, { buildOrder: streamArgs[ keyFromSubStreamToMergeAsBuildOrder ] } ) )
                  }
              } )

              /**
               * writeBuildOrder is a transform stream that runs the `build-order`
               * command in the `buildFolder`
               * The stream expects an object `args` with a file path to run the command
               * at the `buildFolder` key  & writes the keys `buildOrder` & `defaultBuildOrder`
               * file path strings to the same `args` object before pushing it into the stream.
               * 
               * @return {object} stream  Transforms stream that handles the work.
               */
              function writeBuildOrder () {
                return miss.through.obj( function ( args, enc, next ) {
                  var filePathInBuildOrder = function ( fileName ) {
                    return path.join( args.buildFolder, '.build-order', fileName )
                  }
                  runInDir( 'grunt', args.buildFolder, [ 'build-order' ], function ( error ) {
                    if ( error ) return next( error )
                    args.buildOrder = filePathInBuildOrder( 'ordered' )
                    args.defaultBuildOrder = filePathInBuildOrder( 'default' )
                    next( null, args )
                  } )
                } )
              }

              /**
               * sortBuildOrder is a transform stream that expects an object
               * `args` with keys { buildOrder, defaultBuildOrder }, strings to files
               * that will contain file listings.
               * `defaultBuildOrder` includes all the files to build. `buildOrder` is
               * a partial list of files to prioritize.
               * Using the two files, find the differences between them, and concatinate
               * the `defaultBuildOrder` on the `buildOrder`.
               * The sorted build order will be saved as an array at `sortedBuildOrder`
               * 
               * @return {object} stream  Transform stream that handles the work.
               */
              function sortBuildOrder ( saveToKey ) {
                var filesForBuildOrder = [ 'buildOrder', 'defaultBuildOrder' ];
                var unionKeysFromFiles = filesForBuildOrder.map( function ( file ) { return file + 'Array' } )
                return miss.through.obj( function ( args, enc, next ) {
                  miss.pipe(
                    usingArguments( { buildOrder: args.buildOrder, defaultBuildOrder: args.defaultBuildOrder } ),
                    filesToArrays(  filesForBuildOrder ),
                    unionArrays(    unionKeysFromFiles, saveToKey ),
                    sink( function ( streamArgs ) {
                      next( null, streamArgs )
                    } ),
                    function onComplete ( error ) { if ( error ) next( error ) } )
                } )

                // Read the files at `fileKeys` in `args` and convert them to an array of
                // files to build. Add new keys suffixed with `Array` that contain the array values
                function filesToArrays( fileKeys ) {

                  var linesToArray = function ( lines ) {
                    if ( typeof lines !== 'string' ) return [];
                    return lines.split( '\n' ).filter( function( line ) { return line.length > 0 } )
                  }

                  return miss.through.obj( function ( args, enc, next ) {

                    var readTasks = fileKeys.map( createReadTaskFrom( args ) ).reduce( arrayToObject, {} )

                    async.parallel( readTasks, function ( error, fileContents ) {

                      fileKeys.forEach( function ( file ) {
                        var arrayKey = file + 'Array';
                        var arrayValue = linesToArray( fileContents[ file ] )
                        args[ arrayKey ] = arrayValue;
                      } )

                      next( null, args );

                    } )
                  } )

                  function createReadTaskFrom ( args ) {
                    return function createReadTask( file ) {
                      return {
                        key: file,
                        value: function readTask ( readTaskComplete ) {
                          fs.readFile( args[ file ], function ( error, content ) {
                            if ( error ) return readTaskComplete( null, '' )
                            return readTaskComplete( null, content.toString() )
                          } )
                        }
                      }
                    }
                  }

                  function arrayToObject ( previous, current ) {
                    previous[ current.key ] = current.value;
                    return previous;
                  }
                }

                // `mergeKeys` are the keys in the incoming object, `args, to merge into a
                // single array. Save the merged array at `mergedKey` in `args`.
                function unionArrays ( unionKeys, unionedKey ) {
                  return miss.through.obj( function ( args, enc, next ) {
                    var arraysToUnion = unionKeys.map( function ( unionKey ) { return args[ unionKey ] } );
                    args[ unionedKey ] = _.union.apply( null, arraysToUnion )
                    next( null, args )
                  } )
                }
              }
            }

            // Transform stream expecting `args` object with shape.
            // { buildFolder : String, buildOrder: [buildFiles], cachedData : String }
            // for each build order item, push { buildFolder, command, commandArgs }
            function feedBuilds () {
              return miss.through.obj( function ( args, enc, next ) {
                console.log( 'build-upload-site:feed-builds:start' )
                var buildFlagsForFile = buildFlags( args.cachedData )

                var stream = this;
                args.buildOrder
                  .map( makeBuildCommandArguments )
                  .concat( [ copyStaticCommandArgs() ] )
                  .forEach( function ( buildCommandArgs ) {

                    stream.push( buildCommandArgs )
                  } )

                console.log( 'build-upload-site:feed-builds:end' )

                next()

                function makeBuildCommandArguments ( buildFile ) {
                  return {
                    buildFolder: args.buildFolder,
                    command: 'grunt',
                    commandArgs: buildCommandForFile( buildFile ).concat( buildFlagsForFile( buildFile ) ) ,
                  }
                }

                function copyStaticCommandArgs () {
                  return {
                    buildFolder: args.buildFolder,
                    command: 'grunt',
                    commandArgs: [ 'build-static', '--emitter' ],
                  }
                }

              } )

              function buildCommandForFile ( file ) {
                return file.indexOf( 'pages/' ) === 0 ? [ 'build-page' ] : [ 'build-template' ];
              }

              function buildFlags ( cachedData ) {
                return function buildFlagsForFile ( file ) {
                  return [ '--inFile=' + file, '--data=' + cachedData, '--emitter' ]
                }
              }
            }            

            /**
             * runBuildEmitter returns a parallel transform stream that runs build commands
             * in the number of processes defined by the options.
             *
             * Expects objects that have shape { buildFolder, ... }
             * Where { buildFolder, ... } are passed into streamToCommandArgs and expected 
             * to produce an array of arguments for running a build command.
             * Pushes objects that have shape  { builtFile, builtFilePath }
             * 
             * @param  {object} options
             * @param  {number} options.streamToCommandArgs  Take the incoming arguments, return command arguments for running the build command
             * @return {object} stream                       Parallel transform stream that handles the work.
             * @param  {number} options.maxParallel?         The max number of streams to spawn at once.
             */
            function runBuildEmitter ( options ) {

              var maxParallel = options.maxParallel || 1;

              return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {
                var stream = this;

                var cmdArgs = streamToCommandArgs( args )
                var builtFolder = path.join( cmdArgs[2].cwd, '.build' )

                console.log( 'run-build-emitter:start:' + cmdArgs[1][1] )

                var errored = false;
                var builder = winSpawn.apply( null, cmdArgs )

                builder.stdout.on( 'data', function readOutput ( buf ) {
                  var strs = buf.toString().split( '\n' )

                  var buildEvent = 'build:document-written:./.build/';

                  strs.filter( function filterWriteEvent ( str ) { return str.indexOf( buildEvent ) === 0 } )
                    .forEach( function ( str ) {
                      var builtFile = str.trim().slice( buildEvent.length )
                      var builtFilePath = path.join( builtFolder, builtFile )
                      console.log( 'build-event:' + builtFile )

                      if ( builtFile.endsWith( '.html' ) && ( ! builtFile.endsWith( 'index.html' ) ) && ( ! builtFile.endsWith( '404.html' ) ) ) {
                        // html pages that aren't already an index.html file, or the root 404.html file
                        builtFile = htmlAsIndexFile( builtFile )
                      }

                      stream.push( { builtFile: builtFile, builtFilePath: builtFilePath } ) 

                      // non trailing slash redirect
                      if ( builtFile.endsWith( '/index.html' ) ) {
                        stream.push( {
                          builtFile: builtFile.replace( '/index.html', '' ),
                          builtFilePath: redirectTemplateForDestination( '/' + builtFile.replace( 'index.html', '' ) ),
                        } )
                      }
                    } )

                  var endEvent = ':end:';

                  strs.filter( function filterEndEvent ( str ) { return str.indexOf( endEvent ) !== -1 } )
                    .forEach( function ( str ) {
                      builder.kill()
                    } )

                } )

                builder.on( 'error', function ( error ) {
                  console.log( 'builder-error' )
                  console.log( error )
                  errored = true;
                  next()
                } )

                builder.on( 'exit', function () {
                  if ( errored === true ) return;
                  console.log( 'run-build-emitter:end:' +  cmdArgs[1][1] )
                  next()
                } )

              } )

              function htmlAsIndexFile ( file ) {
                // file = path/to/doc.html
                // return file = path/to/doc/index.html
                return file.slice( 0, ( '.html'.length * -1 ) ) + '/index.html'
              }

              function streamToCommandArgs ( streamArgs ) {
                return [ streamArgs.command, streamArgs.commandArgs, { stdio: 'pipe', cwd: streamArgs.buildFolder } ]
              }
            }
          }

          /**
           * addCmsRedirects downloads the URL Redirects portion of a site's settings
           * & writes templates to the source path of each redirect, with the contents
           * of an HTML redirect template to the destination of the redirect.
           *
           * A redirect template is only written if a file does not already exist
           * at the same file path.
           * The redirect template will always be an `index.html`.
           *
           * @return {object} stream  Transform stream that will handle the work.
           */
          function addCmsRedirects () {
            return miss.through.obj( function ( args, enc, next ) {
              console.log( 'add-redirects:start' )

              var buckets = args.deploys.map( function ( deploy ) { return deploy.bucket; } )

              miss.pipe(
                usingArguments( {} ),
                getRedirects( { siteName: args.siteName, siteKey: args.siteKey } ),         // pushes { redirects }
                buildRedirects( { builtFolder: args.builtFolder } ), // pushes { builtFile, builtFilePath }
                uploadIfDifferent( { buckets: buckets } ),
                function onComplete ( error ) {
                  console.log( 'add-redirects:end' )
                  console.log( error )
                  if ( error ) return next( error )
                  next( null, args )
                } )
              
            } )

            function getRedirects ( options ) {
              var siteName = options.siteName;
              var siteKey = options.siteKey;

              return miss.through.obj( function ( args, enc, next ) {

                var redirects = []
                
                self.root.child( siteName ).child( siteKey ).child( 'dev/settings/redirect' )
                  .once( 'value', withRedirects, withoutRedirects )

                function withRedirects ( snapshot ) {
                  var redirectsObject = snapshot.val();

                  try {
                    Object.keys( redirectsObject ).forEach( function ( key ) {
                      redirects.push( redirectsObject[ key ] )
                    } )
                  } catch ( error ) {
                    console.log( 'add-redirects:end:none-found' )
                  }

                  next( null, { redirects: redirects } )
                }

                function withoutRedirects () {
                  console.log( 'add-redirects:done:none-found' )
                  next( null, { redirects: redirects } )
                }

              } )
            }

            function buildRedirects ( options ) {
              var builtFolder = options.builtFolder;

              return miss.through.obj( function ( args, enc, next) {

                var stream = this;
                var redirectTasks = args.redirects.map( createRedirectTask )

                async.parallel( redirectTasks, function ( error, builtFilePaths ) {

                  builtFilePaths = builtFilePaths.filter( filterNull ).reduce( function ( previous, current ) { return previous.concat( current.filter( filterNull ) ) }, [] ).filter( filterNull )

                  var uploadsArgs = builtFilePaths.map( function ( builtFilePath ) {
                    return {
                      builtFilePath: builtFilePath,
                      builtFile: builtFilePath.slice( ( builtFolder + '/' ).length )
                    }
                  } )

                  // non trailing slash redirects
                  uploadsArgs = uploadsArgs.concat( uploadsArgs.map( function nonTrailingSash ( opts ) {
                    return {
                      builtFilePath: redirectTemplateForDestination( '/' + opts.builtFile.replace( 'index.html', '' ) ),
                      builtFile: opts.builtFile.replace( '/index.html', '' ),
                    }
                  } ) )

                  uploadsArgs.forEach( function ( uploadArgs ) {
                    stream.push( uploadArgs )
                  } )

                  console.log( 'add-redirects:done' )
                  next()
                } )

                function filterNull ( builtFilePath ) { return builtFilePath !== null && builtFilePath !== undefined }

                function createRedirectTask ( redirect ) {
                  var source = sourceFromPattern( redirect.pattern )
                  var redirectFile = path.join( builtFolder, source, 'index.html' )

                  var writeRedirectTasks = [ redirectFile ].map( createWriteRedirectTask( redirect.destination ) )

                  return function redirectTask ( taskComplete ) {
                    async.parallel( writeRedirectTasks, function ( error, builtFilePaths ) {
                      taskComplete( error, builtFilePaths );
                    } )
                  }
                }

                function sourceFromPattern ( path ) {
                  // in order to create a file at the returned path & path/index.html
                  if ( typeof path !== 'string' ) return null;
                  // remove leading /
                  if ( path.indexOf( '/' ) === 0 ) path = path.slice( 1 )
                  // remove .html extension
                  if ( path.slice( -5 ) === ( '.html' ) ) path = path.slice( 0, -5 )
                  // remove trailing /?$
                  if ( path.slice( '-2' ) === ( '?$' ) ) path = path.slice( 0, -2 )
                  // remove trailing /
                  if ( path.slice( '-1' ) === ( '/' ) ) path = path.slice( 0, -1 )
                  
                  return path;
                }

                function createWriteRedirectTask ( destination ) {
                  var template = redirectTemplateForDestination( destination )
                  return function forSourceFile ( sourceFile ) {
                    return function writeFileTask ( writeTaskComplete ) {
                      // create redirect only if there isn't already a file
                      fs.readFile( sourceFile, function ( readError ) {
                        if ( readError ) {
                          mkdirp( path.dirname( sourceFile ), function () {
                            fs.writeFile( sourceFile, template, function ( error ) {
                              // only callback with written file to be uploaded if its new
                              writeTaskComplete( null, sourceFile )
                            } )
                          } )
                        }
                        else writeTaskComplete()
                      } )
                    }
                  }
                }

              } )
            }

          }

          // push /alumni to alumni.risd.edu
          function subpublishAlumni () {
            return miss.through.obj( function ( args, enc, next ) {

              if ( ! ( args.siteName === 'edu,1risd,1systems' && branch === 'develop' ) ) return next( null, args )

              console.log( 'subpublish:start' )

              miss.pipe(
                usingArguments( { bucket: 'alumni.risd.edu', directory: 'alumni', builtFolder: args.builtFolder } ),
                feedSubpublish(),
                uploadIfDifferent(),
                sink( console.log ),
                function onComplete ( error ) {
                  console.log( 'subpublish:end' )
                  if ( error ) return next( error )
                  next( null, args )
                } )

            } )

            function feedSubpublish () {
              return miss.through.obj( function ( args, enc, next ) {
                var stream = this;

                var subpublishDirectory = path.join( args.builtFolder, args.directory )
                var pattern = path.join( subpublishDirectory, '**', '*.html' )

                var globEmitter = glob.Glob( pattern )
                globEmitter.on( 'match', push )
                globEmitter.on( 'end', callNext )

                function push ( builtFilePath ) {
                  var builtFile = builtFilePath.slice( ( subpublishDirectory + '/' ).length )
                  stream.push( { builtFile: builtFile, builtFilePath: builtFilePath, bucket: args.bucket } )
                }
                function callNext () { next() }

              } )
            }
          }

          /**
           * wwwOrNonRedirects transform stream that creates www bucket for every
           * non-www bucket, and non-www bucket for every www bucket deploy.
           * These opposite buckets are then populated with redirect templates
           * for every file in the builtFolder, to the original bucket where
           * the file exists.
           * @return {object} stream The transform stream that handles the work.
           */
          function wwwOrNonRedirects () {
            return miss.through.obj( function ( args, enc, next ) {

              console.log( 'www-or-non-redirects:start' )

              var buckets = args.deploys.map( function ( deploy ) { return deploy.bucket; } )
              var oppositeBuckets = buckets.map( oppositeBucketFrom )

              var feedRedirectsOptions = _.zipWith( buckets, oppositeBuckets, function ( bucket, oppositeBucket ) {
                return {
                  bucket: bucket,
                  oppositeBucket: oppositeBucket,
                }
              } )

              miss.pipe(
                usingArguments( { builtFolder: args.builtFolder } ),
                makeBuckets( { buckets: oppositeBuckets } ),       // pushes previous value
                feedBuiltFolderFiles( { pattern: '**/*.html' } ),  // pushes { builtFile, builtFilePath } per file
                feedRedirects( feedRedirectsOptions ),             // adds { bucket, builtFilePath } per bucket
                uploadIfDifferent(),
                sink(),
                function onComplete ( error ) {
                  console.log( 'www-or-non-redirects:end' )
                  console.log( error )
                  if ( error ) return next( error )
                  next( null, args )
                } )

            } )

            function makeBuckets ( options ) {
              var buckets = options.buckets;
              return miss.through.obj( function ( args, enc, next ) {
                var bucketTasks = buckets.map( makeBucketTasks )
                async.parallel( bucketTasks, function ( error, buckets ) {
                  next( null, args )
                } )
              } )

              function makeBucketTasks ( bucket ) {
                return function setupRedirectBucketTask ( setupStep ) {
                  setupBucket( Object.assign( setupBucketOptions, { siteBucket: bucket, ensureCname: false } ), function ( error, bucketSetupResults ) {
                    if ( error ) {
                      console.log( 'redirect-bucket-setup:', oppositeBucket );
                      console.log( error );
                      bucketSetupResults = { error: error };
                    }
                    return setupStep( null, bucketSetupResults )
                  } )
                }
              }
            }

            /**
             * feedBuiltFolderFiles transform stream that does a glob search in the
             * built folder defined the objecet read in, using the pattern option that 
             * the transform stream is initialized with.
             *
             * Expects to read an object with { builtFolder }
             * Writes objects { builtFile, builtFilePath }
             * Where builtFile is relative to the builtFolder & builtFilePath is the absolute path.
             * 
             * For every matched glob, the file path is written to the transform stream.
             * 
             * @param  {object} options
             * @param  {string} options.pattern      The pattern to use in the glob search
             * @param  {string} options.globOptions? The glob options to use
             * @return {object} stream   The transform stream that will handle the work.
             */
            function feedBuiltFolderFiles ( options ) {
              return miss.through.obj( function ( args, enc, next ) {
                var stream = this;
                
                var pattern = path.join( args.builtFolder, options.pattern )
                var globOptions = options.globOptions || {};
                
                var globEmitter = glob.Glob( pattern, globOptions )
                globEmitter.on( 'match', push )
                globEmitter.on( 'end', callNext )

                function push ( builtFilePath ) {
                  var builtFile = builtFilePath.slice( ( args.builtFolder + '/' ).length )
                  stream.push( { builtFile: builtFile, builtFilePath: builtFilePath  } )
                }
                function callNext () { next() }

              } )
            }

            /**
             * feedRedirects transform stream that 
             * 
             * Reads objects with { builtFile, builtFilePath }
             * Writes objects with { builtFile, buildFilePath, bucket }
             * Where buildFilePath is replaced with the redirect template that will be uploaded.
             *
             * Pairs expected is an array of `bucket` and `oppositeBucket` values.
             * `bucket` is what gets used to define the bucket to redirec to.
             * `oppositeBucket` is what gets used to define where the template gets uploaded.
             *
             * Every `builtFile` gets a file pushed for its `/index.html` version, as well
             * as its non trailing slash version.
             * 
             * @param  {object} pairs[]
             * @param  {object} pairs[].bucket
             * @param  {object} pairs[].oppositeBuket
             * @return {object} stream  The transform stream that will handle the work.
             */
            function feedRedirects ( pairs ) {
              return miss.through.obj( function ( args, enc, next ) {
                var stream = this;
                pairs.forEach( function ( pair ) {

                  var uploadOptionsBase = {
                    builtFilePath: redirectTemplateForDestination( redirectUrlForFile( args.builtFile ) ),
                    bucket: pair.oppositeBucket,
                  }

                  var uploadOptionTrailingSlash = Object.assign( uploadOptionsBase, {
                    builtFile: args.builtFile,
                  } )

                  stream.push( uploadOptionTrailingSlash )

                  if ( args.builtFile !== 'index.html' ) {
                    var uploadOptionNonTrailingSlash = Object.assign( uploadOptionsBase, {
                      builtFile: args.builtFile.replace( '/index.html', '' ),
                    } )
                    
                    stream.push( uploadOptionNonTrailingSlash )
                  }

                  function redirectUrlForFile( file ) {
                    return [ pair.bucket, urlForFile( file ) ].join( '/' )
                  }

                  function urlForFile ( file ) {
                    return file.replace( 'index.html', '' )
                  }

                } )
                next()
              } )
            }

            // slice off or add on a www.
            function oppositeBucketFrom ( bucket ) {
              var www = 'www.'
              return bucket.indexOf( www ) === 0
                ? bucket.slice( www.length )
                : www + bucket
            }

          }

          /**
           * deleteRemoteFilesNotInBuild is a transform stream. First it reads all
           * objects from the bucket. Then compares them to local files.
           * 
           * If it exists as a local file, it nothing is done.
           * If it does not exist as a local file, it is deleted.
           *
           * Local file comparisons include:
           * - Same name
           * - Same name - '/index.html'
           * 
           * @return {object} stream  Transform stream that will handle the work.
           */
          function deleteRemoteFilesNotInBuild () {
            return miss.through.obj( function ( args, enc, next ) {
              
              console.log( 'delete-remote-files-not-in-build:start' )

              var buckets = args.deploys.map( function ( deploy ) { return deploy.bucket; } )

              miss.pipe(
                usingArguments( { builtFolder: args.builtFolder } ),
                feedCloudFiles( { buckets: buckets } ),  // adds { bucket, remoteBuiltFile }
                feedNotLocalFiles(),                     // pushes previous if conditions are met
                deleteFromBucket(),                      // adds { remoteDeleted }
                sink(),
                function onComplete ( error ) {
                  console.log( 'delete-remote-files-not-in-build:end' )
                  if ( error ) return next( error )
                  next( null, args )
                } )
            } )

            // list and feed all files in the buckets
            function feedCloudFiles ( options ) {
              var buckets = options.buckets;
              return miss.through.obj( function ( args, enc, next ) {
                var stream = this;
                
                var listTasks = buckets.map( pushListTask )

                async.parallel( listTasks, function onDone () { next() } )

                function pushListTask ( bucket ) {
                  return function ( taskComplete ) {

                    pushList()

                    function pushList ( pageToken ) {
                      var listOpts = {}
                      if ( pageToken ) listOpts.pageToken = pageToken;
                      cloudStorage.objects.list( bucket, listOpts, function ( error, listResult ) {
                        if ( error ) return taskComplete( error )
                        if ( !listResult.items ) return taskComplete()

                        listResult.items.forEach( function ( remoteFile ) {
                          stream.push( Object.assign( args, {
                            remoteBuiltFile: remoteFile.name,
                            bucket: bucket,
                          } ) )
                        } )

                        if ( listResult.nextPageToken ) return pushList( listResult.nextPageToken )

                        taskComplete()
                      } )
                    }
                  }
                }
              } )
            }

            // compare remote files to local files. if the local file does not exist, push it for deletion.
            function feedNotLocalFiles () {
              return miss.through.obj( function ( args, enc, next ) {
                var localFile = localForRemote( args.remoteBuiltFile )
                var localFilePath = path.join( args.builtFolder, localFile )
                fs.open( localFilePath, 'r', function ( error, fd ) {
                  // file does not exist, lets push the arguments to delete it from the bucket
                  if ( error ) return next( null, args )

                  // file exists locally, lets keep it in the bucket
                  fs.close( fd, function () { next() } )
                } )
              } )

              function localForRemote ( file ) {
                // if no extension, this is a redirect template. lets see if we
                // have the base file that it is redirecting to.
                if ( path.extname( file ) === '' ) file = file + '/index.html';
                return file;
              }
            }

            // deletes the { bucket, remoteBuiltFile }
            function deleteFromBucket () {
              return miss.through.obj( function ( args, enc, next ) {
                cloudStorage.objects.del( args.bucket, args.remoteBuiltFile, function ( error ) {
                  args.remoteDeleted = true;
                  next( null, args );
                } )
              } )
            }
          }

        } else {
          console.log('Site does not exist or no permissions');
          processSiteCallback( null );
        }
      }

      // Run a domain so we can survive any errors
      var domainInstance = domain.create();

      domainInstance.on('error', function(err) { 
        console.log('domain-instance:error');
        console.log(err);
        reportStatus(siteName, 'Failed to build, errors encountered in build process', 1);
        jobCallback();
      });

      domainInstance.run(function() {
        // Check if latest version of site, if not download and unzip latest version
        console.log( 'domain-instance:run:build-folder' )
        console.log( buildFolder )
        console.log( 'domain-instance:run:version' )
        console.log( siteValues.version )
        if(!fs.existsSync(buildFolder + '/.fb_version' + siteValues.version)) {

          console.log('download-zip:start')
          downloadSiteZip(buildFolderRoot, site, branch, function( downloadError, downloadedFile ) {
            if ( downloadError ) throw error;

            console.log('download-zip:done')

            var unzipStuff = function() {
              console.log( 'unzip-stuff:start' )
              mkdirp.sync(buildFolder);

              runInDir('unzip', buildFolder, ['-q', '-o', '../' + downloadedFile], function(err) {
                fs.unlinkSync(buildFolderRoot + '/' + downloadedFile);
                touch.sync(buildFolder + '/.fb_version' + siteValues.version);

                console.log( 'unzip-stuff:done' )
                processSite(buildFolder, jobCallback);
              });
            };
            
            if(fs.existsSync(buildFolder)) {
              runInDir('rm', buildFolder + '/..', ['-rf', buildFolder], function(err) {
                unzipStuff();
              });
            } else {
              unzipStuff();
            }

          })
        } else {
          console.log( 'process without downloading' )
          processSite(buildFolder, jobCallback);
        }
      })


    }, function(err) {
      jobCallback(err);
    });
  }

  return buildJob;

};

/*
* Runs a command in a directory
*
* @param command  Command to run
* @param cwd      Working directory for command
* @param args     Arguments for command, in array form
* @param callback Callback to call when finished
*/
function runInDir(command, cwd, args, callback) {
  if(!fs.existsSync(cwd)) {
    callback({ 'error': 'No directory at ' + cwd });
    return;
  }

  var spawnedCommand = winSpawn(command, args, {
    stdio: 'inherit',
    cwd: cwd
  });

  spawnedCommand.on('close', function(exit, signal) {

    if(exit === 0) {
      callback(null);
    } else {
      callback(exit);
    }

  });
}
