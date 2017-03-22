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
var Deploys = require( 'webhook-deploy-configuration' )
var SetupBucketWithCloudStorage = require('./creator.js').setupBucketWithCloudStorage;

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
  var deploys = Deploys( this.root );
  var setupBucket = SetupBucketWithCloudStorage( cloudStorage );

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
    jobQueue.reserveJob('build', 'build', function(payload, identifier, data, client, jobCallback) {
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
        var buildFolder = buildFolderRoot + '/' + [ site, branch ].join( '_' );

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

            // Build the site, strict will cause death if any error is thrown
            runInDir('grunt', buildFolder , ['build', '--strict=true'], function(err) {
              if(err) {
                // Dont upload failed builds, simply send error to CMS
                reportStatus(siteName, 'Failed to build, errors encountered in build process', 1);
                console.log('done with errors');
                processSiteCallback( err );
              } else {

              	var uploadDeploys = function usingConfiguration ( configuration ) {
              		console.log( 'upload-deploys:start' )
              		console.log( configuration.deploys )

              		// assumes: siteValues &  buildFolder + '/.build'
              		var doneDeploying = function () {
              			reportStatus(siteName, 'Built and uploaded.', 0);
                    console.log( 'upload-deploys:done' )
                    processSiteCallback();
              		}

                  var deployTasks = configuration.deploys
                  	.filter( function isDeployForBranch ( deploy ) { return branch === deploy.branch } )
	                  .map( function makeUploadTask ( environment ) {
	                    return function uploadTask ( uploadTaskComplete ) {
	                      
	                      var uploadDone = function () {
	                        console.log( 'upload-deploys:done:' + environment.bucket )
	                        uploadTaskComplete()
	                      }

	                      console.log( 'deploy task for ' + JSON.stringify( environment ) )
	                      return uploadDone()

	                      setupBucket( environment.bucket, function ( error ) {
	                        if ( error ) uploadDone( error )
	                        else {
	                          uploadToBucket( environment.bucket,
	                            buildFolder + '/.build',
	                            uploadDone )
	                        }
	                      } )
	                    }
	                  } )

                  async.parallel( deployTasks, doneDeploying );

              	}

                // If there was a delay, push it back into beanstalk, then upload to the bucket
                if(buildDiff > 0 && !noDelay) {
                  var diff = data.build_time - now;

                  data['noDelay'] = true;

                  client.put(1, buildDiff, (60 * 3), JSON.stringify({ identifier: identifier, payload: data }), function() {
                    // uploadToBucket(siteName, buildFolder + '/.build', function() {
                    //   reportStatus(siteName, 'Built and uploaded.', 0);
                    //   console.log('done');
                    //   processSiteCallback();
                    // });
                    // Get deploy configuration, if none is there, a default is supplied
				            deploys.get( { siteName: siteName }, function ( error, deployConfiguration ) {
				            	uploadDeploys( deployConfiguration )
				            } )
                  });
                } else {
                  // No delay, upload right away
                  // uploadToBucket(siteName, buildFolder + '/.build', function() {
                  //   reportStatus(siteName, 'Built and uploaded.', 0);
                  //   console.log('done');
                  //   processSiteCallback();
                  // });
                  deploys.get( { siteName: siteName }, function ( error, deployConfiguration ) {
			            	uploadDeploys( deployConfiguration )
			            } )
                }
              }
            });
          } else {
            console.log('Site does not exist or no permissions');
            processSiteCallback();
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

                runInDir('unzip', buildFolder, ['-q', '../' + downloadedFile], function(err) {
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
    });

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
          // Check MD5 hash here, if its the same then dont even bother uploading.
          if(md5List[file]) {
            var newHash = crypto.createHash('md5').update(fs.readFileSync(source)).digest('base64');
            if(newHash === md5List[file]) {
              ignore = true; // File is the same, skip it
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
                }
                step( null, body );
              });
            });

            // For everything thats not a static file and is an index.html file
            // upload a copy to the / file (/page/index.html goes to /page/) to deal
            // with cloud storage redirect b.s.
            if(file.indexOf('static/') !== 0 && file.indexOf('/index.html') !== -1) {
              funcs.push( function(step) {
                cloudStorage.objects.uploadCompressed(siteBucket, source, file.replace('/index.html', ''), cache, 'text/html', function(err, body) {
                  if (err) {
                    console.log('upload:func-dircopy:', file);
                    console.log(err);
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

      // subpublish -- end


      // Run the uploads in parallel
      console.log( 'async funcs' )
      async.parallelLimit(funcs, Math.min(funcs.length, 100), function(asyncError, asyncResults) {
        console.log('upload:complete:');
        console.log('upload:complete:error:', asyncError);
        cloudStorage.buckets.updateIndex(siteBucket, 'index.html', '404.html', function(err, body) {
          console.log('updated');
          callback();
        });
        
      });

    });

  }

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
