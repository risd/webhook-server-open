'use strict';

// Requires
var fs = require('fs');
var url = require( 'url' )
var assert = require( 'assert' )
var Firebase = require('./firebase/index.js');
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

// Util functions
var protocolForDomain = utils.protocolForDomain;
// Util streams
var usingArguments = utils.usingArguments;
var sink = utils.sink;
var uploadIfDifferent = utils.uploadIfDifferent;
var redirectTemplateForDestination = utils.redirectTemplateForDestination;
var cachePurge = utils.cachePurge;
var addMaskDomain = utils.addMaskDomain;

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

  var firebase = Firebase( config().firebase )
  this.root = firebase.database()

  var buildFolderRoot = '../build-folders';
  var setupBucketOptions = {
    cloudStorage: cloudStorage,
    cloudflare: config.get( 'cloudflare' ),
    fastly: config.get( 'fastly' ),
  }


  /**
   *  Reports the status to firebase, used to display messages in the CMS
   *
   *  @param site    The name of the site
   *  @param message The Message to send
   *  @param status  The status code to send (same as command line status codes)
   */
  var reportStatus = function(site, message, status, code) {
    if ( ! code ) code = 'BUILT'
    var messagesRef = self.root.ref('/management/sites/' + site + '/messages/');
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: code }, function() {
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limitToFirst(1).once('child_added', function(snap) {
            messagesRef.child(snap.key).remove();
          });
        }
      });
    });
  }

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
    
    cloudStorage.objects.get(config.get('sitesBucket'), branchFileName, onDownload)

	  return branchFileName.slice( 0, branchFileName.indexOf( '.zip' ) )

    function onDownload ( err, data ) {
      if ( err ) return callback( err )
      console.log( 'download-site-zip:err' )
      console.log( err )

      if(fs.existsSync(buildFolders + '/' + branchFileName )) {
        fs.unlinkSync(buildFolders + '/' + branchFileName);
      }

      fs.writeFileSync(buildFolders + '/' + branchFileName, data);

      callback( null, branchFileName );
    }
  }


  // Initialize ----
  console.log('Waiting for commands'.red);

  // Wait for a build job, extract info from payload
  jobQueue.reserveJob('build', 'build', buildJob);



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
    var siteBucket = data.siteBucket;
    var branch = data.branch;
    var noDelay = data.noDelay || false;

    console.log('Processing Command For '.green + site.red);

    self.root.ref('management/sites/' + site).once('value', function(siteData) {
      var siteValues = siteData.val();

      // If the site does not exist, may be stale build, should no longer happen
      if(!siteValues) {
        jobCallback();
        return;
      }

      // Create build-folders if it isnt there
      mkdirp.sync('../build-folders/');

      var siteName = siteData.key;
      var buildFolderRoot = '../build-folders';
      var buildFolder = buildFolderRoot + '/' + Deploys.utilities.nameForSiteBranch( site, siteBucket );

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
          console.log( 'setup-pipeline' )
          // If build time is defined, we build it now, then put in a job back to beanstalk with a delay
          // to build it later as well.
          var now = Date.now();
          var buildtime = data.build_time ? Date.parse(data.build_time) : now;
          var buildDiff = Math.floor((buildtime - now)/1000);
          
          var maxParallel = config.get( 'builder' ).maxParallel;
          var purgeProxy = config.get( 'fastly' ).ip;

          var pipelineArgs = {
            siteName: siteName,
            siteBucket: siteBucket,
            siteKey: siteValues.key,
            // queueDelayedJob args
            buildJobIdentifier: identifier,
            buildJobData: data,
            buildDiff: buildDiff,
            noDelay: noDelay,
            // buildSite args
            buildFolder: buildFolder,
            builtFolder: path.join( buildFolder, '.build' ),
            maskDomain: undefined,
          }

          miss.pipe(
            usingArguments( pipelineArgs ),
            queueDelayedJob(),
            installDependencies(),
            makeDeployBuckets(),
            addMaskDomain( config.get( 'fastly' ) ),
            buildUploadSite( { maxParallel: maxParallel, purgeProxy: purgeProxy } ),
            deleteRemoteFilesNotInBuild( { maxParallel: maxParallel, purgeProxy: purgeProxy } ),
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
              reportStatus( siteName, 'Built and uploaded to ' + siteBucket + '.', 0 )
            }

            processSiteCallback( error )
          }

          function queueDelayedJob () {
            return miss.through.obj( function ( args, enc, next ) {
              console.log( 'queue-delayed-job' )
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
              console.log( 'install-dependencies' )
              runInDir( 'npm', args.buildFolder, [ 'install', '--production' ], function ( error ) {
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
              var setupBucketTasks = [ args.siteBucket ].map( makeDeployBucketTask )
              async.parallel( setupBucketTasks, function ( error ) {
                if ( error ) {
                  console.log( error )
                  console.log( error.stack )
                  return next( error )
                }
                next( null, args )
              } )
              
            } )

            function makeDeployBucketTask ( siteBucket ) {
              return function makeBucketTask ( makeBucketTaskComplete ) {
                setupBucket( Object.assign( setupBucketOptions, { siteBucket: siteBucket } ), function ( error, bucketSetupResults ) {
                  if ( error ) return makeBucketTaskComplete( error )
                  makeBucketTaskComplete()
                } )
              }
            }
          }

          /**
           * buildUploadSite is a transform stream that expects an object `args` with
           * keys { buildFolder, siteBucket, maskDomain? }.
           *
           * Using the build folder, a build-order is determined, and then executed.
           * As files are written by the build processes, they are passed into a
           * sub-stream that will compare their MD5 hash to the file currently in
           * the bucket at that location. If it is different, the built file is uploaded.
           * 
           * @param  {object} options
           * @param  {number} options.maxParallel?  Max number of build workers to spawn.
           * @param  {number} options.purgeProxy?   The address to use as a proxy when defining the cache PURGE request
           * @return {object} stream                Transform stream that handles the work.
           */
          function buildUploadSite ( options ) {
            if ( !options ) options = {}
            var maxParallel = options.maxParallel || 1;
            var purgeProxy = options.purgeProxy;

            return miss.through.obj( function ( args, enc, next ) {
              console.log( 'build-upload-site:start' )

              reportStatus( args.siteName, 'Build started for ' + args.siteBucket, 0, 'BUILDING' )


              var buckets = [ { contentDomain: args.siteBucket, maskDomain: args.maskDomain } ]
              var buildEmitterOptions = {
                maxParallel: maxParallel,
                errorReportStatus: {
                  site: args.siteName,
                  message: 'Failed to build, errors encountered in build process',
                  status: 1,
                },
              }

              var siteMapOptions = {
                buckets: buckets,
                builtFolder: args.builtFolder,
              };
              var robotsTxtOptions = Object.assign( { buildFolder: args.buildFolder }, siteMapOptions );

              var uploadOptions = {
                maxParallel: maxParallel,
                purgeProxy: options.purgeProxy,
              }
              
              miss.pipe(
                usingArguments( { buildFolder: args.buildFolder, siteBuckets: buckets } ),
                removeBuild(),
                cacheData(),                  // adds { cachedData }
                getBuildOrder(),              // adds { buildOrder }
                feedBuilds(),                 // pushes { buildFolder, command, flags }
                runBuildEmitter( buildEmitterOptions ),  // pushes { builtFile, builtFilePath }
                buildSitemap( siteMapOptions ),          // through stream, writes { builtFile, builtFilePath } on end
                buildRobotsTxt( robotsTxtOptions ),      // through stream, writes { builtFile, builtFilePath } on end
                uploadIfDifferent( uploadOptions ),
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
            // { buildFolder : String, buildOrder: [buildFiles], cachedData : String, siteBuckets: [{ maskDomain, contentDomain }] }
            // for each build order item, push { buildFolder, command, commandArgs, bucket : { maskDomain, contentDomain } }
            function feedBuilds () {
              return miss.through.obj( function ( args, enc, next ) {
                console.log( 'build-upload-site:feed-builds:start' )
                var buildFlagsForFile = buildFlags( args.cachedData )

                var stream = this;
                args.buildOrder
                  .map( makeBuildCommandArguments( args.siteBuckets ) ) // returns array of arrays for each site to build agains
                  .reduce( function concat ( previous, current ) { return previous.concat( current ) }, [] ) // flattens into a single series of arrays to build
                  .concat( [ copyStaticCommandArgs( args.siteBuckets[ 0 ] ) ] )
                  .forEach( function ( buildCommandArgs ) {
                    stream.push( buildCommandArgs )
                  } )

                console.log( 'build-upload-site:feed-builds:end' )

                next()

                function makeBuildCommandArguments ( siteBuckets ) {
                  return function forFile ( buildFile ) {
                    return siteBuckets.map( function ( siteBucket ) {
                      var bucket = siteBucket.maskDomain ? siteBucket.maskDomain : siteBucket.contentDomain
                      return {
                        buildFolder: args.buildFolder,
                        command: 'grunt',
                        commandArgs: buildCommandForFile( buildFile ).concat( buildFlagsForFile( bucket, buildFile ) ),
                        bucket: siteBucket,
                      }
                    } )
                  }
                }

                function copyStaticCommandArgs ( siteBucket ) {
                  return {
                    buildFolder: args.buildFolder,
                    command: 'grunt',
                    commandArgs: [ 'build-static', '--production=true', '--emitter' ],
                    bucket: siteBucket
                  }
                }

              } )

              function buildCommandForFile ( file ) {
                return file.indexOf( 'pages/' ) === 0 ? [ 'build-page' ] : [ 'build-template' ];
              }

              function buildFlags ( cachedData ) {
                return function buildFlagsForFile ( siteBucket, file ) {
                  return [ '--inFile=' + file, '--data=' + cachedData, '--production=true', '--settings={"site_url":"'+ protocolForDomain( siteBucket ) +'"}', '--emitter' ]
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
             * Pushes objects that have shape  { builtFile, builtFilePath, bucket: { contentDomain, maskDomain } }
             *
             * If any of the build emitters produces an error, the stream is closed and the
             * error is propogated up, including the `errorReportStatus` as the
             * `error.reportStatus` value for reporting back to the CMS that the current build
             * did not complete.
             * 
             * @param  {object} options
             * @param  {number} options.maxParallel?         The max number of streams to spawn at once.
             * @param  {object} options.errorReportStatus?   Object to use as the `error.reportStatus` to report the error to the CMS of an incomplete build.
             * @return {object} stream                       Parallel transform stream that handles the work.
             */
            function runBuildEmitter ( options ) {
              if ( !options ) options = {};
              var maxParallel = options.maxParallel || 1;
              var errorReportStatus = options.errorReportStatus || {};

              return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {
                var stream = this;

                var cmdArgs = streamToCommandArgs( args )
                var bucket = args.bucket;
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

                      stream.push( { builtFile: builtFile, builtFilePath: builtFilePath, bucket: bucket } ) 

                      // non trailing slash redirect
                      if ( builtFile.endsWith( '/index.html' ) ) {
                        stream.push( {
                          builtFile: builtFile.replace( '/index.html', '' ),
                          builtFilePath: redirectTemplateForDestination( '/' + builtFile.replace( 'index.html', '' ) ),
                          bucket: bucket,
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
                  error.reportStatus = Object.assign( {}, errorReportStatus );
                  next( error )
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

            /**
             * Collects all { builtFile } values that pass through, and pushes
             * the same object that comes in.
             * 
             * On end, a site map XML file is written and a { builtFile, builtFilePath }
             * object is pushed to present the new file.
             *
             * Site maps are written at {bucket}-sitemap.xml
             * 
             * @param  {object} options
             * @param  {string[]} options.buckets[]
             * @param  {string} options.buckets[].contentDomain  The domains to write the urls for.
             * @param  {string} options.buckets[].maskDomain?    The domains to write the urls for if exists
             * @param  {string} options.builtFolder     The folder to write site maps to.
             * @return {[type]} [description]
             */
            function buildSitemap ( options ) {
              var urls = [];
              var buckets = options.buckets || [];
              var builtFolder = options.builtFolder;

              function includeInSiteMap( file ) {
                return file.endsWith( 'index.html' ) && ( !file.startsWith( '_wh_previews' ) ) && ( !file.startsWith( 'cms/index.html' ) )
              }

              function normalizeForSiteMap( file ) {
                if ( file === 'index.html' ) return '/'
                return file.replace( 'index.html', '' )
              }

              return miss.through.obj( collect, writeOnEnd )

              function collect ( args, enc, next ) {
                if ( includeInSiteMap( args.builtFile ) ) urls.push( normalizeForSiteMap( args.builtFile ) )
                next( null, args )
              }

              function writeOnEnd () {
                var stream = this;
                var siteMapTasks = options.buckets.map( createSiteMapTask )
                async.parallel( siteMapTasks, function ( error, siteMaps ) {
                  if ( error ) return stream.emit( 'error', error );
                  console.log( 'site-maps' )
                  console.log( siteMaps )
                  siteMaps.forEach( function ( siteMap ) { stream.push( siteMap ) } )
                  stream.push( null )
                } )
              }

              function createSiteMapTask ( bucket ) {
                return function siteMapTask ( taskComplete ) {
                  var siteMapDomain = bucket.maskDomain ? bucket.maskDomain : bucket.contentDomain;
                  
                  var siteMapFile = siteMapName( siteMapDomain );
                  var siteMapPath = path.join( builtFolder, siteMapFile )
                  var siteMapContent = siteMapFor( siteMapDomain, urls )
                  fs.writeFile( siteMapPath, siteMapContent, function ( error ) {
                    if ( error ) {
                      console.log( 'site-map:error' )
                      console.log( error )
                      return taskComplete()
                    }
                    var uploadArgs = {
                      builtFile: siteMapFile,
                      builtFilePath: siteMapPath,
                      bucket: bucket,
                    }
                    taskComplete( null, uploadArgs )
                  } )
                }
              }

              function siteMapFor ( host, urls ) {
                var protocolHost = hostWithProtocol( host )
                var openingTag =
                  [ '<?xml version="1.0" encoding="UTF-8"?>',
                    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' ].join( '\n' )
                var urlItems = urls.map( function ( urlLoc ) {
                  return [
                    '\t<url>',
                      '\t\t<loc>' + url.resolve( protocolHost, urlLoc ) + '</loc>',
                    '\t</url>\n',
                  ].join( '\n' )
                } ).join( '' )
                var closingTag = '</urlset>\n'
                return [ openingTag, urlItems, closingTag ].join( '' )
              }
            }

            function siteMapName( host ) {
              return host.replace( /\./g, '-' ) + '-sitemap.xml';
            }

            function hostWithProtocol( host ) {
              var protocol = 'http';
              return [ protocol, host ].join( '://' )
            }

            function buildRobotsTxt ( options ) {
              var buckets = options.buckets || [];
              var buildFolder = options.buildFolder;
              var builtFolder = options.builtFolder;
              var shouldBuild = false;
              var builtFile = 'robots.txt';

              return miss.through.obj( filterRobotsTxt, writeRobotsTxt )

              function filterRobotsTxt ( args, enc, next ) {
                if ( args.builtFile.endsWith( builtFile ) ) {
                  shouldBuild = true;
                  return next()
                }
                next( null, args )
              }

              function writeRobotsTxt () {
                var stream = this;
                if ( shouldBuild === false ) return stream.push( null )
                miss.pipe(
                  feedBuckets(),
                  buildAndRead(),
                  sink( function ( args ) {
                    stream.push( args )
                  } ),
                  function onComplete ( error ) {
                    if ( error ) return stream.emit( 'error', error )
                    stream.push( null )
                  } )
              }

              function feedBuckets () {
                return miss.from.obj( buckets.map( function ( bucket ) { return { bucket: bucket } } ).concat( [ null ] ) )
              }

              function buildAndRead () {
                return miss.through.obj( function ( args, enc, next ) {
                  var robotsDataContent = buildDataForBucket( args.bucket )
                  var robotsDataPath = path.join( builtFolder, 'robots-data.json' )

                  var buildParams = [
                    'build-page',
                    '--inFile=pages/robots.txt',
                    '--production=true',
                    '--data=.build/robots-data.json',
                    '--emitter'
                  ]

                  var builtRobotsPath = path.join( builtFolder, builtFile )


                  fs.writeFile( robotsDataPath, robotsDataContent, function ( error ) {
                    if ( error ) return next( error )

                    runInDir( 'grunt', buildFolder, buildParams, function ( error ) {
                      if ( error ) return next( error )

                      fs.readFile( builtRobotsPath, function ( error, contents ) {
                        if ( error ) return next( error )

                        var uploadArgs = {
                          builtFile: builtFile,
                          builtFilePath: contents.toString(),
                          bucket: args.bucket,
                          overrideMimeType: 'text/plain',
                        }

                        next( null, uploadArgs )
                      } )
                    } )
                  } )
                } )
              }

              function buildDataForBucket ( bucket ) {
                var siteMapDomain = bucket.maskDomain ? bucket.maskDomain : bucket.contentDomain
                var buildData = {
                  contentType: {},
                  data: {},
                  settings: {
                    general: {
                      site_url: siteMapDomain,
                      site_map: url.resolve( hostWithProtocol( siteMapDomain ), siteMapName( siteMapDomain ) )
                    }
                  }
                }
                return JSON.stringify( buildData )
              }
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
           * @param  {object} options
           * @param  {number} options.maxParallel?  Max number of build workers to spawn.
           * @param  {object} options.purgeProxy?    The address to use as a proxy when defining the cache PURGE request
           * @return {object} stream  Transform stream that will handle the work.
           */
          function deleteRemoteFilesNotInBuild ( options ) {
            if ( !options ) options = {};
            var maxParallel = options.maxParallel || 1;
            var purgeProxy = options.purgeProxy;

            return miss.through.obj( function ( args, enc, next ) {
              
              console.log( 'delete-remote-files-not-in-build:start' )

              var buckets = [ { contentDomain: args.siteBucket, maskDomain: args.maskDomain } ]

              miss.pipe(
                usingArguments( { builtFolder: args.builtFolder } ),
                feedCloudFiles( { buckets: buckets } ),            // adds { bucket, builtFile }
                feedNotLocalFiles( { maxParallel: maxParallel } ), // pushes previous if conditions are met
                deleteFromBucket( { maxParallel: maxParallel } ),  // adds { remoteDeleted }
                cachePurge( { purgeProxy: purgeProxy } ),
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
                      cloudStorage.objects.list( bucket.contentDomain, listOpts, function ( error, listResult ) {
                        if ( error ) return taskComplete( error )
                        if ( !listResult.items ) return taskComplete( error )

                        listResult.items.filter( nonStatic ).forEach( function ( remoteFile ) {
                          stream.push( Object.assign( {}, args, {
                            builtFile: remoteFile.name,
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

              function nonStatic ( remoteFile ) {
                return ( ! remoteFile.name.startsWith( 'static/' ) )
              }
            }

            // compare remote files to local files. if the local file does not exist, push it for deletion.
            function feedNotLocalFiles ( options ) {
              if ( !options ) options = {};
              var maxParallel = options.maxParallel || 1;

              return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {
                var localFile = localForRemote( args.builtFile )
                var localFilePath = path.join( args.builtFolder, localFile )
                fs.open( localFilePath, 'r', function ( error, fd ) {
                  // file does not exist, lets see if it exists as named html file
                  // rather than a named directory with an index.html
                  if ( error ) {
                    return fs.open( localNonIndex( localFilePath ), 'r', function ( error, fd ) {
                      // file does not exist, lets push its args and delete it
                      if ( error ) return next( null, args )

                      // file exists locally, lets keep it in the bucket
                      fs.close( fd, function () { next() } )
                    } )
                    
                  }

                  // file exists locally, lets keep it in the bucket
                  fs.close( fd, function () { next() } )
                } )
              } )

              function localForRemote ( file ) {
                // if no extension, this is a redirect template. lets see if we
                // have the base file that it is redirecting to.
                if ( path.extname( file ) === '' ) return file + '/index.html';
                return file;
              }

              function localNonIndex ( file ) {
                return file.slice( 0, ( -1 * '/index.html'.length ) ) + '.html';
              }
            }

            // deletes the { bucket, builtFile }
            function deleteFromBucket ( options ) {
              if ( !options ) options = {};
              var maxParallel = options.maxParallel || 1;

              return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {
                console.log( 'deleting:' + [args.bucket.contentDomain, args.builtFile].join('/') )
                cloudStorage.objects.del( args.bucket.contentDomain, args.builtFile, function ( error ) {
                  args.remoteDeleted = true;
                  next( null, args );
                } )
              } )
            }
          }

        } else {
          var message = 'Site does not exist or no permissions'
          console.log( 'Site does not exist or no permissions' );
          processSiteCallback( new Error( message ) );
        }
      }

      // Run a domain so we can survive any errors
      var domainInstance = domain.create();

      domainInstance.on('error', function(err) { 
        console.log('domain-instance:error');
        console.log(err);
        console.log(err.message);
        console.log(err.stack);
        reportStatus(siteName, 'Failed to build, errors encountered in build process of ' + siteBucket , 1);
        jobCallback();
      });

      domainInstance.run(function() {
        // Check if latest version of site, if not download and unzip latest version
        console.log( 'domain-instance:run:build-folder' )
        console.log( buildFolder )
        console.log( 'domain-instance:run:version' )
        console.log( siteValues.version )
        Error.stackTraceLimit = 100;
        if(!fs.existsSync(buildFolder + '/.fb_version' + siteValues.version)) {

          console.log('download-zip:start')
          downloadSiteZip(buildFolderRoot, site, branch, function( downloadError, downloadedFile ) {
            if ( downloadError ) throw downloadError;

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

function isDeployForBranch ( branch ) {
  return function isDeploy ( deploy ) {
    return branch === deploy.branch
  }
}
