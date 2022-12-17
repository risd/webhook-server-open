'use strict';

/**
* This is the main API used for interacting with Google Cloud Storage. It is used to manipulate
* the buckets and objects for the sites we host.
*/

// var request = require('request');
const { Storage } = require('@google-cloud/storage')
const stream = require('stream')
var mime = require('mime');
var fs   = require('fs');
var zlib = require('zlib');
var async = require('async');
const chainCallbackResponse = require('./utils/chain-callback-response')

var oauthToken = '';
var projectName = process.env.GOOGLE_PROJECT_ID || '';
var googleServiceAccount = process.env.GOOGLE_SERVICE_ACCOUNT || '';

// Contains google service accounts SSH key
var keyFilename = process.env.GOOGLE_KEY_JSON || 'libs/keyfile.key';

// storage interface used throughout this file
let storage

function projectIdFromKeyFile( keyFile ) {
  console.log('project-id-from-key-file:keyFile:', keyFile)
  console.log(fs.readFileSync(keyFile).toString())
  try {
    return JSON.parse( fs.readFileSync( keyFile ).toString() ).project_id;
  } catch ( error ) {
    console.log('project-id-from-key-file:error')
    console.log(error)
    throw error
  }
}

module.exports.configure = configure

function configure () {
  console.log('cloud-storage:configure:', keyFilename)
  const config = {
    serviceAccountEmail: googleServiceAccount,
    projectId: projectName,
    keyFilename,
  }
  console.log(config)
  try {
    storage = new Storage(config)
  }
  catch (error) {
    console.log('cloud-storage:env-config:error')
    console.log(error)
  }
}

// try to configure on load based on environment variable
if (keyFilename && projectName && googleServiceAccount) {
  configure()
}


// TODO: remove this and its use throughout the module
/*
* Run a json request against google cloud stoage, handles getting token
*
* @param options  Object of options to pass to the json request, mostly same options passed to request module
* @param callback Callback to call when finished
*/
function jsonRequest(options, callback)  {
  console.log('cloud-storage:json-request')
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

  let formData
  if (typeof options.formData === 'object' && options.formData !== null) {
    formData = new FormData()
    Object.keys(options.formData).forEach((key) => {
      formData.append(key, options.formData[key])
    })
  }
  
  var reqOptions = {
    url: options.url,
    params: options.qs,
    method: options.method,
    // json: options.multipart ? null : (options.data || true),
    headers: options.headers || null,
    data: options.form || formData || options.data || null,
  };

  if(options.binary) {
    reqOptions['encoding'] = null;
  }

  // If the request wants to have a stream back ignore token, the caller is
  // responsible for making sure a token is active
  if(options.stream) {
    return axios(reqOptions);
  } else {
    console.log('cloud-storage:json-request:make-request')
    console.log(reqOptions)
    axios(reqOptions)
      .then((res) => {
        console.log('cloud-storage:json-request:response')
        if (!res) return callback(500, null)
        else if (res.statusCode/100 === 2) {
          callback(null, body);
        }
        else if (res.statusCode === 401) {
          refreshToken(function( error ) {
            if ( error ) return callback( error )
            if(options.multipart) {
              multiData.forEach(function(item) {
                options.multipart[item.index].body = item.body;
              });
            }

            jsonRequest(options, callback);
          });
        }
        else {
          callback(res.statusCode, null);
        }
      })
      .catch((error) => {
        console.log('cloud-storage:json-request:error')
        if (error.message.indexOf(400) > -1) {
          console.log(error.message)
          refreshToken((error) => {
            if (error) return callback(error)
            return jsonRequest(options, callback)
          })
        }
        else callback(error)
      })
  }
}

// Sets the google project name we authenticate against
// module.exports.setProjectName = function(project) {
//   projectName = project;
// }

// // Sets the google service account email with authenticate with
// module.exports.setServiceAccount = function(account) {
//   googleServiceAccount = account;
// }

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

// TODO remove this into a config.json file that gets passed in
// This object contains all methods that have to do with manipulating
// buckets
const defaultCors = [{
  origin: [ "*.risd.systems", "cdn.risd.systems", "risd.edu", "*.risd.edu", "localhost" ],
  responseHeader: [ "Content-Type" ],
  method: [ "GET", "HEAD", "OPTIONS" ],
  maxAgeSeconds: 3600
}]

var bucketsAPI = {
  // Get a bucket's meta data from google cloud storage
  get: function(bucket, callback) {
    const chain = storage.bucket(bucket).getMetadata()
      .then((results) => {
        return results[0]
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
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
  create: function(bucket, callback) {
    console.log('cloud-storage:create:bucket', bucket)
    const chain = storage.createBucket(bucket)
      .then(() => {
        return bucketsAPI.updateAcls(bucket)
      })
      .then(() => {
        return bucketsAPI.updateIndex({ bucket })
      })
      .then(() => {
        return bucketsAPI.updateCors({ bucket })
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  // Changes the ACLs on the bucket to allow the service account write access
  // and allow the public read access
  updateAcls: function(bucket, callback) {
    const chain = storage.bucket(bucket)
      .makePublic()
      .then(() => {
        return storage.bucket(bucket)
          .acl.default.owners.addUser(googleServiceAccount)
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  // Updates the website index on the bucket, used on create
  updateIndex: function({ bucket, indexFile='index.html', notFoundFile='404.html' }, callback) {
    const chain = storage.bucket(bucket).setMetadata({
        website: {
          mainPageSuffix: indexFile,
          notFoundPage: notFoundFile,
        },
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  updateCors: function ({ bucket, cors=defaultCors }, callback) {
    const chain = storage.bucket(bucket).setCorsConfiguration(cors)
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  // Deletes an empty bucket from cloud storage
  del: function(bucket, callback) {
    const chain = storage.bucket(bucket).delete()
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  }
};
module.exports.buckets = bucketsAPI;

// A collection of all functions related to manipulating objects in cloud storage

var objectsAPI = { 

  // List all objects in a bucket (name, md5hash)
  list: function({ bucket, options={} }, callback) {
    const chain = storage.bucket(bucket).getFiles(options)
      .then((results) => {
        const files = results[0]
        return files
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  listAll: function (bucket, options, callback) {
    console.log('cloud-storage:objects:list-all')
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
  getMeta: function ({ bucket, file }, callback ) {
    const chain = storage.bucket(bucket).file(file).getMetadata()
      .then((results) => {
        return results[0]
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },
  upload: function ({ bucket, local, remote, cacheControl='no-cache', overrideMimeType }, callback) {
    // we stream file uploads since `local` can be a file or the contents of a file
    const destinationOptions = {
      metadata: {
        cacheControl,
        contentType: typeof overrideMimeType === 'string'
          ? overrideMimeType
          : mime.lookup(local),
      },
    }
    const destination = storage.bucket(bucket).file(remote)
    return new Promise((resolve, reject) => {
      streamFromSource(local)
        .pipe(destination.createWriteStream(destinationOptions))
        .on('error', (error) => {
          if (typeof callback === 'function') callback(error)
          reject(reror)
        })
        .on('finish', (results) => {
          if ( typeof results === 'string' ) {
            try {
              results = JSON.parse( results )
            } catch ( e ) {
              console.log( 'results not json' )
            }
          }
          if (typeof callback === 'function') callback(null, results)
          resolve(results)
        })
    })

    function streamFromSource (fileOrContent) {
      const isFile = fs.existsSync(fileOrContent)
      if (isFile) {
        const fileStream = fs.createReadStream(fileOrContent)
        return fileStream
      }
      else {
        const contentStream = new stream.PassThrough()
        contentStream.write(fileOrContent)
        contentStream.end()
        return contentStream
      }
    }
  },
  uploadCompressed: function(options, callback) {
    console.log('upload-compressed, pass through to upload')
    return objectsAPI.upload(options, callback)
  },

  // Delete an object from bucket
  del: function({ bucket, file }, callback) {
    const chain = storage.bucket(bucket).file(file).delete()
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  deleteAll: function ( bucket, callback ) {
    console.log('cloud-storage:delete-all:', bucket)

    const chain = objectsAPI.list({ bucket })
      .then(async (files) => {
        for (const file of files) {
          console.log('cloud-storage:delete-all:delete-file:', file.name)
          await objectsAPI.del({ bucket, file: file.name })
        }
      })

    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  // TODO did not end up using this, it can be removed
  getUploadUrl: function ({ bucket, file }) {
    const options = {
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 min
      // contentType: 'application/json',
      contentType: 'multipart/form-data',
    }

    return storage.bucket(bucket).file(file).getSignedUrl(options)
      .then((results) => {
        const url = results[0]
        return url
      })
  },
};

module.exports.objects = objectsAPI;
