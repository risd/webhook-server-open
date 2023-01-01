// TODO update for latest internal apis
// TODO replace siteBillingActive with firebase.siteBillingActive({ siteName })
// TODO replace siteKeyEqualsToken with firebase.siteBillingActive({ siteName })
// todo replace express with fastify?
// TODO replace local elastic interface with the webhook-elastic-sarch module
/**
* The server is a web server that handles three main tasks:
*   1) It provides an endpoint for users to upload their files to the workers, through wh deploy
*   2) It provides endpoints for users to upload files to their buckets from their CMS
*   3) It provides endpoints for users to access the elastic search data for their site
*
* Almost all requests to the server require some sort of authentication, normally in the form of
* site name + site token.
*/

const debug = require('debug')('server')
const Fastify = require('fastify')
const expressPlugin = require('@fastify/express')
const express = require('express');
const cors = require('cors')
var colors = require('colors');
var request = require('request');
var fs = require('fs');
const fsp = require('node:fs/promises')
var mkdirp = require('mkdirp');
var async = require('async');
const Elastic = require('webhook-elastic-search')
var Firebase = require('./firebase/index');
var path = require('path');
var cloudStorage = require('./cloudStorage.js');
var backupExtractor = require('./backup-extractor.js');
var temp = require('temp');
var mime = require('mime');
var _ = require('lodash');
var Deploys = require( 'webhook-deploy-configuration' );
const {pipeline} = require('stream')
const {fileNameForTimestamp} = require( './backup.js' )

// Some string functions worth having
String.prototype.endsWith = function(suffix) {
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

String.prototype.startsWith = function (str){
  return this.indexOf(str) == 0;
};

module.exports.start = async function(config) {

  var elastic = Elastic(config.get('elastic'))

  const firebase = Firebase({
    initializationName: 'server',
    ...config.get('firebase'),
  })

  var database = firebase.database()

  var deploys = Deploys(database.ref())

  const backupBucket = config.get('backupBucket')
  const uploadBucket = config.get('uploadsBucket')
  const siteBucket = config.get('sitesBucket')
  const googleProjectId = config.get('googleProjectId')
  const cacheControl = 'public,max-age=86400'

  const app = Fastify()
  await app.register(expressPlugin)

  // Set up our request handlers for express
  app.use(express.limit('1024mb'));
  app.use(express.bodyParser({ maxFieldsSize: 10 * 1024 * 1024 }));
  app.use(cors())

  async function siteBillingActive (request, reply) {
    const siteName = request.query.site
    const isActive = await firebase.siteBillingActive({ siteName })
    if (!isActive) {
      reply.type('application/json').code(500)
      return { error: 'Site not active, please check billing status.' }
    }
  }

  async function siteKeyEqualsToken (request, reply) {
    const siteName = request.query.site
    const token = request.query.token
    const siteKeySnapshot = await firebase.siteKey({ siteName })
    const siteKey = siteKeySnapshot.val()
    if (!siteKey) {
      reply.type('application/json').code(500)
      return { error: 'Site does not exist.' }
    }
    if (token !== siteKey) {
      reply.type('application/json').code(403)
      return { error: 'Token is not valid' }
    }
  }

  const protectedRouteOptions = {
    preHandler: [siteBillingActive, siteKeyEqualsToken]
  }
  
  app.get('/', getRootHandler)
  app.get('/backup-snapshot/', protectedRouteOptions, getBackupHandler)
  app.post('/upload-url/', protectedRouteOptions, postUploadUrlHandler)
  app.post('/upload-file/', protectedRouteOptions, postUploadFileHandler)
  app.post('/search/', protectedRouteOptions, postSearchHandler)
  app.post('/search/index/', protectedRouteOptions, postSearchIndexHandler)
  app.post('/search/delete/', protectedRouteOptions, postSearchDeleteHandler)
  app.post('/search/delete/type/', protectedRouteOptions, postSearchDeleteTypeHandler)
  app.post('/search/delete/index/', protectedRouteOptions, postSearchDeleteIndexHandler)
  app.post('/upload/', protectedRouteOptions, postUploadHandler)

  const port = 3000
  await app.listen(port)
  console.log(`listening on ${ port }...`.red);

  return { app, port }

  function getRootHandler (request, reply) {
    reply.send('Working...')
  }

  // TODO: test this setup, tried to match backupextractor
  async function getBackupHandler (request, reply) {
    const siteName = request.query.site
    const token = request.query.token
    const timestamp = request.query.timestamp

    const backupStream = await cloudStorage.objects.createReadStream({
      bucket: backupBucket,
      file: fileNameForTimestamp(timestamp),
    })
    const extractor = backupExtractor.getParser(['buckets', siteName, token, 'dev'])
    reply.header('Content-Type', 'application/octet-stream')
    return extractor
  }

  // Handles uploading a file from a url
  // Post body contains site, token, resize_url, and url
  // site and token are the site and token for the site to upload to
  // resize_url is passed if the url is of an image and needs a resize_url returned
  // Finally url is the url of the object to upload
  async function postUploadUrlHandler (request, reply) {
    reply.type('application/json')

    const siteName = request.query.site
    const token = request.query.token

    const resizeUrlRequested = req.body.resize_url
    const url = req.body.url

    if (!url) {
      cleanUpFiles(req)
      reply.code(400)
      return { error: 'Body requires a `url` attribute to upload.' }
    }

    const localFile = await createTmpFile()
    await downloadUrlToPath({ url, localFile })
    const stat = await fsp.stat(localFile)
    if (stat.size > 50 * 1024 * 1024) {
      reply.code(500)
      return { error: 'File too large. 50 MB is limit.' }
    }
    const remote = timestampedUploadsPathForFileName(path.basename(url))
    
    const results = await cloudStorage.objects.upload({
      bucket: uploadBucket,
      local: localFile,
      remote,
      cacheControl,
    })
    results.url = `//${results.bucket}/${results.name}`

    if (resizeUrlRequested) {
      try {
        const resizeUrl = await resizeUrlForUrl(results.url)
        results.resizeUrl = resizeUrl
      }
      catch (error) {
        cleanUpFiles(req)
        reply.code(500)
        return { error: 'Could not get resize url for file.' }
      }
    }

    fs.unlinkSync(localFile)
    cleanUpFiles(request)

    reply.code(200)
    return {
      message: 'Finished',
      url: results.url,
      size: results.fileSize,
      mimeType: results.contentType,
      resizeUrl: results.resizeUrl,
    }

    function createTmpFile () {
      return new Promise((resolve, reject) => {
        temp.open({ prefix: 'uploads', dir: '/tmp' }, function (err, info) {
          if (err) return reject(err)
          resolve(info.path)
        })
      })
    }

    function downloadUrlToPath ({ url, localFile }) {
      var downloadError = { statusCode: 500, message: 'Could not download url.' }
      return new Promise((resolve, reject) => {
        try {
          var req = request(url)
        } catch (error) {
          return reject(error)
        }

        var requestFailed = false
        req
          .on('response', function (response) {
            if ( ! response || response.statusCode !== 200) {
              requestFailed = true
              fs.unlinkSync(localFile)
            }
          })
          .on('error', function (error) {
            fs.unlinkSync(localFile)
            reject(error)
          })
          .pipe(fs.createWriteStream(localFile))
            .on( 'close', function () {
              if (requestFailed) return reject(new Error('Could not download url'))
              else resolve()
            })
      })
    }
  }

  // Handles uploading a file posted directly to the server
  // Post body contains site, token, resize_url, and file payload
  // site and token are the site and token for the site to upload to
  // resize_url is passed if the url is of an image and needs a resize_url returned
  // Finally the payload is the file being posted to the server
  async function postUploadFileHandler (request, reply) {
    reply.type('application/json')

    const siteName = request.query.site
    const token = request.query.token

    const resizeUrlRequested = req.body.resize_url
    const payload = req.files.payload;

    // 50 MB file size limit
    if ( payload.size > ( 50 * 1024 * 1024 ) ) {
      cleanUpFiles(req)
      reply.code(500)
      return { error: 'File too large. 50 MB is limit.' }
    }

    const localFile = payload.path;
    const remote = timestampedUploadsPathForFileName(path.basename(payload.originalFilename))

    const results = await cloudStorage.objects.upload({
      bucket: uploadBucket,
      local: localFile,
      remote,
      cacheControl,
    })
    results.url = `//${results.bucket}/${results.name}`

    if (resizeUrlRequested) {
      try {
        const resizeUrl = await resizeUrlForUrl(results.url)
        results.resizeUrl = resizeUrl
      }
      catch (error) {
        cleanUpFiles(req)
        reply.code(500)
        return { error: 'Could not get resize url for file.' }
      }
    }

    fs.unlinkSync(localFile)
    cleanUpFiles(request)

    reply.code(200)
    return {
      message: 'Finished',
      url: results.url,
      size: results.fileSize,
      mimeType: results.contentType,
      resizeUrl: results.resizeUrl,
    }
  }

  // Handles search requests
  // Post data includes site, token, query,  page, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // query is the query being performed, page is the page of search being returned
  // typeName is the type to restrict to, null for all types
  async function postSearchHandler (request, reply) {
    reply.type('application/json')
    const siteName = request.body.site

    const query = request.body.query
    const page = request.body.page || 1
    const contentType = req.body.typeName || null

    try { 
      const hits = await elastic.queryIndex({ siteName, query, page, contentType })
      reply.code(200)
      return { hits } 
    }
    catch (error) {
      reply.code(500)
      return { error: 'Could not search elastic.' }
    }
  }

  // Handles search indexing
  async function postSearchIndexHandler (request, reply) {
    reply.type('application/json')
    const siteName = request.body.site
    const doc = request.body.data
    const id = request.body.id
    const contentType = request.body.typeName
    const oneOff = request.body.oneOff || false

    try {
      await elastic.indexDocument ({
        siteName,
        contentType,
        doc,
        id,
        oneOff = false,
      })
      reply.code(200)
      return { message: 'Finished' }
    }
    catch (error) {
      reply.code(500)
      return { error: 'Could not index item for site.' }
    }
  }

  // Handles deleteting a search object
  async function postSearchDeleteHandler (request, reply) {
    reply.type('application/json')
    const siteName = request.body.site
    const id = request.body.id

    try {
      await elastic.deleteDocument({
        siteName,
        id,
      })
      reply.code(200)
      return { message: 'Finished' }
    }
    catch (error) {
      reply.code(500)
      return { error: 'Could not delete document at id for site.' }
    }
  }  

  // Handles deleteting all objects of a type from search
  async function postSearchDeleteTypeHandler (request, reply) {
    reply.type('application/json')
    const siteName = request.body.site
    const contentType = request.body.typeName

    try {
      await elastic.deleteContentType({
        siteName,
        contentType,
      })
      reply.code(200)
      return { message: 'Finished' }
    }
    catch (error) {
      reply.code(500)
      return { error: 'Could not delete content-type for site.' }
    }
  }

  // Deletes an entire index (site) from search
  // Post data includes site and token
  // Site and Token are the sitename and token for the site search is being performed on
  async function postSearchDeleteIndexHandler (request, reply) {
    reply.type('application/json')
    const siteName = request.body.site

    try {
      await elastic.deleteIndex({ siteName })
      reply.code(200)
      return { message: 'Finished' }
    }
    catch (error) {
      reply.code(500)
      return { error: 'Could not delete index for site.' }
    }
  }

  // Handles uploading a site to our system and triggering a build
  // Post data includes site, token, and the file called payload
  // Site and Token are the name of the site and the token for the site to upload to
  // The Payload file is the zip file containing the site generated by wh deploy
  async function postUploadHandler (request, reply) {
    reply.type('application/json')
    const siteName = request.body.site

    const branch = request.body.branch;
    const payload = request.files.payload;

    if(!payload || !payload.path || !branch) {
      cleanUpFiles(request)
      reply.code(500)
      return { error: 'Must upload a file and define which git branch it is associated with.' }
    }
    try { 
      await cloudStorage.objects.upload({
        bucket: siteBucket,
        local: payload.path,
        remote: Deploys.utilities.fileForSiteBranch(siteName, branch)
      })
      fs.unlinkSync(payload.path)

      await firebase.siteVersion({ siteName }, Date.now())
      await firebase.signalBuild({ siteName }, {
        siteName,
        branch,
        userId: 'admin',
        id: uniqueId()
      })
      reply.code(200)
      return { message: 'Finished' }
    }
    catch (error) {
      reply.code(500)
      cleanUpFiles(request)
      return { error: error.message }
    }
  }

  function resizeUrlForUrl (url) {
    var encodedUrl = encodeURIComponentsForURL( removeProtocolFromURL( url ) )
    return new Promise((resolve, reject) => {
      request( `https://${ googleProjectId }.appspot.com/${ encodedUrl  }`, handleResize )

      function handleResize ( error, response, responseBody ) {
        if (error) return reject(error)
        var resizeUrl = ''
        if ( response && response.statusCode === 200 ) resizeUrl = responseBody
        if ( resizeUrl.length > 0 && resizeUrl.indexOf( 'http://' ) === 0 ) {
          resizeUrl = `https${ resizeUrl.slice( 4 )}`
        }
        resolve(resizeUrl)
      }
    })
  }

  function timestampedUploadsPathForFileName ( fileName ) {
    return `webhook-uploads/${ new Date().getTime() }_${ fileName.replace( / /g, '-' ) }`
  }
}



/* helpers */

function uniqueId() {
  return Date.now() + 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  }); 
}


// Cleans up any files that may have been posted to
// the server in req, used to clean up uploads
function cleanUpFiles (req) {
  for(var key in req.files) {
    if(req.files[key].path) {
      try {
        fs.unlinkSync(req.files[key].path);
      } catch (e) {
        // Ignore, just last minute trying to unlink
      }
    }
  }
}

function encodeURIComponentsForURL ( url ) {
  var protocolIndex = url.indexOf( '//' )
  var includesProtocol = protocolIndex === -1
    ? false
    : true

  if ( includesProtocol ) {
    var protocolString = url.split( '//' )[ 0 ]
    url = url.slice( protocolIndex + 2 )
  }

  var encodedUrl = url.split( '/' ).map( encodeURIComponent ).join( '/' )

  if ( includesProtocol ) {
    encodedUrl = [ protocolString, encodedUrl ].join( '//' )
  }

  return encodedUrl
}

function removeProtocolFromURL ( url ) {
  var protocolIndex = url.indexOf( '//' )
  var includesProtocol = protocolIndex === -1
    ? false
    : true

  if ( includesProtocol ) return url.slice( protocolIndex + 2 )

  return url;
}
