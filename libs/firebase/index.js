var path = require( 'path' )
var request = require( 'request-promise-native' )
var admin = require( 'firebase-admin' )
var getAccessToken = require( './access-token.js' )

var unescape = require( '../utils/firebase-unescape.js' )
var escape = require( '../utils/firebase-escape.js' )

var continuationUrlFn = require( '../../src/firebase-auth-continuation-url.js' )

module.exports = WHFirebase;

/**
 * Initialize the firebase admin SDK via service account key.
 * 
 * @param  {object}  config
 * @param  {string}  config.name                 The name of the firebase to initialize
 * @param  {string}  config.serviceAccountKey    The service account key for the firebase to initialize
 * @param  {string?} config.initializationName   The name to use when initializing the firebase instance
 * @return {object}  firebase                          The firebase instance that has been initialized.
 */
function WHFirebase ( config ) {
  if ( ! ( this instanceof WHFirebase ) ) return new WHFirebase( config )
  var firebaseName = config.name;
  this._firebaseName = firebaseName;
  var firebaseServiceAccountKey = require( `${ process.cwd() }/${ config.serviceAccountKey }` );

  var options = {
    credential: admin.credential.cert( firebaseServiceAccountKey ),
    databaseURL: 'https://' + firebaseName + '.firebaseio.com',
  }

  this._initializationName = config.initializationName || '[DEFAULT]'

  this._app = appForName( this._initializationName )
  if ( ! this._app ) {
    this._app = admin.initializeApp( options, this._initializationName )
  }

  this._getAccessToken = getAccessToken.bind( this, firebaseServiceAccountKey )
}

WHFirebase.prototype.database = function () {
  return this._app.database()
}

WHFirebase.prototype.siteKey = WebhookSiteKey;
WHFirebase.prototype.siteDevData = WebhookSiteDevData;
// requires admin sdk + service account
WHFirebase.prototype.allSites = WebhookSites;
WHFirebase.prototype.removeSiteKeyData = WebhookSiteKeyDataRemove;
WHFirebase.prototype.allUsers = WebhookUsers;
WHFirebase.prototype.resetUserPasswordLink = WebhookUserPasswordResetLink;
WHFirebase.prototype.deleteSite = WebhookSiteDelete;
WHFirebase.prototype.backupUrl = WebhookSiteBackupURL;
WHFirebase.prototype.backups = WebhookBackups;
WHFirebase.prototype.siteRedirects = WebhookSiteRedirects;

// helper - for initialization

function appForName ( name ) {
  var appOfNameList = admin.apps.filter( appOfName )
  if ( appOfNameList.length === 1 ) return appOfNameList[ 0 ]
  return null

  function appOfName ( app ) {
    return app.name === name
  }
}

// methods for interacting with webhook data

function WebhookSiteKey ( options, siteKey ) {
  var keyPath = `${ siteManagementPath( options ) }/key`
  if ( siteKey ) {
    // set
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, siteKey )
  }
  else {
    // get
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
}

function WebhookSiteDevData ( options, siteData ) {
  var keyPath = siteDevKeyPath( options )
  var setMethod = appropriateSetMethod( siteData )
  if ( setMethod && setMethod.sdk  ) {
    // set via sdk
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, siteData )
  }
  else if ( setMethod && setMethod.rest ) {
    // set via rest
    return firebaseDatabaseSetLargeValueForKeyPath.call( this, keyPath, siteData )
  }
  else if ( setMethod ) {
    return Promise.reject( new Error( 'File is too big to set.' ) )
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )  
  }

  function appropriateSetMethod ( siteData ) {
    if ( ! siteData ) return false;
    var dataSize = sizeOf( siteData )

    // sizes defined: https://firebase.google.com/docs/database/usage/limits#writes
    return {
      sdk: fitsInSDK( dataSize ),
      rest: fitsInREST( dataSize ),
    }
  }

  function fitsInSDK ( dataSize ) {
    var maxSDKSize = 16 * 1024 * 1024; // 16MB
    return dataSize <= maxSDKSize
  }

  function fitsInREST ( dataSize ) {
    var maxRESTSize = 256 * 1024 * 1024; // 256MB
    return dataSize <= maxRESTSize;
  }

  function sizeOf ( data ) {
    return Buffer( JSON.stringify( data ) ).length
  }
}

function WebhookSites () {
  var keyPath = siteManagementPath()
  return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
}

function WebhookUsers () {
  var keyPath = usersManagementPath()
  return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
}

function WebhookUserPasswordResetLink ( options ) {
  var userEmail = unescape( options.userEmail )

  // options : { siteName : string, userEmail : string } => continuationUrl : string
  var continuationUrl = continuationUrlFn( options )
  return this._app.auth().generatePasswordResetLink( userEmail, { url: continuationUrl } )
}

function WebhookSiteKeyDataRemove ( options ) {
  var keyPath = siteDataKeyPath( options )
  return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, null )
}

function WebhookSiteDelete ( options ) {
  var self = this;
  var deleteSite = options.siteName;

  // delete management path
  // delete billing path
  // delete bucket path
  var deleteKeyPaths = [
    siteManagementPath( options ),
    siteBilling( options ),
    siteBucketKeyPath( options ),
  ]

  // delete user references ( /management/users )
  // allUsers => users => usersSites => deleteKeyPathPromises
  return this.allUsers()
    .then( getUserSites )
    .then( returnDeletePromises )

  function returnDeletePromises ( usersSites ) {
    var deletePromises = usersSites
      .filter( includesSiteToDelete )
      .map( usersManagementPath )
        .concat( deleteKeyPaths )
          .map( setKeyPathToNull )

    return admin.Promise.all( deletePromises )
  }

  function includesSiteToDelete ( userSite ) {
    return unescape( userSite.siteName ) === unescape( deleteSite )
  }

  function setKeyPathToNull ( keyPath ) {
    return firebaseDatabaseSetValueForKeyPath( self._app, keyPath, null )
  }

  function getUserSites ( usersSnapshot ) {
    var users = usersSnapshot.val()
    var usersSites = []
    var userKeys = Object.keys( users )
    for (var i = userKeys.length - 1; i >= 0; i--) {
      var userKey = userKeys[ i ]
      var userData = users[ userKey ]
      if ( ! userData.sites ) continue;
      var siteKeys = Object.keys( userData.sites )
      for (var j = siteKeys.length - 1; j >= 0; j--) {
        var siteKey = siteKeys[ j ]
        var siteData = users[ userKey ].sites[ siteKey ]
        if ( siteData ) {
          var usersSitesKeys = Object.keys( siteData )
          for (var k = 0; k < usersSitesKeys.length; k++) {
            var userSite = usersSitesKeys[ k ]
            usersSites.push( {
              userEmail: unescape( userKey),
              siteName: unescape( userSite ),
              owner: siteKey === 'owners',
              user: siteKey === 'users'
            } )
          }
        }
      }
    }

    return admin.Promise.resolve( usersSites )
  }
}

function WebhookBackups ( options, value, pushCallback ) {
  var keyPath = backupManagementPath( options )
  if ( options && options.key && value === null ) {
    // set, remove backup key
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, value )
  }
  else if ( options && options.push && value && pushCallback ) {
    // set, push key
    return firebaseDatabasePushValueForKeyPath( this._app, keyPath, value, pushCallback )
  }
  else if ( options && options.key && typeof value === 'undefined' ) {
    // get, backup timestamp
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
  else if ( typeof options === 'undefined' && typeof value === 'undefined' ) {
    // get all backup keys
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
  else {
    return this._app.Promise.reject( new Error( 'Could not return a promise for options proivded to WebhookBackups.' ) )
  }
}

function WebhookSiteBackupURL () {
  var uri = `https://${ this._firebaseName }.firebaseio.com/.json?format=export`
  return this._getAccessToken().then( urlForToken )

  function urlForToken ( token ) {
    uri += `&access_token=${ token }`
    return Promise.resolve( uri )
  }
}

function WebhookSiteRedirects ( options, value ) {
  var keyPath = siteRedirectPath( options )
  if ( typeof value !== 'undefined' ) {
    firebaseDatabaseSetValueForKeyPath( this._app, keyPath, value )
  }
  else {
    firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
}

// helpers - interfaces into data

function firebaseDatabaseSetValueForKeyPath ( firebase, keyPath, value ) {
  return firebase.database().ref( keyPath ).set( value )
}

function firebaseDatabaseSetLargeValueForKeyPath ( keyPath, value ) {
  var uri = `https://${ this._firebaseName }.firebaseio.com/${ keyPath }.json`
  return this._getAccessToken()
    .then( function ( token ) {
        uri += `?access_token=${ token }`
        var putOptions = {
          method: 'PUT',
          uri: uri,
          body: value,
          json: true,
        }
        return request.put( putOptions )
    } )
}

function firebaseDatabaseOnceValueForKeyPath ( firebase, keyPath ) {
  return firebase.database().ref( keyPath ).once( 'value' )
}

function firebaseDatabasePushValueForKeyPath ( firebase, keyPath, value, callback ) {
  return firebase.database().ref( keyPath ).push( value, callback )
}

// helpers - construct paths

function backupManagementPath ( options ) {
  var base = `management/backups`
  if ( options && options.key ) {
    return `${ base }/${ options.key }`
  }
  else {
    return base;
  }
}

function siteManagementPath ( options ) {
  var base = `management/sites`
  if ( options && options.siteName ) {
    return `${ base }/${ escape( options.siteName ) }`  
  }
  else {
    return base;
  }
}

function usersManagementPath ( options ) {
  var base = `management/users`
  if ( options && options.userEmail && options.owner && options.siteName ) {
    return `${ base }/${ escape( options.userEmail ) }/sites/owners/${ escape( options.siteName ) }`
  }
  if ( options && options.userEmail && options.user && options.siteName ) {
    return `${ base }/${ escape( options.userEmail ) }/sites/users/${ escape( options.siteName ) }`
  }
  if ( options && options.userEmail ) {
    return `${ base }/${ escape( options.userEmail ) }`
  }
  else {
    return base;
  }
}

function siteBucketKeyPath ( options ) {
  return `buckets/${ escape( options.siteName ) }`
}

function siteDataKeyPath ( options ) {
  return `${ siteBucketKeyPath( options ) }/${ options.siteKey }`
}

function siteDevKeyPath ( options ) {
  return `${ siteDataKeyPath( options ) }/dev`
}

function siteRedirectPath ( options ) {
  return `${ siteDevKeyPath( options ) }/settings/redirect`
}

function siteBilling ( options ) {
  return `billing/sites/${ escape( options.siteName ) }`
}
