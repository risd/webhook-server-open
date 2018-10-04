var path = require( 'path' )
var admin = require( 'firebase-admin' )

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
