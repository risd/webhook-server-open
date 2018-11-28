var path = require( 'path' )
var admin = require( 'firebase-admin' )

var continuationUrlFn = require( './auth-continuation-url.js' )
var unescape = require( '../utils/firebase-unescape.js' )
var escape = require( '../utils/firebase-escape.js' )


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
  var firebaseServiceAccountKey = require( `${ process.cwd() }/${ config.serviceAccountKey }` );
  this._secretKey = config.secretKey

  var options = {
    credential: admin.credential.cert( firebaseServiceAccountKey ),
    databaseURL: 'https://' + firebaseName + '.firebaseio.com',
  }

  this._initializationName = config.initializationName || '[DEFAULT]'

  this._app = appForName( this._initializationName )
  if ( ! this._app ) {
    this._app = admin.initializeApp( options, this._initializationName )
  }

  function appForName ( name ) {
    var appOfNameList = admin.apps.filter( appOfName )
    if ( appOfNameList.length === 1 ) return appOfNameList[ 0 ]
    return null

    function appOfName ( app ) {
      return app.name === name
    }
  }
}

WHFirebase.prototype.database = function () {
  return this._app.database()
}

WHFirebase.prototype.customToken = function ( uid, callback ) {
  if ( typeof uid === 'function' ) {
    uid = 'default-token'
    callback = uid
  }
  var allowances = { serviceAccount: true }
  this._app.auth().createCustomToken( uid, allowances )
    .then( function ( customToken ) {
      callback( null, customToken )
    } )
    .catch( function ( error ) {
      callback( error )
    } )
}

WHFirebase.prototype.idToken = function () {
  return this._secretKey;
}

WHFirebase.prototype.siteKey = WebhookSiteKey;
WHFirebase.prototype.siteDevData = WebhookSiteDevData;
// requires admin sdk + service account
WHFirebase.prototype.allSites = WebhookSites;
WHFirebase.prototype.removeSiteKeyData = WebhookSiteKeyDataRemove;
WHFirebase.prototype.allUsers = WebhookUsers;
WHFirebase.prototype.resetUserPassword = WebhookUserPasswordReset;

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
  if ( siteData ) {
    // set
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, siteData )
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )  
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

function WebhookUserPasswordReset ( options ) {
  var userEmail = unescape( options.userEmail )

  // options : { siteName : string, userEmail : string } => continuationUrl : string
  var continuationUrl = continuationUrlFn( options )

  return this._app.auth().sendPasswordResetEmail( userEmail, { url: continuationUrl } )
}

function WebhookSiteKeyDataRemove ( options ) {
  var keyPath = siteDataKeyPath( options )
  return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, null )
}

function firebaseDatabaseSetValueForKeyPath ( firebase, keyPath, value ) {
  return firebase.database().ref( keyPath ).set( value )
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
