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

          var pipelineArgs = {
            siteName: siteName,
            siteKey: siteValues.key,
            // buildSite args
            buildFolder: buildFolder,
            // queueDelayedJob args
            buildJobIdentifier: identifier,
            buildJobData: data,
            buildDiff: buildDiff,
            noDelay: noDelay,
            // uploadDeploys args
            staticBuiltFolder: buildFolder + '/.build',
            deploys: deploys,
            branch: branch,
            // wwwOrNonRedirects args, comes from upload Deploys
            deployedFiles: [],
          }

          miss.pipe(
            usingArguments( pipelineArgs ),
            installDependencies(),
            buildSite(),
            addStaticRedirects(),
            queueDelayedJob(),
            uploadDeploys(),
            wwwOrNonRedirects(),
            sink(),
            onPipelineComplete)

          function onPipelineComplete ( error ) {
            if ( error ) {
              if ( typeof error.reportStatus ) {
                reportStatus( error.reportStatus.site, error.reportStatus.message, error.reportStatus.status )
                console.log( error.reportStatus.message );
              }
            }

            processSiteCallback( error )
          }

          function usingArguments ( args ) {
            return miss.from.obj( [ args, null ] )
          }

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

          function buildSite () {
            return miss.through.obj( function ( args, enc, next ) {
              runInDir( 'grunt', args.buildFolder, [ 'build', '--strict=true' ], function ( error ) {
                if ( error ) {
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

          function addStaticRedirects () {
            return miss.through.obj( function ( args, enc, next ) {
              console.log( 'add-redirects:start' )

              self.root.child( args.siteName ).child( args.siteKey ).child( 'dev/settings/redirect' )
                .once( 'value', withRedirects, withoutRedirects )

              function withRedirects ( snapshot ) {
                var redirectsObject = snapshot.val();
                var redirects = []

                try {
                  Object.keys( redirectsObject ).forEach( function ( key ) {
                    redirects.push( redirectsObject[ key ] )
                  } )
                } catch ( error ) {
                  console.log( 'add-redirects:end:none-found' )
                  return next( null, args )
                }

                if ( redirects.length === 0 ) return next( null, args )

                var redirectTasks = redirects.map( createRedirectTask )

                async.parallel( redirectTasks, function () {
                  console.log( 'add-redirects:done' )
                  next( null, args )
                } )
              }

              function withoutRedirects () {
                console.log( 'add-redirects:done:none-found' )
                next( null, args )
              }

              function createRedirectTask ( redirect ) {
                var source = sourceFromPattern( redirect.pattern )
                var redirectFiles = [
                  [ args.staticBuiltFolder, source, 'index.html' ].join( '/' ),
                ]

                var writeRedirectTasks = redirectFiles.map( createWriteRedirectTask( redirect.destination ) )

                return function redirectTask ( taskComplete ) {
                  async.parallel( writeRedirectTasks, function ( error ) {
                    taskComplete();
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
                            writeTaskComplete()
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

          function uploadDeploys () {
            return miss.through.obj( function ( args, enc, next ) {

              console.log( 'upload-deploys:start' )
              console.log( args.deploys )

              var doneDeploying = function ( error, deployedFiles ) {
                // reportStatus is called per bucket, so no need
                // to call it out for the total task.
                if ( error ) {
                  console.log( 'upload-deploys:done:error' )
                  console.log( error )
                }
                else console.log( 'upload-deploys:done' )
                args.deployedFiles = deployedFiles;
                next( null, args );
              }

              var deployTasks = args.deploys
                .filter( function isDeployForBranch ( deploy ) { return args.branch === deploy.branch } )
                .map( function makeUploadTask ( environment ) {
                  return function uploadTask ( uploadTaskComplete ) {
                    
                    var uploadDone = function ( error, uploadDeploysResults ) {
                      if ( error ) reportStatus(args.siteName, 'Built but failed to uploaded to ' + environment.bucket + '.', 1);  
                      else reportStatus(args.siteName, 'Built and uploaded to ' + environment.bucket + '.', 0);

                      console.log( 'upload-deploys:done:' + environment.bucket )
                      
                      uploadTaskComplete( null, uploadDeploysResults )
                    }

                    console.log( 'deploy task for ' + JSON.stringify( environment ) )

                    setupBucket( Object.assign( setupBucketOptions, { siteBucket: environment.bucket } ), function ( error, bucketSetupResults ) {
                      if ( error ) return uploadDone( error )
                      uploadToBucket( environment.bucket, args.staticBuiltFolder, uploadDone )
                    } )
                  }
                } )

              console.log( 'running deploys: ' + deployTasks.length )
              if ( deployTasks.length === 0 ) return doneDeploying( null );

              async.parallel( deployTasks, doneDeploying );

            } )
          }

          function wwwOrNonRedirects () {
            return miss.through.obj( function ( args, enc, next ) {

              console.log( 'www-or-non-redirects:start' )

              var ensureRedirectBucketTasks = args.deployedFiles.map( setupRedirectBucketTasks )
              var publishRedirectTasks = args.deployedFiles
                .map( createPublishRedirectBucketTasks )
                .reduce( function flattenTasks ( previous, current ) { return previous.concat( current ) }, [] )

              async.parallelLimit( ensureRedirectBucketTasks, 10, onBucketSetup )

              function onBucketSetup ( error ) {
                async.parallelLimit( publishRedirectTasks, 100, onRedirectsPublished )
              }

              function onRedirectsPublished ( error ) {
                console.log( 'www-or-non-redirects:end' )
                next( null, args )
              }

            } )

            function setupRedirectBucketTasks ( deployedFiles ) {
              var oppositeBucket = oppositeBucketFrom( deployedFiles.siteBucket )
              return function setupRedirectBucketTask ( setupStep ) {
                setupBucket( Object.assign( setupBucketOptions, { siteBucket: oppositeBucket, ensureCname: false } ), function ( error, bucketSetupResults ) {
                  if ( error ) {
                    console.log( 'redirect-bucket-setup:', oppositeBucket );
                    console.log( error );
                    bucketSetupResults = { error: error };
                  }
                  return setupStep( null, bucketSetupResults )
                } )
              }
            }

            function createPublishRedirectBucketTasks ( deployedFiles ) {
              var oppositeBucket = oppositeBucketFrom( deployedFiles.siteBucket )
              var redirectBucketArgs = {
                publishToBucket: oppositeBucket,
                redirectToBucket: deployedFiles.siteBucket,
              }

              return deployedFiles.files.filter( isHtmlFile ).map( redirectBucketTasksForArgs( redirectBucketArgs ) )
            }

            function redirectBucketTasksForArgs ( args ) {
              var publishToBucket = args.publishToBucket;
              var redirectToBucket = args.redirectToBucket;
              var cache = 'no-cache';
              return function redirectBucketTaskForFile ( file ) {
                var template = redirectTemplateForDestination( redirectUrlForFile( file ) )
                return function redirectBucketTask ( redirectStep ) {
                  cloudStorage.objects.uploadCompressed( publishToBucket, template, file, cache, 'text/html', function ( error, body ) {
                    if ( error ) {
                      console.log( 'redirect-bucket-upload:', file );
                      console.log( error );
                      body = { error: error }
                    }
                    redirectStep( null, body );
                  } )
                }
              }

              function redirectUrlForFile( file ) {
                return [ redirectToBucket, urlForFile( file ) ].join( '/' )
              }

              function urlForFile ( file ) {
                return file.replace( 'index.html', '' )
              }
            }

            // slice off or add on a www.
            function oppositeBucketFrom ( bucket ) {
              var www = 'www.'
              return bucket.indexOf( www ) === 0
                ? bucket.slice( www.length )
                : www + bucket
            }

            // isHtmlFile: true if file is not in static directory, and is index.html
            function isHtmlFile ( file ) {
              return file.indexOf('static/') !== 0 && file.indexOf('/index.html') !== -1
            }

          }

          function sink () {
            return miss.through.obj( function ( args, enc, next ) {
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
