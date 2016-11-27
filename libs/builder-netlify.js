'use strict';

// Requires
var fs = require( 'graceful-fs' )
var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var uuid = require('node-uuid');
var winSpawn = require('win-spawn');
var async = require('async');
var mkdirp = require('mkdirp');
var cloudStorage = require('./cloudStorage.js');
var crypto = require('crypto');
var JobQueue = require('./jobQueue.js');
var touch = require('touch');
var domain = require('domain');

var cdn = require ( './cdn-netlify.js' )();

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

module.exports.uploadToBucket = uploadToBucket;
module.exports.prepSubpublish = prepSubpublish;

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
  *
  * @param buildFolders The folder to write the archive to
  * @param site         Name of the site
  * @param callback     Callback to call when downloaded
  */
  var downloadSiteZip = function(buildFolders, site, callback) {
    cloudStorage.objects.get(config.get('sitesBucket'), site + '.zip', function(err, data) {
      if(fs.existsSync(buildFolders + '/' + site + '.zip')) {
        fs.unlinkSync(buildFolders + '/' + site + '.zip');
      }

      fs.writeFileSync(buildFolders + '/' + site + '.zip', data);

      callback();
    });
  }

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    console.log('Waiting for commands'.red);

    // Wait for a build job, extract info from payload
    jobQueue.reserveJob('build', 'build', function(payload, identifier, data, client, callback) {
      var userid = data.userid;
      var site = data.sitename;
      var noDelay = data.noDelay || false;

      console.log('Processing Command For '.green + site.red);

      self.root.root().child('management/sites/' + site).once('value', function(siteData) {
        var siteValues = siteData.val();

        // If the site does not exist, may be stale build, should no longer happen
        if(!siteValues) {
          callback();
          return;
        }

        // Create build-folders if it isnt there
        mkdirp.sync('../build-folders/');

        var siteName = siteData.name();
        var buildFolder = '../build-folders/' + siteName;

        // Process the site, this is abstracted into a function so we can wrap it
        // in a Domain to catch exceptions
        function processSite(buildFolder) { 
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
                callback();
              } else {

                // If there was a delay, push it back into beanstalk, then upload to the bucket
                if(buildDiff > 0 && !noDelay) {
                  var diff = data.build_time - now;

                  data['noDelay'] = true;

                  client.put(1, buildDiff, (60 * 3), JSON.stringify({ identifier: identifier, payload: data }), function() {
                    uploadToBucket(siteName, siteValues, buildFolder + '/.build', function() {
                      reportStatus(siteName, 'Built and uploaded.', 0);
                      console.log('done');
                      callback();
                    });
                  });
                } else {
                  // No delay, upload right away
                  uploadToBucket(siteName, siteValues, buildFolder + '/.build', function() {
                    reportStatus(siteName, 'Built and uploaded.', 0);
                    console.log('done');
                    callback();
                  });
                }
              }
            });
          } else {
            console.log('Site does not exist or no permissions');
            callback();
          }
        }

        // Run a domain so we can survive any errors
        var domainInstance = domain.create();

        domainInstance.on('error', function(err) { 
          console.log(err);
          reportStatus(siteName, 'Failed to build, errors encountered in build process', 1);
          callback();
        });

        domainInstance.run(function() {
          // Check if latest version of site, if not download and unzip latest version
          if(!fs.existsSync(buildFolder + '/.fb_version' + siteValues.version)) {

            console.log('Downloading zip');
            downloadSiteZip('../build-folders' , siteName, function() {

              var unzipStuff = function() {
                mkdirp.sync(buildFolder);

                runInDir('unzip', buildFolder, ['-q', '../' + site + '.zip'], function(err) {
                  fs.unlinkSync('../build-folders/' + site + '.zip');
                  touch.sync(buildFolder + '/.fb_version' + siteValues.version);

                  processSite(buildFolder);
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
            processSite(buildFolder);
          }
        })


      }, function(err) {
        callback();
      });
    });

  });

};

/*
* Uploads site to the sites bucket, tries to not bother uploading things
* that havent changed.
*
* @param siteName   Name of the site
* @param siteValues Values for the site object in firebase
* @param folder     Folder to upload from
* @param callback   Callback to call when done
*/
function uploadToBucket(siteName, siteValues, folder, callback) {

  if(!fs.existsSync(folder)) {
    callback({ error: 'No directory at ' + folder});
    return;
  }

  // -- sans subpublish
  // return cdn.deploy( unescapeSite( siteName ), folder, callback)
  // -- subpublish
  return cdn.createAndDeploy( unescapeSite( siteName ), folder,
    function subpublish ( deploy ) {
      if ( unescapeSite( siteName ) === 'edu.risd.systems' ) {
        console.log( 'subpublish:alumni.risd.systems' );
        prepSubpublish( 'alumni', folder, function ( error, subpublishDirectory ) {
          if ( error ) return callback( { error: error } )
          return cdn.createAndDeploy( 'alumni.risd.systems',
            subpublishDirectory,
            callback )
        } )
      }
      else {
        callback( deploy )
      }
    } )
}

// ( subdirectory<string>, directory<string> ) => subpublishDirectory<string>
function prepSubpublish ( subdirectory, directory, callback ) {
  // get files
  var glob = require( 'glob' )
  var miss = require( 'mississippi' )
  var updateLinks = subpublishLinks( subdirectory )

  glob( [ directory, subdirectory, "**/*" ].join( '/' ),
    function (err, files) {
      // read files, update contents, write file
      miss.pipe(
        miss.from.obj( files.concat( [ null ] ) ),
        miss.through.obj( function read ( file, enc, next ) {
          file = file.toString()
          try {
            fs.readFile( file.toString(), function readComplete ( err, contents ) {
              if ( err ) {
                console.log( err )
                next();
              }
              else {
                console.log( 'no-err:', file )
                next( null, { file: file, contents: contents } )
              }
            } ) 
          }
          catch ( error ) {
            next();
          }
        } ),
        miss.through.obj( function transform ( document, enc, next ) {
          console.log( 'transform:', document )
          next(null,
            Object.assign( document,
              { contents: updateLinks( document.contents ) } ) )
        } ),
        miss.through.obj( function sink ( document, enc, next ) {
          console.log( 'writing:', document.file )
          fs.writeFile( document.file, document.contents,
            function writeComplete ( err ) {
              if ( err ) {
                console.log( err )
              }
              next()
            } )
        } ),
        function pipeComplete ( pipeError ) {
          if ( pipeError ) return callback( pipeError, undefined )
          callback( null, [ directory, subdirectory ].join( '/' ) )
        } )
      
    } )

  function subpublishLinks ( subpublish ) {
    return function ( buffer ) {
      var cheerio = require( 'cheerio' );
      var $ = cheerio.load( buffer.toString() );

      $( 'a[href*="/' + subpublish +  '/"]' )
        .map( function ( index, element ) {
          var originalLink = $( element ).attr( 'href' );
          var subpublishLink = originalLink
            .split( '/' + subpublish + '/' )
            .join('/')

          $( element ).attr( 'href', subpublishLink )

          return element;
        } )

      return new Buffer( $.html() );
    }
  }

}
// subpublish -- end

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