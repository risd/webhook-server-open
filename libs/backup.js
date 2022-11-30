/**
* The backup worker is meant to run as a cron job that runs periodically.
* It downloads the full JSON data from the firebase that contains all the sites
* then uploads it to the backup bucket in google cloud storage. This way we
* have a full backup of all the sites/information/users that we can restore
* if we need to
*/

var request = require( 'request' )
var async = require( 'async' )
var cloudStorage = require( './cloudStorage.js' )
var Firebase = require( './firebase/index.js' )
var _ = require( 'lodash' )


/**
* @params config The configuration from Grunt
* @params logger Logger to use, deprecated, does not actually get used at all
*/
module.exports.start = function (config, logger, callback) {
  if ( typeof callback !== 'function' ) callback = exit;

  // Necessary setup for cloud storage module
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  var self = this;

  var firebase = Firebase( config().firebase )

  var options = {
    backupBucket: config.get( 'backupBucket' ),
    backupTimestamp: Date.now(),
    firebase: config.get( 'firebase' ),
    removeBackup: { timestamp: false, key: false },
  }

  async.series( [
    getCloudStorageToken,    // adds { cloudStorageToken } to options
    getUploadUrl,            // adds { uploadUrl } to options
    createBackup,
    storeBackupTimestampReference,
    checkRemoveOldestBackup, // adds { removeBackupOfTimestamp? } to options
    removeBackupKey,
    removeBackupTimestamp,
  ], callback )

  function getCloudStorageToken ( next ) {
    // We force ourself to get the token first, because we will use it to bypass
    // our cloud storage module, this request is very special so we build it manually
    cloudStorage.getToken( function ( error, token ) {
      if ( error ) return next( error )
      options.cloudStorageToken = token;
      next()
    } )
  }

  function getUploadUrl ( next ) {
    request( {
      url: 'https://www.googleapis.com/upload/storage/v1/b/' + options.backupBucket + '/o',
      qs: { uploadType: 'resumable', 'access_token' : options.cloudStorageToken },
      method: 'POST',
      headers: {
        'X-Upload-Content-Type' : 'application/json',
        'Content-Type' : 'application/json; charset=UTF-8',
      },
      body: JSON.stringify( {
        name: 'backup-' + options.backupTimestamp,
        cacheControl: "no-cache"
      } )
    }, function onComplete ( error, response, body ) {
      if ( error ) return next( error )
      options.uploadUrl = response.headers.location;
      next()
    } )
  }

  function createBackup ( next ) {
    firebase.backupUrl().then( handleBackupUrl )
    
    function handleBackupUrl ( backupUrl ) {
      request.get( backupUrl ).pipe( request.put( options.uploadUrl, next ) )
    }
  }

  // TODO put a test in around this, we changed the underlying .push
  // usage on firebase to not use the callback
  function storeBackupTimestampReference ( next ) {
    firebase.backups( { push: true }, options.backupTimestamp )
      .then((value) => {
        next(null, value)
      })
      .catch((error) => {
        next(error)
      })
  }

  function checkRemoveOldestBackup ( next ) {
    firebase.backups().then( handleBackups ).catch( next )

    function handleBackups ( backupsSnapshot) {
      var backups = backupsSnapshot.val()

      // no backups set
      if ( backups === null ) return next()

      var backupKeys = _.keys( backups )

      if ( backupKeys.length > 30 ) {
        var oldestBackupKey = backupKeys[ 0 ]
        var oldestBackupTimestamp = backups[ oldestBackupKey ]

        options.removeBackup.key = oldestBackupKey;
        options.removeBackup.timestamp = oldestBackupTimestamp;
      }

      next()
    }
  }

  function removeBackupKey ( next ) {
    if ( options.removeBackup.key === false ) return next()
    firebase.backups( { key: options.removeBackup.key }, null )
      .then( next )
      .catch( next )
  }

  function removeBackupTimestamp ( next ) {
    if ( options.removeBackup.timestamp === false ) return next()
    cloudStorage.objects.del( options.backupBucket, 'backup-' + options.removeBackup.timestamp, deleteHandler )

    function deleteHandler ( error ) {
      // if the error is a 204 error, ths means that there was no backup to remove
      if ( error && error === 204 ) return next()
      else if ( error ) return next( error )
      else return next()
    }
  }
}

function exit ( error ) {
  var exitCode = 0
  if ( error ) exitCode = 1
  process.exit( exitCode )
}
