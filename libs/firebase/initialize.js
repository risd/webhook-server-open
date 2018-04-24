var path = require( 'path' )
var admin = require( 'firebase-admin' )

module.exports = initialize;

/**
 * Initialize the firebase admin SDK via service account key.
 * 
 * @param  {object} config
 * @param  {object} config.firebase                   The name of the firebase to initialize
 * @param  {object} config.firebaseServiceAccountKey  The service account key for the firebase to initialize
 * @return {object} firebase                          The firebase instance that has been initialized.
 */
function initialize ( config ) {
  var firebaseName = config.firebase;
  var firebaseServiceAccountKey = require( path.join( __dirname, '..', '..', config.firebaseServiceAccountKey ) );

  var options = {
    credential: admin.credential.cert( firebaseServiceAccountKey ),
    databaseURL: 'https://' + firebaseName + '.firebaseio.com',
  }

  admin.initializeApp( options )

  return admin.database()
}
