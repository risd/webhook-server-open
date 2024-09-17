'use strict';

/**
* This is the main API used for interacting with Google Cloud Storage. It is used to manipulate
* the buckets and objects for the sites we host.
*/

// var request = require('request');
const debug = require('debug')('cloud-storage')
const { pipeline } = require('node:stream/promises');
const { Storage } = require('@google-cloud/storage')
const stream = require('node:stream')
var mime = require('mime');
var fs = require('fs');
const chainCallbackResponse = require('./utils/chain-callback-response')

// Contains google service accounts SSH key
var credentials = process.env.GOOGLE_KEY_JSON_STRING && JSON.parse(process.env.GOOGLE_KEY_JSON_STRING)
var googleServiceAccount = credentials?.client_email
let defaultCors = process.env.GOOGLE_BUCKET_DEFAULT_CORS && JSON.parse(process.env.GOOGLE_BUCKET_DEFAULT_CORS)

// storage interface used throughout this file
let storage

module.exports.configure = configure

function configure (options={}) {
  const config = {
    defaultCors,
  }
  if (options.credentials) config.credentials = options.credentials
  if (!googleServiceAccount) googleServiceAccount = options.credentials?.client_email
  try {
    storage = new Storage(config)
  }
  catch (error) {
    console.log('cloud-storage:env-config:error')
    console.log(error)
  }
}

// try to configure on load based on environment variable
if (credentials) {
  configure({ credentials })
}
else {
  throw new Error('Could not configure @google-cloud/storage')
}


// Sets the key file file, not curretly used
module.exports.setKeyFile = function(file) {
  keyFile = file;
}

var bucketsAPI = {
  // Get a bucket's meta data from google cloud storage
  get: function({ bucket }, callback) {
    const chain = storage.bucket(bucket).getMetadata()
      .then((results) => {
        return results[0]
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  // Create a new bucket, makes the bucket a website hosting bucket
  create: function({ bucket }, callback) {
    debug('cloud-storage:create:bucket', bucket)
    const chain = storage.createBucket(bucket)
      .then(() => {
        return bucketsAPI.updateAcls({ bucket })
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
  updateAcls: function({ bucket }, callback) {
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
  list: function({ bucket, options={autoPaginate: false} }, callback) {
    const chain = storage.bucket(bucket).getFiles(options)
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  listStream: function ({ bucket, options={} }) {
    return storage.bucket(bucket).getFilesStream(options)
  },

  // Get an object from a bucket
  get: function({ bucket, remote, local }) {
    return storage.bucket(bucket).file(remote).download({ destination: local })
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
    const chain = pipeline(
      streamFromSource(local),
      destination.createWriteStream(destinationOptions))
      .then(() => {
        return destination.getMetadata()
      })
      .then((results) => {
        return results[0]
      })
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain

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
    debug('upload-compressed, pass through to upload')
    return objectsAPI.upload(options, callback)
  },

  // Delete an object from bucket
  del: function({ bucket, file }, callback) {
    const chain = storage.bucket(bucket).file(file).delete()
    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },

  deleteAll: function ( bucket, callback ) {
    debug('cloud-storage:delete-all:', bucket)

    async function listAndDeleteAll (nextPageQuery) {
      const listOptions = { bucket }
      if (nextPageQuery) {
        listOptions.options = nextPageQuery
      }
      const results = await objectsAPI.list(listOptions)
      const files = results[0]
      if (!Array.isArray(files)) return
      for (const file of files) {
        await objectsAPI.del({ bucket, file: file.name })
      }
      const nextPageQueryOptions = results[1]
      if (nextPageQueryOptions) return await listAndDeleteAll(nextPageQueryOptions)
      else return
    }

    const chain = new Promise(async (resolve, reject) => {
      try {
        await listAndDeleteAll()
        resolve()
      }
      catch (error) {
        reject(error)
      }
    })

    if (typeof callback === 'function') chainCallbackResponse(chain, callback)
    else return chain
  },
  createReadStream: function ({ bucket, file }) {
    return storage.bucket(bucket).file(file).createReadStream()
  },
};

module.exports.objects = objectsAPI;
