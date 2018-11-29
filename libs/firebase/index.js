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


function appForName ( name ) {
  var appOfNameList = admin.apps.filter( appOfName )
  if ( appOfNameList.length === 1 ) return appOfNameList[ 0 ]
  return null

  function appOfName ( app ) {
    return app.name === name
  }
}

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
console.log( this._app.auth().generatePasswordResetLink )
  return this._app.auth().generatePasswordResetLink( userEmail, { url: continuationUrl } )
}

function WebhookSiteKeyDataRemove ( options ) {
  var keyPath = siteDataKeyPath( options )
  return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, null )
}

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

function siteManagementPath ( options ) {
  var base = `management/sites`
  if ( options && options.siteName ) {
    return `${ base }/${ escape( options.siteName ) }`  
  }
  else {
    return base;
  }
}

function usersManagementPath () {
  return `management/users`
}

function siteDataKeyPath ( options ) {
  return `buckets/${ options.siteName }/${ options.siteKey }`
}

function siteDevKeyPath ( options ) {
  return `${ siteDataKeyPath( options ) }/dev`
}
