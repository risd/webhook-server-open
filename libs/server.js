/**
* The server is a web server that handles three main tasks:
*   1) It provides an endpoint for users to upload their files to the workers, through wh deploy
*   2) It provides endpoints for users to upload files to their buckets from their CMS
*   3) It provides endpoints for users to access the elastic search data for their site
*
* Almost all requests to the server require some sort of authentication, normally in the form of
* site name + site token.
*/

var express = require('express');
var colors = require('colors');
var Zip   = require('adm-zip');
var request = require('request');
var fs = require('fs');
var mkdirp = require('mkdirp');
var async = require('async');
var Firebase = require('./firebase/index');
var wrench = require('wrench');
var path = require('path');
var cloudStorage = require('./cloudStorage.js');
var backupExtractor = require('./backupExtractor.js');
var temp = require('temp');
var mime = require('mime');
var ElasticSearchClient = require('elasticsearchclient');
var archiver   = require('archiver');
var _ = require('lodash');
var Deploys = require( 'webhook-deploy-configuration' );

// Some string functions worth having
String.prototype.endsWith = function(suffix) {
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

String.prototype.startsWith = function (str){
  return this.indexOf(str) == 0;
};

// General error handling function
function errorHandler (err, req, res, next) {
  res.status(500);
  res.send('error');
}

module.exports.start = function(config, logger)
{
  if (config.get('newrelicEnabled')) {
    require('newrelic');
  }

  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  var app = express();

  var serverName = config.get('elasticServer').replace('http://', '').replace('https://', '');
  serverName = serverName.split(':')[0];
  var elasticOptions = {
      host: serverName,
      port: 9200,
      auth: {
        username: config.get('elasticUser'),
        password: config.get('elasticPassword')
    }
  };
  if (config.get('elasticOptions'))
  {
    _.extend(elasticOptions, config.get('elasticOptions'));
  }

  var elastic = new ElasticSearchClient(elasticOptions);

  var firebaseOptions = Object.assign(
    { initializationName: 'create-worker' },
    config().firebase )

  // project::firebase::initialize::done
  var firebase = Firebase( firebaseOptions )
  var database = firebase.database()

  var deploys = Deploys( database )

  // Set up our request handlers for express
  app.use(express.limit('1024mb'));
  app.use(express.bodyParser({ maxFieldsSize: 10 * 1024 * 1024 }));
  app.use(allowCrossDomain);
  app.use(errorHandler);
  
  app.get('/', getRootHandler)
  app.get('/backup-snapshot/', getBackupHandler)
  app.post('/upload-url/',  postUploadUrlHandler)
  app.post('/upload-file/', postUploadFileHandler)
  app.post('/search/', postSearchHandler)
  app.post('/search/index/', postSearchIndexHandler)
  app.post('/search/delete/', postSearchDeleteHandler)
  app.post('/search/delete/type/', postSearchDeleteTypeHandler)
  app.post('/search/delete/index/', postSearchDeleteIndexHandler)
  app.post('/upload/', postUploadHandler)

  app.listen(3000);
  console.log('listening on 3000...'.red);

  return app;

  // Used to know that the program is working
  function getRootHandler (req, res) {
    res.send('Working...');
  }

  // Request for backup snapshots, passed a token, sitename, and a timestamp
  // If the token matches the token for the site on record, returns
  // a backup for the given site
  function getBackupHandler (req, res) {
    var token = req.query.token;
    var timestamp = req.query.timestamp;
    var site = req.query.site;

    var respond404 = function respond404 ( res ) {
      res.status( 404 )
      res.end()
    }

    var validateRequestSeries = [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
    ]

    async.series( validateRequestSeries, function handleValidationSeries ( error ) {
      if ( error ) return handleResponseForSeries( res, error )
      extractBackup( timestamp, res )
    } )

    function extractBackup ( timestamp, res ) {
      cloudStorage.getToken(function() {
        var backupStream = cloudStorage.objects.getStream(config.get('backupBucket'), 'backup-' + timestamp);
        var extractor = backupExtractor.getParser(['buckets', site, token, 'dev']);

        backupStream.pipe(extractor).pipe(res);
      });
    }
  }

  // Handles uploading a file from a url
  // Post body contains site, token, resize_url, and url
  // site and token are the site and token for the site to upload to
  // resize_url is passed if the url is of an image and needs a resize_url returned
  // Finally url is the url of the object to upload
  function postUploadUrlHandler (req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var resizeUrlRequested = req.body.resize_url || false;
    var url = req.body.url; 
    var originReq = req;

    // If no url, get out of here
    if ( ! url ) {
      cleanUpFiles( req )
      return handleResponseForSeries( res, {
        statusCode: 400,
        message: 'Body requires a `url` attribute to upload.'
      } )
    }

    var validateRequestSeries = [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
    ]

    var uploadFileWaterfall = [
      createTmpFile,
      downloadUrlToPath.bind( null, url ),
      limitFileSize,
      uploadLocalFileToUploadsBucket,
    ]

    if ( resizeUrlRequested ) uploadFileWaterfall = uploadFileWaterfall.concat( [ getResizeUrl ] )

    async.series( validateRequestSeries, function handleValidationSeries ( error ) {
      if ( error ) {
        cleanUpFiles( req )
        return handleResponseForSeries( res, error )
      }

      async.waterfall( uploadFileWaterfall, handleUploadFileWaterfall.bind( null, req, res ) )
    } )

    // callback => localFile
    function createTmpFile ( callback ) {
      temp.open( { prefix: 'uploads', dir: '/tmp' }, function ( err, info ) {
        if ( err ) return callback( err )
        callback( null, info.path )
      } )
    }

    // url, localFile, callback => error?, { localFile, localFileOrigin }
    function downloadUrlToPath ( url, localFile, callback ) {
      var downloadError = { statusCode: 500, message: 'Could not download url.' }
      try {
        var req = request( url )
      } catch ( error ) {
        return callback( downloadError )
      }

      var requestFailed = false
      // Request the URL and pipe into our temporary file
      req
        .on('response', function (response) {
          if ( ! response || response.statusCode !== 200) {
            requestFailed = true
            fs.unlinkSync( localFile )
          }
        })
        .on('error', function ( error ) {
          fs.unlinkSync( localFile )
          callback( downloadError )
        })
        .pipe( fs.createWriteStream( localFile ) )
          .on( 'close', function () {
            if ( requestFailed ) return callback( downloadError )
            callback( null, { localFile: localFile, localFileOrigin: url } )
          } )
    }

    // { localFile, localFileOrigin }, callback => error?, { localFile, localFileOrigin }
    function limitFileSize ( options, callback ) {
      var localFile = options.localFile
      fs.stat( localFile, function ( error, stat ) {
        if ( error ) return callback( { status: 500, message: 'File too large. 50 MB is limit.' } )
        // Size limit of 50MB
        if( stat.size > ( 50 * 1024 * 1024 ) ) {
          return callback( { status: 500, message: 'File too large. 50 MB is limit.' } )
        }

        callback( null, options )
      } )
    }
  }

  // Handles uploading a file posted directly to the server
  // Post body contains site, token, resize_url, and file payload
  // site and token are the site and token for the site to upload to
  // resize_url is passed if the url is of an image and needs a resize_url returned
  // Finally the payload is the file being posted to the server
  function postUploadFileHandler (req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var resizeUrlRequested = req.body.resize_url || false;
    var payload = req.files.payload;

    console.log( 'upload-file' )
    console.log( site )

    // 50 MB file size limit
    if ( payload.size > ( 50 * 1024 * 1024 ) ) {
      cleanUpFiles( req )
      res.json( 500, { error: 'File too large. 50 MB is limit.' } )
      return;
    }

    var localFile = payload.path;
    var localFileOrigin = payload.originalFilename;

    var validateRequestSeries = [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
    ]

    var uploadFileWaterfall = [
      uploadLocalFileToUploadsBucket.bind( null, { localFile: localFile, localFileOrigin: localFileOrigin } )
    ]

    if ( resizeUrlRequested ) uploadFileWaterfall = uploadFileWaterfall.concat( [ getResizeUrl ] )

    async.series( validateRequestSeries, function handleValidationSeries ( error ) {
      if ( error ) {
        cleanUpFiles( req )
        return handleResponseForSeries( res, error )
      }

      async.waterfall( uploadFileWaterfall, handleUploadFileWaterfall.bind( null, req, res ) )
    } )
  }

  /**
   * uploadLocalFileToUploadsBucket
   * 1/3 helper tasks to get files uploaded into the `webhook-uploads`
   *     directory of webhook with a timestamp of when they were uploaded.
   * 
   * Used to upload a `localFile` to the timestamped destination based on
   * the `localFileOrigin` name.
   *
   * This function supports both CMS upload processes
   * ( file based & url based ).
   *
   * Signature:
   * { ..., localFile, localFileOrigin }, callback => error?, { localFile, localFileOrigin, fileSize, bucket, remoteFile, gscUrl, mimeType }
   */
  function uploadLocalFileToUploadsBucket ( options, callback ) {
    var localFileOrigin = options.localFileOrigin

    var baseRemoteFileName = path.basename( localFileOrigin )
    var uploadOptions = Object.assign( {}, options, {
      remoteFile: baseRemoteFileName,
      cacheControl: 'public,max-age=86400',
    } )

    cloudStorageObjectUploadToUploadsBucketTimestamped( uploadOptions, handleUploadToUploadsBucketTimestamped )

    function handleUploadToUploadsBucketTimestamped ( error, results ) {
      if ( error ) return callback( error )
      return callback( null, Object.assign( {}, uploadOptions, {
        bucket: results.bucket,
        remoteFile: results.name,
        gscUrl: `//${ results.bucket }/${ results.name }`,
        fileSize: results.size,
        mimeType: results.contentType,
      } ) )
    }
  }

  /**
   * getResizeUrl
   * 2/3 helper tasks to get files uploaded into the `webhook-uploads`
   *     directory of webhook with a timestamp of when they were uploaded.
   *
   * Used to get a `resizeUrl` from a `gscUrl`.
   * 
   * Signature:
   * { ..., gscUrl }, callback => error?, { ..., gscUrl, resizeUrl }
   */
  function getResizeUrl ( options, callback ) {
    resizeUrlForUrl( options.gscUrl, handleResize )

    function handleResize ( error, resizeUrl ) {
      if ( error ) return callback( error )
      callback( null, Object.assign( {}, options, { resizeUrl: resizeUrl } ) )
    }
  }

  /**
   * handleUploadFileWaterfall
   * 3/3 helper handler to respond to file uploads to `webhook-uploads`
   *     directory of webhook with a timestamp of when they were uploaded.
   *
   * Used to handle the response to the file upload request.
   * 
   * Signature:
   * req, res, error?, { gscUrl, fileSize, mimeType, resizeUrl? }
   */
  function handleUploadFileWaterfall ( req, res, error, uploadResults ) {
    cleanUpFiles( req )
    if ( error ) return handleResponseForSeries( res, error )

    if ( uploadResults.localFile ) fs.unlinkSync( uploadResults.localFile )

    var successResponse = {
      message: 'Finished',
      url: uploadResults.gscUrl,
      size: uploadResults.fileSize,
      mimeType: uploadResults.mimeType,
    }
    if ( uploadResults.resizeUrl ) successResponse.resize_url = uploadResults.resizeUrl

    res.json( 200, successResponse )
  }

  // We do this to allow for CORS requests to the server (for search)
  function allowCrossDomain (req, res, next) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type');

      if ('OPTIONS' == req.method) {
        res.send(200);
      } else {
        next();
      }
  }

  // Files are uploaded to the same `uploadsBucket`, at the URL returned
  // for the given `fileName`
  function fileUrlForFileName ( fileName ) {
    return [ '//', config.get( 'uploadsBucket' ), '/webhook-uploads/', encodeURIComponent( fileName ) ].join( '' )
  }

  /*
  * Performs a search against elastic for the given query on the given typeName
  *
  * @param site     The site to perform the search for
  * @param query    The query being executed
  * @param page     The page to return
  * @param typeName The type to restrict search to (null if all)
  * @param callback Function to call with results
  */
  function searchElastic (site, query, page, typeName, callback) {

    if(!query.endsWith('*')) {
      query = query + '*';
    }

    if(!query.startsWith('*')) {
      query = '*' + query;
    }

    if(page < 1) {
      page = 1;
    }

    var qryObj = {
        "query" : {
            "query_string" : { 
              "fields" : ["name^5", "_all"],
              "query" : query 
            }
        },
        "from": (page - 1) * 10,
        "size": 10,
        "fields": ['name','__oneOff'],
        "highlight" : { "fields" : { "*" : {} }, "encoder": "html" }
    };

    console.log( 'elastic-search' )
    console.log( 'site:' + site )
    console.log( 'typeName:' + typeName )
    console.log( 'qryObj:' + JSON.stringify( qryObj ) )

    if(typeName) {
      elastic.search(site, typeName, qryObj)
          .on('data', function(data) {
            console.log( 'result:' + data )
            
            data = JSON.parse(data);
            callback(null, data);
          }).on('error', function(err) {
            callback(err, null);
          })
          .exec();
    } else {
      elastic.search(site, qryObj)
          .on('data', function(data) {
            data = JSON.parse(data);
            callback(null, data);
          }).on('error', function(err) {
            callback(err, null);
          })
          .exec();
    }
  }

  // Handles search requests
  // Post data includes site, token, query,  page, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // query is the query being performed, page is the page of search being returned
  // typeName is the type to restrict to, null for all types
  function postSearchHandler (req, res) {
    var site = req.body.site;
    var token = req.body.token;
    var query = req.body.query;
    var page = req.body.page || 1;
    var typeName = req.body.typeName || null;

    async.series( [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
      elasticSearchQuery.bind( null, { site: site, typeName: typeName, query: query, page: page } )
    ], handleResponseForQuery )

    function handleResponseForQuery ( error, seriesResults ) {
      if ( error ) return handleResponseForSeries( res, error )
      var responseData = seriesResults.pop()
      res.json( 200, responseData )
    }

    function elasticSearchQuery ( options, callback ) {
      var site = options.site
      var typeName = options.typeName
      var query = options.query
      var page = options.page

      var callbackErrorValue = null

      searchElastic(unescapeSite(site), query, page, typeName, function(err, data) {
        if ( err ) return callback( { statusCode: 500, message: 'Could not search elastic.' } )
        if ( ! data.hits ) return callback( null, { hits : {} } )
        else return callback ( null, { hits : data.hits.hits } )
      });
    }
  }

  // Handles search indexing
  // Post data includes site, token, data, id, oneOff, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // data is the data being indexed, id is the id of the object, oneOff is true/false depending 
  // on if the object is a oneOff, typeName is the type of the object
  function postSearchIndexHandler (req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var data = req.body.data;
    var id   = req.body.id;
    var typeName = req.body.typeName;
    var oneOff = req.body.oneOff || false;

    async.series( [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
      elasticSearchIndexItem.bind( null, { site: site, typeName: typeName, id: id, doc: data, oneOff: oneOff } )
    ], handleResponseForSeries.bind( null, res ) )

    function elasticSearchIndexItem ( options, callback ) {
      var site = options.site
      var typeName = options.typeName
      var id = options.id
      var doc = options.doc
      var oneOff = options.oneOff

      var callbackErrorValue = null
      
      var parsed = JSON.parse(doc);
      parsed.__oneOff = oneOff;
      
      elastic.index(unescapeSite(site), typeName, parsed, id)
        .on('data', function( indexedResponse ) {
          if ( typeof indexedResponse === 'string' ) {
            indexedData = JSON.parse( indexedResponse )
          }
          else if ( typeof indexedResponse === 'object' ) {
            indexedData = Object.create( indexedResponse )
          }

          if ( indexedData.error ) {
            callbackErrorValue = { statusCode: 500, message: indexedData.error }
          }
        })
        .on('error', function ( error ) {
          callbackErrorValue = { statusCode: 500, message: 'Could not index item for site.' }
        })
        .on('done', function () {
          callback( callbackErrorValue )
        })
        .exec();
    }
  }

  // Handles deleteting a search object
  // Post data includes site, token, id,  and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // id is the id of the object, typeName is the type of the object
  function postSearchDeleteHandler (req, res) {

    // Todo: validate this shit
    var site = req.body.site;
    var token = req.body.token;
    var id   = req.body.id;
    var typeName = req.body.typeName;

    async.series( [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
      elasticDeleteSearchItem.bind( null, { site: site, typeName: typeName, id: id } )
    ], handleResponseForSeries.bind( null, res ) )

    function elasticDeleteSearchItem ( options, callback ) {
      var site = options.site
      var typeName = options.typeName
      var id = options.id
      var callbackErrorValue = null
      elastic.deleteDocument(unescapeSite(site), typeName, id)
        .on('error', function ( error ) {
          callbackErrorValue = { statusCode: 500, message: 'Could not delete content-type item for site.' }
        })
        .on('done', function() {
          callback( callbackErrorValue )
        })
        .exec()
    }
  }  

  // Handles deleteting all objects of a type from search
  // Post data includes site, token, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // typeName is the type of the object
  function postSearchDeleteTypeHandler (req, res) {

    // Todo: validate this shit
    var site = req.body.site;
    var token = req.body.token;
    var typeName = req.body.typeName;

    async.series( [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
      elasticContentTypeDeleteIndex.bind( null, { site: site, typeName: typeName } )
    ], handleResponseForSeries.bind( null, res ) )

    function elasticContentTypeDeleteIndex ( options, callback ) {
      var site = options.site
      var typeName = options.typeName
      var callbackErrorValue = null
      elastic.deleteMapping(unescapeSite(site), typeName)
        .on('error', function ( error ) {
          callbackErrorValue = { statusCode: 500, message: 'Could not delete content-type index for site.' }
        })
        .on('done', function() {
          callback( callbackErrorValue )
        })
        .exec();
    }
  }

  // Deletes an entire index (site) from search
  // Post data includes site and token
  // Site and Token are the sitename and token for the site search is being performed on
  function postSearchDeleteIndexHandler (req, res) {

    var site = req.body.site;
    var token = req.body.token;

    async.series( [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
      elasticDeleteIndex.bind( null, site ),
    ], handleResponseForSeries.bind( null, res ) )

    function elasticDeleteIndex ( site, callback ) {
      var callbackErrorValue = null;
      elastic.deleteIndex(unescapeSite(site))
        .on('error', function ( error ) {
          callbackErrorValue = { statusCode: 500, message: 'Could not delete site index.' }
        })
        .on('done', function() {
          callback( callbackErrorValue )
        })
        .exec()
    }
  }

  // Handles uploading a site to our system and triggering a build
  // Post data includes site, token, and the file called payload
  // Site and Token are the name of the site and the token for the site to upload to
  // The Payload file is the zip file containing the site generated by wh deploy
  function postUploadHandler (req, res) {

    console.log( 'upload' )

    var site = req.body.site;
    var token = req.body.token;
    var branch = req.body.branch || Deploys.utilities.defaultBranch();
    var payload = req.files.payload;

    console.log( 'with arguments' )
    console.log( site )
    console.log( branch )

    if(!payload || !payload.path) {
      cleanUpFiles(req);
      res.status(500);
      return res.end();
    }
    
    console.log( 'firebase-active?' )

    async.series( [
      siteBillingActive.bind( null, site ),
      siteKeyEqualsToken.bind( null, { siteName: site, token: token } ),
      sendFiles.bind( null, site, branch, payload.path )
    ], function handlePostUploadHandlerSeries ( error ) {
      cleanUpFiles( req )
      handleResponseForSeries( res, error )
    } )

    function sendFiles(site, branch, path, callback) {
      // When done zipping up, upload to our archive in cloud storage
      console.log( 'send-files' )
      cloudStorage.objects.upload(config.get('sitesBucket'), path, Deploys.utilities.fileForSiteBranch( site, branch ), function(err, data) {
        console.log( 'send-files:done' )
        fs.unlinkSync( path )

        if ( err ) {
          console.log( 'send-files:done:err' )
          console.log( err )
          return callback( { statusCode: 500, message: 'Could not upload to sites bucket.' } )
        }

        async.series( [
          setSiteVersion.bind( null, { siteName: site, timestamp: Date.now() } ),
          signalBuild.bind( null, { siteName: site, branch: branch } )
        ], callback )
      });
    }
  }

  function siteBillingActive ( site, callback ) {
    database.ref( '/billing/sites/' + site + '/active' )
      .once( 'value', onActiveSnapshotSuccess, onActiveSnapshotError )

    function onActiveSnapshotSuccess ( activeSnapshot ) {
      var isActive = activeSnapshot.val()
      // if this function is pulled out into a common firebase interface,
      // just return the active value
      if ( ! isActive ) return callback( siteBillingActiveError() )
      callback( null )
    }

    function onActiveSnapshotError ( error ) {
      callback( siteBillingActiveError() )
    }

    // server specific error based on being able to send a response with
    // the object `res.send( error.statusCode, error )
    function siteBillingActiveError () {
      return {
        statusCode: 500,
        message: 'Site not active, please check billing status.',
      }
    }
  }

  function siteKeyEqualsToken( options, callback ) {
    var siteName = options.siteName
    var token = options.token
    database.ref( '/management/sites/' + siteName + '/key' )
      .once( 'value', onSiteKeySnapshotSuccess, valueDoesNotExistErrorHandler( callback ) )

    function onSiteKeySnapshotSuccess ( siteKeySnapshot ) {
      var siteKey = siteKeySnapshot.val()
      if ( ! siteKey ) return callback( valueDoesNotExistErrorObject() )
      if ( siteKey !== token ) return callback( tokenNotValidError() )
      callback()
    }

    function tokenNotValidError () {
      return {
        statusCode: 403,
        message: 'Token is not valid.',
      }
    }
  }

  function setSiteVersion ( options, callback ) {
    var siteName = options.siteName
    var timestamp = options.timestamp
    database.ref( '/management/sites/' + siteName + '/version' )
      .set( timestamp, valueDoesNotExistErrorHandler( callback ) )
  }

  function signalBuild ( options, callback ) {
    var siteName = options.siteName
    var branch = options.branch

    var buildSignalOptions = {
      sitename: siteName,
      branch: branch,
      userid: 'admin',
      id: uniqueId(),
    }
    database.ref( '/management/commands/build/' + siteName )
      .set( buildSignalOptions, valueDoesNotExistErrorHandler( callback ) )
  }

  function cloudStorageObjectUpload ( options, callback ) {
    var bucket = options.bucket
    var localFile = options.localFile
    var remoteFile = options.remoteFile
    var cacheControl = options.cacheControl
    var mimeType = options.mimeType

    cloudStorage.objects.upload( bucket, localFile, remoteFile, cacheControl, mimeType, handleObjectUpload )

    function handleObjectUpload ( error, results ) {
      if ( error ) return callback( { statusCode: 500, message: 'Could not upload file.' } )
      return callback( null, results )
    }
  }

  function cloudStorageObjectUploadToUploadsBucket ( options, callback ) {
    cloudStorageObjectUpload( Object.assign( {}, options, { bucket: config.get( 'uploadsBucket' ) } ), callback )
  }

  function cloudStorageObjectUploadToUploadsBucketTimestamped ( options, callback ) {
    cloudStorageObjectUploadToUploadsBucket( Object.assign(
      {},
      options,
      { remoteFile: timestampedUploadsPathForFileName( options.remoteFile ) }
    ), callback )
  }

  // url, callback => error?, resizeUrl?
  function resizeUrlForUrl ( url, callback ) {
    var encodedUrl = encodeURIComponentsForURL( removeProtocolFromURL( url ) )
    console.log( 'encodedUrl' )
    console.log( encodedUrl )
    request( `http://${ config.get('googleProjectId') }.appspot.com/${ encodedUrl  }`, handleResize )

    function handleResize ( error, response, responseBody ) {
      console.log( error )
      console.log( responseBody )
      if ( error ) return callback( { statusCode: 500, message: 'Could not get resize url for file.' } )
      var resizeUrl = ''
      if ( response && response.statusCode === 200 ) resizeUrl = responseBody
      callback( null, resizeUrl )
    }
  }

  function timestampedUploadsPathForFileName ( fileName ) {
    return encodeURIComponentsForURL( `webhook-uploads/${ new Date().getTime() }_${ fileName }` )
  }

  function valueDoesNotExistErrorHandler ( callbackFn ) {
    return function firebaseErrorHandler ( error ) {
      if ( error ) return callbackFn( valueDoesNotExistErrorObject() )
      return callbackFn()
    }
  }

  /**
   * valueDoesNotExistErrorObject
   *
   * An error object to respond to requests for sites
   * that do not exist within the webhook system.
   *
   * All errors objects should have a `statusCode` & `message` key.
   * 
   * @return {object} error
   * @return {number} error.statusCode
   * @return {string} error.message
   */
  function valueDoesNotExistErrorObject () {
    return {
      statusCode: 500,
      message: 'Site does not exist.'
    }
  }

  // Used as the handler for async.series calls within req, res handlers
  function handleResponseForSeries ( res, error ) {
    if ( error ) {
      res.json( error.statusCode, { error: error.message } )
    }
    else {
      res.json( 200, { message: 'Finished' } )
    }
  }
};



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
  var curFile = null;
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

function unescapeSite (site) {
  return site.replace(/,1/g, '.');
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
