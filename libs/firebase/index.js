var path = require( 'path' )
var admin = require( 'firebase-admin' )

module.exports = Firebase;

/**
 * Initialize the firebase admin SDK via service account key.
 * 
 * @param  {object} config
 * @param  {object} config.firebase                   The name of the firebase to initialize
 * @param  {object} config.firebaseServiceAccountKey  The service account key for the firebase to initialize
 * @return {object} firebase                          The firebase instance that has been initialized.
 */
function Firebase ( config ) {
  if ( ! ( this instanceof Firebase ) ) return new Firebase( config )
  var firebaseName = config.firebase;
  var firebaseServiceAccountKey = require( path.join( __dirname, '..', '..', config.firebaseServiceAccountKey ) );

  var options = {
    credential: admin.credential.cert( firebaseServiceAccountKey ),
    databaseURL: 'https://' + firebaseName + '.firebaseio.com',
  }

  admin.initializeApp( options )

  this.admin = admin;
}

Firebase.prototype.database = function () {
  return this.admin.database()
}

Firebase.prototype.token = function ( uid, callback ) {
  if ( typeof uid === 'function' ) {
    uid = 'default-token'
    callback = uid
  }
  this.admin.auth().createCustomToken( uid )
    .then( function ( customToken ) {
      callback( null, customToken )
    } )
    .catch( function ( error ) {
      callback( error )
    } )
}
