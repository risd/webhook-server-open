'use strict';

// script to test the values of `uploadToBucket`
// with the hope of understanding the way requests
// are made, to support alumni.risd.edu deployment

require('dotenv').config({
  path: __dirname + '/../.env'
});

var fs = require( 'fs' );
var wrench = require( 'wrench' );
var _ = require( 'lodash' );
var cloudStorage = require('./cloudStorage.js');
var crypto = require('crypto');


var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

var siteName = 'edu,1risd,1systems';
var siteValues = {};
var folder = '/Users/rubenrodriguez/' +
  'Documents/commisions/risd_media/self-hosted-webhook/' +
  'sites/edu.risd.systems/.build';
var cloudStorage = require('./cloudStorage.js');

cloudStorage.setProjectName( process.env.GOOGLE_PROJECT_ID );
cloudStorage.setServiceAccount( process.env.GOOGLE_SERVICE_ACCOUNT );

uploadToBucket( siteName, siteValues, folder,
  function onComplete ( results ) {
    if ( 'error' in results ) console.log( results.error );
    if ( 'requests' in results ) console.log( results.requests );
  } )



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

  var requestArguments = [];

  var files = wrench.readdirSyncRecursive(folder);
  var funcs = [];

  var deleteList = {};
  var md5List = {};

  var siteBucket = unescapeSite(siteName);

  // We list the objects in cloud storage to avoid uploading the same thing twice
  cloudStorage.objects.list(siteBucket, function(err, body) {

    if(err) {
      callback( { error: err } );
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
              step();
            });
          });
          requestArguments.push( {
            type: 'upload',
            siteBucket: siteBucket,
            source: source,
            file: file,
          } );

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
                step();
              });
            });

            requestArguments.push( {
              type: 'upload',
              siteBucket: siteBucket,
              source: source,
              file: file.replace('/index.html', ''),
            } );
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
            console.log( 'upload:delete:', file);
            console.log( err );
          }
          step();
        });
      });

      requestArguments.push( {
        type: 'delete',
        siteBucket: siteBucket,
        key: key,
      } );

    });



    // subpublish
    // alumni.risd.systems
    var subpublish = 'alumni';

    console.log( 'subpublishRequestsFrom( files )' )
    console.log( subpublishRequestsFrom( files ) )

    requestArguments = requestArguments.concat(
      subpublishRequestsFrom( files ).map(
        function ( options ) {
          options.type = 'subpublish';
          return options;
        } ),
      sublishDirectoryRequestsFrom( files ).map(
        function ( options ) {
          options.type = 'subpublish:dir-dupe';
          return options;
        } ),
      sublishDeleteRequestsFrom( deleteList ).map(
        function ( options ) {
          options.type = 'subpublish:delete';
          return options;
        } )
    )

    return callback({ requests: requestArguments, error: null });

    if ( siteBucket === '1edu.risd.systems' ) {
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
        // .map( toUploadRequests );
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
          return Object.assign( options, {
            file: options.file.slice( 0, - ( '/index.html'.length ) ),
          } )
        } )
        // .map( toUploadRequests )
    }

    function sublishDeleteRequestsFrom ( filesToDelete ) {
        return Object.keys( deleteList )
          .map( isSubpublish )
          .map( sliceSubpublish )
          .map( fileToDeleteRequestOptions )
          // .map( toDeleteRequests );
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
      return Object.assign( options, {
        file: sliceSubpublish( options.file )
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
            console.log( body )
            step()
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
            console.log( body )
            step()
          } )
      }
    }

    function subpublishDomain () {
      return [ subpublish, 'risd.systems' ].join( '.' )
    }

    // subpublish -- end


    // Run the uploads in parallel
    async.parallelLimit(funcs, 100, function() {
      console.log('upload:complete:');
      cloudStorage.buckets.updateIndex(siteBucket, 'index.html', '404.html', function(err, body) {
        console.log('updated');
        callback();
      });
      
    });

  });

}