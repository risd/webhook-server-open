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
var path = require( 'path' )
var glob = require( 'glob' )
var zlib = require('zlib');
var setupBucket = require('./creator.js').setupBucket;

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

  /*
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

  /*
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

  /*
  * Uploads site to the sites bucket, tries to not bother uploading things
  * that havent changed.
  *
  * @param siteName   Name of the site
  * @param folder     Folder to upload from
  * @param callback   Callback to call when done
  */
  function uploadToBucket(siteName, folder, callback) {

    if(!fs.existsSync(folder)) {
      var error = new Error( 'No directory at ' + folder );
      return callback( error );
    }

    var files = wrench.readdirSyncRecursive(folder);
    var funcs = [];

    var deleteList = {};
    var md5List = {};

    var siteBucket = unescapeSite(siteName);
    var uploadDeploysResults = { siteBucket: siteBucket, files: [] };

    // We list the objects in cloud storage to avoid uploading the same thing twice
    cloudStorage.objects.list(siteBucket, function(err, body) {

      if(err) {
        callback( err );
      }

      // Get a list of all objects already existing in cloud storage,
      // add its MD5 to a list. Also add it to a potential delete list
      // We will remove objects we upload from teh delete list as we upload them
      // If we dont add them, they've been removed so we need to delete them.
      if(body.items) {
        body.items.forEach(function(item) {
          if(item.name.indexOf('webhook-uploads/') !== 0) {
           deleteList[item.name] = true;
           md5List[item.name] = item.md5Hash;
          }
        });
      }

      // For each file to upload, check to see if the MD5 is the same as the one
      // currently in cloud storage, if so, dont bother uploading it again
      files.forEach(function(file) {
        var source = folder + '/' + file;

        if(!fs.lstatSync(source).isDirectory())
        {
          var ignore = false;
          if ( config.get( 'builder' ).forceWrite === false ) {
            // Check MD5 hash here, if its the same then dont even bother uploading.
            if(md5List[file]) {
              var newHash = crypto.createHash('md5').update(fs.readFileSync(source)).digest('base64');
              if(newHash === md5List[file]) {
                ignore = true; // File is the same, skip it
              }
            }
          }

          if(!ignore) {       

            var cache = 'no-cache';
            if(file.indexOf('static/') === 0) {
             // cache = 'public,max-age=3600';
            }

            // upload function (will upload with gz compression)
            funcs.push( function(step) {
              cloudStorage.objects.uploadCompressed(siteBucket, source, file, cache, function(err, body) {
                if (err) {
                  console.log('upload:func:', file);
                  console.log(err);
                  body = { error: err }
                } else {
                  uploadDeploysResults.files.push( file )
                }
                step( null, body );
              });
            });

            // For everything thats not a static file and is an index.html file
            // upload a redirect template that redirects to the trailing slash version
            // of the page to deal with cloud storage redirect b.s.
            if(file.indexOf('static/') !== 0 && file.indexOf('/index.html') !== -1) {
              funcs.push( function( step ) {
                var template = redirectTemplateForDestination( '/' + file.replace( 'index.html', '' ) )
                cloudStorage.objects.uploadCompressed(siteBucket, template, file.replace('/index.html', ''), cache, 'text/html', function(err, body) {
                  if (err) {
                    console.log('upload:func-dircopy:', file);
                    console.log(err);
                    body = { error: err }
                  }
                  step( null, body );
                });
              });
            }
          }
        }

        // If we had it on the delete list, remove it from the delete list as we've uploaded it
        if(deleteList[file])
        {
          delete deleteList[file];
        }
      });

      // Delete the items left in the delete list. They must be items not in the current build
      _.forOwn(deleteList, function(num, key) {

        funcs.push( function(step) {
          cloudStorage.objects.del(siteBucket, key, function(err, body) {
            if (err) {
              console.log( 'upload:delete:', key);
              console.log( err );
            }
            step( null, body );
          });
        });

      });

      // subpublish
      // alumni.risd.systems
      console.log( 'pre-subpublish:upload-funcs:', funcs.length )
      var subpublish = 'alumni';
      if ( siteBucket === 'edu.risd.systems' ) {
        console.log( 'subpublish:alumni.risd.systems' );

        funcs = funcs.concat(
          // subpublish files to upload functions
          subpublishRequestsFrom( files ),
          // directory dupes
          sublishDirectoryRequestsFrom( files ),
          // delete files
          sublishDeleteRequestsFrom( deleteList )
        )

      }

      console.log( 'post-subpublish:upload-funcs:', funcs.length )
      // subpublish end

      // Run the uploads in parallel
      console.log( 'async funcs' )
      async.parallelLimit(funcs, Math.min(funcs.length, 100), function(asyncError, asyncResults) {
        console.log('upload:complete:');
        console.log('upload:complete:error:', asyncError);
        cloudStorage.buckets.updateIndex(siteBucket, 'index.html', '404.html', function(err, body) {
          console.log('updated');
          callback( null, uploadDeploysResults );
        });
        
      });

      // subpublish-functions:start
      function subpublishRequestsFrom ( filesToPublish ) {
        return filesToPublish
          .filter( isSubpublish )
          .map( toUploadOptions )
          .map( subpublishFileOption )
          .filter( function isNotDirectory ( options ) {
            return !fs.lstatSync( options.source ).isDirectory()
          } )
          .filter( function isFileNew ( options ) {
            if ( ! md5List[ options.file ] ) return true; // not in list
            // see if the file hash exists in the list
            return ( crypto
              .createHash( 'md5' )
              .update( fs.readFileSync( options.source ) )
              .digest( 'base64' )
              === md5List[file] )
          } )
          .map( toUploadRequests );
      }

      function sublishDirectoryRequestsFrom ( filesToPublish ) {
        console.log ( 'sublishDirectoryRequestsFrom' )
        return filesToPublish
          .filter( isSubpublish )
          .filter( function isIndex ( file ) {
            return ( file.indexOf( '/index.html' ) !== -1 ) &&
              ( file !== ( [ subpublish, 'index.html' ].join( '/' ) ) )
          } )
          .map( toUploadOptions )
          .map( subpublishFileOption )
          .map( function sliceIndex ( options ) {
            console.log( 'sliceIndex:file:', options.file )
            return Object.assign( options, {
              file: options.file.slice( 0, - ( '/index.html'.length ) ),
            } )
          } )
          .map( toUploadRequests )
      }

      function sublishDeleteRequestsFrom ( filesToDelete ) {
        console.log ( 'sublishDeleteRequestsFrom' )
        return Object.keys( deleteList )
          .filter( isSubpublish )
          .map( sliceSubpublish )
          .map( fileToDeleteRequestOptions )
          .map( toDeleteRequests );
      }

      function isSubpublish ( file ) {
        return ( file === subpublish ) ||
         ( file.indexOf( ( subpublish + '/' ) ) === 0 )
      }

      function sliceSubpublish ( file ) {
        // if ( file === subpublish ) console.log ( 'index.html' )
        if ( file === subpublish ) return ( 'index.html' )

        // console.log( 'slicePublish:', file.slice( ( subpublish + '/' ).length ) );

        return file.slice( ( subpublish + '/' ).length )
      }

      function toUploadOptions ( file ) {
        return { file: file, source: [ folder, file ].join('/') }
      }

      function subpublishFileOption (options) {
        var subpublishFile = sliceSubpublish( options.file )
        return Object.assign( options, {
          file: ( subpublishFile.length > 0 ) ? subpublishFile : ''
        } )
      } 

      function toUploadRequests ( options ) {
        // console.log( 'subpublish:upload-req:', options.file )
        return function uploadRequest ( step ) {
          cloudStorage.objects.uploadCompressed(
            subpublishDomain(),
            options.source,
            options.file,
            'no-cache', // cache value
            function uploadResponse(err, body) {
              console.log( 'subpublish:upload-res:', options.file )
              if ( err ) {
                console.log( err )
              }
              step( null, body )
            } )
        }
      }

      function fileToDeleteRequestOptions ( file ) {
        return {
          key: file
        }
      }

      function toDeleteRequests ( options ) {
        console.log( 'subpublish:delete-req:', options.key )
        return function deleteRequest  ( step ) {
          cloudStorage.objects.del(
            subpublishDomain(),
            options.key,
            function deleteResponse ( error, body ) {
              console.log( 'subpublish:delete-res:', options.key )
              if ( err ) {
                console.log( error )
              }
              step( null, body )
            } )
        }
      }

      function subpublishDomain () {
        // return [ subpublish, 'risd.systems' ].join( '.' )
        return 'alumni.risd.edu'
      }
      // subpublish-functions:end

    });

  }

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

      // Process the site, this is abstracted into a function so we can wrap it
      // in a Domain to catch exceptions
      /**
       * @param  {object}    opts
       * @param  {string}    opts.buildFolderRoot
       * @param  {string}    opts.branch
       * @param  {Function}  finishedProcessing callback
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
            wwwOrNonRedirects(),
            deleteRemoteFilesNotInBuild(),
            sink(),
            onPipelineComplete)

          // Called at the end of processing the stream above. Or, if the stream
          // emits an error, this is called and the stream is closed.
          function onPipelineComplete ( error ) {
            console.log( 'built-pipeline-complete' )
            if ( error ) {
              if ( typeof error.reportStatus ) {
                reportStatus( error.reportStatus.site, error.reportStatus.message, error.reportStatus.status )
                console.log( error.reportStatus.message );
              }
            }

            processSiteCallback( error )
          }

          // Read stream that passes in initialze arguments
          function usingArguments ( args ) { return miss.from.obj( [ args, null ] ) }          

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
                streamToCommandArgs: function streamToCommandArgs ( streamArgs ) {
                  return [ streamArgs.command, streamArgs.commandArgs, { stdio: 'pipe', cwd: streamArgs.buildFolder } ]
                }
              }
              
              miss.pipe(
                usingArguments( { buildFolder: args.buildFolder } ),
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
          }

          // function buildStaticUpload (){
          //   return miss.through.obj( function ( args, enc, next ) {

          //     console.log( 'build-static-upload:start' )
              
          //     var buckets = args.deploys.map( function ( deploy ) { return deploy.bucket; } )
          //     var buildStaticEmitterOptions = {
          //       maxParallel: 1,
          //       streamToCommandArgs: function streamToCommandArgs ( streamArgs ) {
          //         return [ 'grunt', [ 'build-static', '--emitter' ], { stdio: 'pipe', cwd: streamArgs.buildFolder } ]
          //       }
          //     }
              
          //     miss.pipe(
          //       usingArguments( { buildFolder: args.buildFolder } ),
          //       runBuildEmitter( buildStaticEmitterOptions ),
          //       uploadIfDifferent( { buckets: buckets } ),
          //       sink(),
          //       function onComplete ( error ) {
          //         console.log( 'build-static-upload:end' )
          //         console.log( error )
          //         if ( error ) return next( error )
          //         next( null, args)
          //       } )
          //   } )
          // }

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
           * @param  {number} options.builtFolder          The directory where files are 
           * @param  {number} options.maxParallel?         The max number of streams to spawn at once.
           * @param  {number} options.streamToCommandArgs  Take the incoming arguments, return command arguments for running the build command
           * @return {object} stream                       Parallel transform stream that handles the work.
           */
          function runBuildEmitter ( options ) {

            var maxParallel = options.maxParallel || 1;
            var streamToCommandArgs = options.streamToCommandArgs;

            return miss.parallel( maxParallel, function ( args, next ) {
              var stream = this;

              console.log( 'maxParallel:' + maxParallel )
              var cmdArgs = streamToCommandArgs( args )
              var builtFolder = path.join( cmdArgs[2].cwd, '.build' )

              var errored = false;
              var builder = winSpawn.apply( null, cmdArgs )

              builder.stdout.on( 'data', function readOutput ( buf ) {
                var str = buf.toString()

                var buildEvent = 'build:document-written:./.build/';

                if ( str.indexOf( buildEvent ) === 0 ) {
                  var builtFile = str.trim().slice( buildEvent.length )
                  var builtFilePath = path.join( builtFolder, builtFile )
                  stream.push( { builtFile: builtFile, builtFilePath: builtFilePath } )

                  // non trailing slash redirect
                  if ( builtFile.endsWith( '/index.html' ) ) {
                    stream.push( {
                      builtFile: builtFile.replace( '/index.html', '' ),
                      builtFilePath: redirectTemplateForDestination( '/' + builtFile.replace( 'index.html', '' ) ),
                    } )
                  }
                }

                var endEvent = ':end:';
                if ( str.indexOf( endEvent ) !== -1 ) {
                  builder.kill()
                }

              } )

              builder.on( 'error', function ( error ) {
                console.log( 'builder-error' )
                console.log( error )
                errored = true;
                next()
              } )

              builder.on( 'exit', function () {
                if ( errored === true ) return;
                console.log( 'done:' + JSON.stringify( cmdArgs[1] ) )
                next()
              } )

            } )
          }

          /**
           * uploadIfDifferent is a transform stream that expects objects with:
           * { builtFile, builtFilePath }
           *
           * Pushes { bucket, builtFile, builtFilePath, builtFileMd5, remoteFileMd5, fileUploaded }
           *
           * With this, the stream will
           * - Get the file within the buckets for its metadata.
           * - Create an MD5 hash using the file on the current file system
           * - Compare its MD5 hash against the file coming through the stream
           * - If they are different, upload the new file.
           *
           * `builtFilePath` can be the path to the content, or the content itself.
           * In the case of templates that are never written to the file system.
           * 
           * @param  {object} options
           * @param  {object} options.buckets[]  List of buckets to upload the file to
           * @return {object} stream             Transforms stream that handles the work.
           */
          function uploadIfDifferent ( options ) {
            if ( !options ) options = {};
            var buckets = options.buckets;

            return miss.through.obj( function ( args, enc, next ) {

              var stream = this;

              miss.pipe(
                usingArguments( { builtFile: args.builtFile, builtFilePath: args.builtFilePath } ),
                builtFileMd5(),         // adds builtFileMd5
                feedBuckets( buckets ), // pushes { bucket, builtFile, builtFilePath, builtFileMd5 }
                remoteFileMd5(),        // adds { remoteFileMd5 }
                conditionalUpload(),    // adds { fileUploaded }
                sink(),
                function onComplete ( error ) {
                  if ( error ) return next( error )
                  next( null, args )
                } )
            } )

            function builtFileMd5 () {
              return miss.through.obj( function ( args, enc, next ) {
                var encoding = 'utf8';
                fs.readFile( args.builtFilePath, encoding, function ( error, builtFileContent ) {
                  if ( error ) builtFileContent = args.builtFilePath;
                  if ( typeof builtFileContent === 'object' ) builtFileContent = builtFileContent.toString()

                  zlib.gzip( builtFileContent, function ( error, compressedBuiltFileContent ) {
                    
                    args.builtFileMd5 = crypto.createHash('md5').update(compressedBuiltFileContent, encoding).digest('base64');

                    next( null, args );
                    
                  } )
                } )
              } )
            }

            function feedBuckets ( buckets ) {
              return miss.through.obj( function ( args, enc, next ) {
                var stream = this;

                // One file per bucket
                if ( args.bucket ) {
                  stream.push( args )
                }
                // Same file for multiple buckets?
                if ( buckets ) {
                  buckets.map( function ( bucket ) {
                      return Object.assign( args, { bucket: bucket } )
                    } )
                    .forEach( function ( bucketArgs ) {
                      stream.push( bucketArgs )
                    } )  
                }

                next();
              } )
            }

            function remoteFileMd5 () {
              return miss.through.obj( function ( args, enc, next ) {
                cloudStorage.objects.getMeta( args.bucket, args.builtFile, function ( error, remoteFileMeta ) {
                  if ( error ) args.remoteFileMd5 = false;
                  else args.remoteFileMd5 = remoteFileMeta.md5Hash;
                  next( null, args )
                } )
              } ) 
            }

            function conditionalUpload () {
              return miss.through.obj( function ( args, enc, next ) {
                if ( args.builtFileMd5 === args.remoteFileMd5 ) return next( null, Object.assign( args, { fileUploaded: false } ) )

                var cache = 'no-cache';
                console.log( 'conditional-upload:' + JSON.stringify( args ) )
                cloudStorage.objects.uploadCompressed( args.bucket, args.builtFilePath, args.builtFile, cache, function ( error, uploadResponse ) {
                  if ( error ) {
                    console.log( 'conditional-upload:error' )
                    console.log( error )
                    args.fileUploaded = false;
                  }
                  else {
                    console.log( 'conditional-upload:response:' + path.join( args.bucket, args.builtFile ) )
                    console.log( uploadResponse )
                    args.fileUploaded = true;
                  }
                  next( null, args )
                } )
              } )
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
                    console.log( 'builtFilePath' )
                    console.log( builtFilePath )
                    return {
                      builtFilePath: builtFilePath,
                      builtFile: builtFilePath.slice( builtFolder.length )
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
                      // only write a file if there isn't one that was just built there
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
                  if ( error ) return next( error )
                  console.log( 'www-or-non-redirects:end' )
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
                  var builtFile = builtFilePath.slice( args.builtFolder.length )
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
                  var uploadOptionNonTrailingSlash = Object.assign( uploadOptionsBase, {
                    builtFile: args.builtFile.replace( '/index.html', '' ),
                  } )

                  stream.push( uploadOptionTrailingSlash )
                  stream.push( uploadOptionNonTrailingSlash )

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
              
              var buckets = args.deploys.map( function ( deploy ) { return deploy.bucket; } )

              miss.pipe(
                usingArguments( { builtFolder: args.builtFolder } ),
                feedCloudFiles( { buckets: buckets } ),  // adds { bucket, remoteBuiltFile }
                feedNotLocalFiles(),                     // pushes previous if conditions are met
                deleteFromBucket(),                      // adds { remoteDeleted }
                sink(),
                function onComplete ( error ) {
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

          /**
           * Sink stream. Used as the last step in a stream pipeline as a stream
           * to write to, that doesn't push anything to be read.
           * @param  {Function} fn?     Optional function to call on the current item.
           * @return {object}   stream  Transform stream that handles incoming objects.
           */
          function sink ( fn ) {
            if ( typeof fn !== 'function' ) fn = function noop () {}
            return miss.through.obj( function ( args, enc, next ) {
              fn( args )
              next()
            } )
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

function redirectTemplateForDestination ( destination ) {
  return [
    '<html>',
      '<head>',
        '<meta charset="utf-8" />',
      '</head>',
      '<body>',
        '<script>',
          'window.location="', destination , '";',
        '</script>',
      '</body>',
    '</html>',
  ].join( '' )
}
