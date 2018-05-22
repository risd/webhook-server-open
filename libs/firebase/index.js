var path = require( 'path' )
var admin = require( 'firebase-admin' )

module.exports = Firebase;

/**
 * Initialize the firebase admin SDK via service account key.
 * 
 * @param  {object}  config
 * @param  {string}  config.name                 The name of the firebase to initialize
 * @param  {string}  config.serviceAccountKey    The service account key for the firebase to initialize
 * @param  {string?} config.initializationName   The name to use when initializing the firebase instance
 * @return {object}  firebase                          The firebase instance that has been initialized.
 */
function Firebase ( config ) {
  if ( ! ( this instanceof Firebase ) ) return new Firebase( config )
  var firebaseName = config.name;
  var firebaseServiceAccountKey = require( `${ process.cwd() }/${ config.serviceAccountKey }` );
  this._secretKey = config.secretKey

  var options = {
    credential: admin.credential.cert( firebaseServiceAccountKey ),
    databaseURL: 'https://' + firebaseName + '.firebaseio.com',
  }

  this._initializationName = config.initializationName || '[DEFAULT]'

  admin.initializeApp( options, this._initializationName )

  this._admin = admin;
}

Firebase.prototype.database = function () {
  return this._admin.database()
}

Firebase.prototype.customToken = function ( uid, callback ) {
  if ( typeof uid === 'function' ) {
    uid = 'default-token'
    callback = uid
  }
  var allowances = { serviceAccount: true }
  this._admin.auth().createCustomToken( uid, allowances )
    .then( function ( customToken ) {
      callback( null, customToken )
    } )
    .catch( function ( error ) {
      callback( error )
    } )
}

Firebase.prototype.idToken = function () {
  return this._secretKey;
}
