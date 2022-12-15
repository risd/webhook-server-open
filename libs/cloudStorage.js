'use strict';

/**
* This is the main API used for interacting with Google Cloud Storage. It is used to manipulate
* the buckets and objects for the sites we host.
*/

var request = require('request');
var GAPI = require('gapitoken');
var mime = require('mime');
var fs   = require('fs');
var zlib = require('zlib');
var async = require('async');

var oauthToken = '';
var projectName = process.env.GOOGLE_PROJECT_ID || '';
var googleServiceAccount = process.env.GOOGLE_SERVICE_ACCOUNT || '';

// Contains google service accounts SSH key
var keyFile = process.env.GOOGLE_KEY_FILE || 'libs/keyfile.key';

/* 
* Refreshes the token used to access google cloud storage
*
* @param callback Callback to call when refreshed
*/
var refreshToken = function(callback) {
  var gapi = new GAPI({
      iss: googleServiceAccount,
      scope: 'https://www.googleapis.com/auth/devstorage.full_control https://www.googleapis.com/auth/siteverification',
      keyFile: keyFile,
  }, function(err) {
     if (err) { console.log(err); process.exit(1); }

     gapi.getToken(function(err, token) {
        if (err) { return console.log(err); }
        oauthToken = token;

        callback(err, token);
     });     
  });
};

/*
* Run a json request against google cloud stoage, handles getting token
*
* @param options  Object of options to pass to the json request, mostly same options passed to request module
* @param callback Callback to call when finished
*/
function jsonRequest(options, callback)  {

  if(!options.qs)
  {
    options.qs = {};
  }

  options.qs.access_token = oauthToken;

  var multiData = [];

  if(options.multipart)
  {
    var index = 0;
    options.multipart.forEach(function(multi) {
      multiData.push({ index: index, body: multi.body});
      index = index + 1;
    });
  }
  
  var reqOptions = {
    url: options.url,
    qs: options.qs || null,
    method: options.method,
    json: options.multipart ? null : (options.data || true),
    headers: options.headers || null,
    multipart: options.multipart || null,
  };

  if(options.binary) {
    reqOptions['encoding'] = null;
  }

  // If the request wants to have a stream back ignore token, the caller is
  // responsible for making sure a token is active
  if(options.stream) {
    return request(reqOptions);
  } else {
    request(reqOptions, 
    function(err, res, body){
      if(err) {
        callback(err, null);
      } else if (!res) {
        callback(500, null);
      } else if(res.statusCode/100 === 2) {
        callback(null, body);
      } else if(res.statusCode === 401) {
        refreshToken(function( error ) {
          if ( error ) return callback( error )
          if(options.multipart)
          {
            multiData.forEach(function(item) {
              options.multipart[item.index].body = item.body;
            });
          }

          jsonRequest(options, callback);
        });
      } else {
        callback(res.statusCode, null);
      }
   });
  }
}

// Sets the google project name we authenticate against
module.exports.setProjectName = function(project) {
  projectName = project;
}

// Sets the google service account email with authenticate with
module.exports.setServiceAccount = function(account) {
  googleServiceAccount = account;
}

module.exports.configure = function ({ projectId, serviceAccount }) {
  projectName = projectId
  googleServiceAccount = serviceAccount
}

// Manually get token, used when wanting a stream back, caller is
// responsible for making sure token is valid
module.exports.getToken = function(callback) {
  refreshToken(callback);
};

// Init, manually refreshes the token before we do any requests
// just to get things started
module.exports.init = function(callback) {
  refreshToken(callback);
}

// Sets the key file file, not curretly used
module.exports.setKeyFile = function(file) {
  keyFile = file;
}

// This object contains all methods that have to do with manipulating
// buckets
var cors = [{
  origin: [ "*.risd.systems", "cdn.risd.systems", "risd.edu", "*.risd.edu", "localhost" ],
  responseHeader: [ "Content-Type" ],
  method: [ "GET", "HEAD", "OPTIONS" ],
  maxAgeSeconds: 3600
}]

var bucketsAPI = {
  // Get a bucket's meta data from google cloud storage
  get: function(bucketName, callback) {

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName,
      method: 'GET'
    }, callback);
  },

  // List all buckets in the project
  list: function(callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b',
      qs: {
        'project' : projectName
      },
      method: 'GET',
    }, callback)
  },

  // Create a new bucket, makes the bucket a website hosting bucket
  create: function(bucketName, callback) {

    var data = {
      name: bucketName,
      website: {
        mainPageSuffix: 'index.html',
        notFoundPage: '404.html'
      },
      cors: cors
    };

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/',
      qs: { project: projectName },
      data: data,
      method: 'POST'
    }, callback);
  },

  // Changes the ACLs on the bucket to allow the service account write access
  // and allow the public read access
  updateAcls: function(bucketName, callback) {
    var data = {
      entity: 'allUsers',
      role: 'READER'
    };

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName + '/defaultObjectAcl',
      data: data,
      method: 'POST',
    }, function() {

      data = {
        entity: 'user-' + projectName + '@appspot.gserviceaccount.com',
        role:   'OWNER',
      }

      jsonRequest({
        url: 'https://www.googleapis.com/storage/v1/b/' + bucketName + '/defaultObjectAcl',
        data: data,
        method: 'POST',
      }, callback);

    });
  },

  // Updates the website index on the bucket, used on create
  updateIndex: function(bucketName, indexFile, notFoundFile, callback) {

    var data = {
      website: {
        mainPageSuffix: indexFile,
        notFoundPage: notFoundFile
      },
      cors: cors,
    };

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName,
      data: data,
      method: 'PATCH'
    }, callback);
  },

  // Deletes an empty bucket from cloud storage
  del: function(bucketName, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName,
      method: 'DELETE'
    }, callback);
  }
};
module.exports.buckets = bucketsAPI;
module.exports.bucketsPromises = {
  get: function (bucketName) {
    return new Promise((resolve, reject) => { 
      bucketsAPI.get(bucketName, (error, body) => {
        if (error) reject(error)
        else resolve(body)
      });
    })
  },
  create: function (bucketName) {
    return new Promise((resolve, reject) => {
      bucketsAPI.create(bucketName, (error, body) => {
        if (error) reject(error)
        else resolve(body)
      })
    })
  },
  updateAcls: function (bucketName) {
    return new Promise((resolve, reject) => {
      bucketsAPI.updateAcls(bucketName, (error, body) => {
        if (error) reject(error)
        else resolve(body)
      })
    })
  },
  updateIndex: function (bucketName, indexFile, notFoundFile) {
    return new Promise((resolve, reject) => {
      bucketsAPI.updateIndex(bucketName, indexFile, notFoundFile, (error, body) => {
        if (error) reject(error)
        else resolve(body)
      })
    })
  },
}

// A collection of all functions related to manipulating objects in cloud storage

var objectsAPI = { 

  // List all objects in a bucket (name, md5hash)
  list: function(bucket, options, callback) {
    if ( typeof options === 'function' ) callback = options;
    if ( !options ) options = {};

    var qs = Object.assign( {
      fields: 'kind,items(name,md5Hash),nextPageToken',
      delimiter: 'webhook-uploads/',
    }, options )

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o',
      qs: qs,
    }, callback);
  },

  listAll: function (bucket, options, callback) {
    if ( typeof options === 'function' ) callback = options;
    if ( !options ) options = {};

    var completeList = []

    var qs = Object.assign( {
      fields: 'kind,items(name,md5Hash),nextPageToken',
      delimiter: '',
    }, options )

    objectsAPI.list( bucket, qs, handleList )

    function handleList ( error, results ) {
      if ( error && error !== 404 ) return callback( error )

      if ( results && results.items && Array.isArray( results.items ) ) {
        completeList = completeList.concat( results.items )  
      }

      if ( results && results.nextPageToken ) {
        var nextOptions = Object.assign( qs, {
          pageToken: results.nextPageToken,
        } )
        return objectsAPI.list( bucket, nextOptions, handleList )
      }

      callback( null, completeList )
    }

  },

  // list webhook-uploads
  listUploads: function(bucket, options, callback) {
    if ( typeof options === 'function' ) callback = options;
    if ( !options ) options = {};
    
    var qs = Object.assign( {
      fields: 'kind,items(name,md5Hash),nextPageToken',
      prefix: 'webhook-uploads/',
    }, options )
    
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o',
      qs: qs
    }, callback);
  },

  // List all objects with more information (md5hash, updated time)
  listMore: function(bucket, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o',
      qs: { fields: 'kind,items(name,md5Hash,updated)', delimiter: 'webhook-uploads/' }
    }, callback);
  },

  // Copy an object
  copy: function ( sourceBucket, sourceFile, destinationBucket, destinationFile, callback ) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + sourceBucket + '/o/' + sourceFile + '/copyTo/b/' + destinationBucket + '/o/' + destinationFile,
      method: 'POST',
    }, callback)
  },

  // Rewrite an object
  rewrite: function ( sourceBucket, sourceFile, destinationBucket, destinationFile, callback ) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + sourceBucket + '/o/' + sourceFile + '/rewriteTo/b/' + destinationBucket + '/o/' + destinationFile,
      method: 'POST',
    }, callback)
  },

  // Get an object from a bucket, return stream for caller to manipulate
  getStream: function(bucket, file) {
    return jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + file,
      qs: { alt: 'media' },
      binary: true,
      stream: true
    });
  },

  // Get an object from a bucket
  get: function(bucket, file, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + file,
      qs: { alt: 'media' },
      binary: true
    }, callback);
  },

  // Get an objects metadata
  getMeta: function ( bucket, file, callback ) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + encodeURIComponent(file),
    }, callback);
  },

  /*
  * Upload file to bucket
  *
  * @param bucket           Bucket to upload to
  * @param local            Local file name
  * @param remote           Remote file name
  * @param cacheControl     Cache control header to put on object (optional)
  * @param overrideMimeType Mime type to use instead of auto detecting (optional)
  * @param callback         Callback with object
  *
  */
  upload: function(bucket, local, remote, cacheControl, overrideMimeType, callback) {
    if(typeof cacheControl === 'function') {
      callback = cacheControl;
      cacheControl = null;
      overrideMimeType = null;
    }

    if(typeof overrideMimeType === 'function') {
      callback = overrideMimeType;
      overrideMimeType = null;
    }

    jsonRequest({
      url: 'https://www.googleapis.com/upload/storage/v1/b/' + bucket + '/o',
      qs: { uploadType: 'multipart' },
      headers: {
        'content-type' : 'multipart/form-data'
      },
      method: 'POST',
      multipart: [{
          'Content-Type' : 'application/json; charset=UTF-8',
          body: JSON.stringify({
            name: remote,
            cacheControl: cacheControl ? cacheControl : "max-age=0"
          })                  
      },{ 
          'Content-Type' : overrideMimeType ? overrideMimeType : mime.lookup(local),
          body: readFile(local)
      }]
    }, function handleUpload ( error, results ) {
        if ( error ) return callback( error )
        if ( typeof results === 'string' ) {
          try {
            results = JSON.parse( results )
          } catch ( e ) {
            console.log( 'results not json' )
          }
        }
        return callback( null, results )
      } );

    function readFile ( filePath ) {
      try {
        var content = fs.readFileSync( filePath )
        return content
      }
      catch ( error ) {
        // file does not exist, pass the filePath as the content
        return filePath
      }
    }
  },

  /*
  * Upload file to bucket with gz compression
  *
  * @param options
  * @param options.bucket            Bucket to upload to
  * @param options.local             Local file name, or contents of file
  * @param options.remote            Remote file name
  * @param options.cacheControl      Cache control header to put on object (optional)
  * @param options.overrideMimeType  Mime type to use instead of auto detecting (optional)
  * @param callback         Callback with object
  *
  */
  uploadCompressed: function( options, callback ) {

    var bucket = options.bucket;
    var local = options.local;
    var remote = options.remote;
    var cacheControl = options.cacheControl;
    var overrideMimeType = options.overrideMimeType;
    var compressed = options.compressed;

    if ( compressed ) return doUpload( compressed, callback )
    else {
      withCompressedContent( local, function ( error, compressedContent ) {
        doUpload( compressedContent, callback )
      } )
    }

    function withCompressedContent( local, next ) {
      fs.readFile( local, function ( error, fileContent ) {
        if ( error ) fileContent = local; // was not a file, but a string of the file

        zlib.gzip( fileContent, function( error, compressedContent ) {
          next( null, compressedContent )
        } );
      } )
    }

    function doUpload ( compressedContent, next ) {
      jsonRequest({
        url: 'https://www.googleapis.com/upload/storage/v1/b/' + bucket + '/o',
        qs: { uploadType: 'multipart' },
        headers: {
          'content-type' : 'multipart/form-data'
        },
        method: 'POST',
        multipart: [{
            'Content-Type' : 'application/json; charset=UTF-8',
            body: JSON.stringify({
              name: remote,
              cacheControl: cacheControl ? cacheControl : "max-age=0",
              contentEncoding: 'gzip',
            })                  
        },{ 
            'Content-Type' : overrideMimeType ? overrideMimeType : mime.lookup(local),
            body: compressedContent,
        }]
      }, function handleUpload ( error, results ) {
        if ( error ) return next( error )
        if ( typeof results === 'string' ) {
          try {
            results = JSON.parse( results )
          } catch ( e ) {
            console.log( 'results not json' )
          }
        }
        return next( null, results )
      } )
    }

  },

  // Delete an object from bucket
  del: function(bucket, filename, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + encodeURIComponent(filename),
      method: 'DELETE'
    }, callback);
  },

  deleteAll: function ( bucket, callback ) {
    objectsAPI.listAll( bucket, handleItems )

    function handleItems ( error, items ) {
      if ( error ) return error;

      if ( items.length === 0 ) callback()

      var deleteTasks = items.map( itemToDeleteTask )
      async.parallelLimit( deleteTasks, 10, handleAllDeleted )
    }

    function itemToDeleteTask ( item ) {
      return function deleteTask ( taskComplete ) {
        objectsAPI.del( bucket, item.name, handleDelete )

        function handleDelete ( error ) {
           if ( error >= 400 ) return taskComplete( error )
           taskComplete();
        }
      }
    }

    function handleAllDeleted ( error ) {
      if ( error ) return callback( error )
      callback()
    }
  },

};

module.exports.objects = objectsAPI;
