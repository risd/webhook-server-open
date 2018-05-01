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
  this.root = firebase.database()

  var options = {
    backupBucket: config.get( 'backupBucket' ),
    backupTimestamp: Date.now(),
    firebase: config.get( 'firebase' ),
    removeBackup: { timestamp: false, id: false },
  }

  async.series( [
    getCloudStorageToken,    // adds { cloudStorageToken } to options
    getUploadUrl,            // adds { uploadUrl } to options
    createBackup,
    storeBackupTimestampReference,
    checkRemoveOldestBackup, // adds { removeBackupOfTimestamp? } to options
    removeBackupId,
    removeBackupTimestamp,
  ], callback )

  function getCloudStorageToken ( next ) {
    // We force ourself to get the token first, because we will use it to bypass
    // our cloud storage module, this request is very special so we build it manually
    cloudStorage.getToken( function ( token ) {
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
      options.uploadUrl = response.headers.location;
      next()
    } )
  }

  function createBackup ( next ) {
    var url = `https://${ options.firebase.name }.firebaseio.com/.json?auth=${ options.firebase.secretKey }&format=export`
    request.get( url ).pipe( request.put( options.uploadUrl, next ) )
  }

  function storeBackupTimestampReference ( next ) {
    self.root.ref( 'management/backups/' ).push( options.backupTimestamp, next )
  }

  function checkRemoveOldestBackup ( next ) {
    self.root.ref( 'management/backups/' ).once( 'value', function( snapshot ) {
      var data = snapshot.val()

      var ids = _.keys( data )

      if( ids.length > 30 ) {
        var oldestId = ids[ 0 ]
        var oldestTimestamp = data[ oldestId ]

        options.removeBackup.id = oldestId;
        options.removeBackup.timestamp = oldestTimestamp;
      }

      next()
    } )
  }

  function removeBackupId ( next ) {
    if ( options.removeBackup.id === false ) return next()
    self.root.ref( 'management/backups/' + options.removeBackup.id ).remove( next )
  }

  function removeBackupTimestamp ( next ) {
    if ( options.removeBackup.timestamp === false ) return next()
    cloudStorage.objects.del( options.backupBucket, 'backup-' + options.removeBackup.timestamp, next )
  }
}

function exit ( error ) {
  var exitCode = 0
  if ( error ) exitCode = 1
  process.exit( exitCode )
}
