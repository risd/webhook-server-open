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

  
  // cloudStorage.getToken(function(token) {

  //   // This is the upload reuqest, because the file can be so large we use the resumable
  //   // upload API of cloud storage. So first we request a url to upload to.
  //   request({
  //     url: 'https://www.googleapis.com/upload/storage/v1/b/' + options.backupBucket + '/o',
  //     qs: { uploadType: 'resumable', 'access_token' : token },
  //     method: 'POST',
  //     headers: {
  //       'X-Upload-Content-Type' : 'application/json',
  //       'Content-Type' : 'application/json; charset=UTF-8',
  //     },
  //     body: JSON.stringify({
  //       name: 'backup-' + backupTs,
  //       cacheControl: "no-cache"
  //     }) 
  //   }, function(err, res, body) {
  //     var url = res.headers.location;

  //     // The location returned by google is the url to send the file to for upload
  //     // We create a get request to download the data from firebase and pipe it into
  //     // a PUT request to googles cloud url, for effeciency.
  //     request.get('https://' + config.get('firebase') + '.firebaseio.com/.json?auth=' + config.get('firebaseSecret') + '&format=export').pipe(
  //       request.put(url, function(err, res, body) {
  //         // We update the list of backups in firebase
  //         self.root.child('management/backups/').push(backupTs, function() {
  //           // Do cleanup of old backups here, delete ones past 30 days ago
  //           self.root.child('management/backups/').once('value', function(snap) {
  //             var data = snap.val();

  //             var ids = _.keys(data);

  //             if(ids.length > 30) {
  //               var oldestId = ids[0];
  //               var oldestTimestamp = data[oldestId];

  //               self.root.child('management/backups/' + oldestId).remove(function() {
  //                 cloudStorage.objects.del(config.get('backupBucket'), 'backup-' + oldestTimestamp, function() {
  //                   console.log('Done');
  //                   process.exit(0);
  //                 });
  //               });
  //             } else {
  //               console.log('Done');
  //               process.exit(0);
  //             }
  //           });
  //         });
  //       })
  //     );
  //   });
  // });

};

function exit ( error ) {
  var exitCode = 0
  if ( error ) exitCode = 1
  process.exit( exitCode )
}
