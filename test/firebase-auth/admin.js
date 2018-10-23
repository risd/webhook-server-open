var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var path = require( 'path' )
var grunt = require( 'grunt' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

test( 'firebase-admin', function ( t ) {
  t.plan( 11 )
  
  var firebase = Firebase( Object.assign( { initializationName: 'admin-test' }, grunt.config().firebase ) )
  t.assert( typeof firebase === 'object', 'Firebase instance is an object.' )

  var db = firebase.database()
  t.assert( typeof db === 'object', 'Firebase database instance is an object.' )

  firebase.customToken( 'test-custom-token', function ( error, token ) {
    t.assert( error === null, 'Firebase custom token error is null.' )
    t.assert( typeof token === 'string', 'Firebase custom token is a string.' )
  } )

  var sercreKey = firebase.idToken()
  t.assert( typeof sercreKey === 'string', 'Firebase sercre key is a string.' )

  var siteKeyPath = `/management/sites/${ testOptions.firebaseAdminSiteName }/key`
  try {
    db.child( siteKeyPath )
  } catch ( error ) {
    t.assert( error, 'Deprecated: Child must be executed on a database reference, not the root database object.' )
  }

  var siteKeyPathRef = db.ref( siteKeyPath )
  t.assert( siteKeyPathRef.key === 'key', 'Ref has correct key.' )

  siteKeyPathRef.once( 'value', function ( siteKeySnapshot ) {
    var siteKey = siteKeySnapshot.val()
    t.assert( typeof siteKey === 'string', 'The site key value is a string.' )
    t.assert( siteKeySnapshot.key === 'key', 'The key of the snapshot is the last part of the path to get the snapshot.' )
    try {
      var keyValueforSnapshot = siteKeySnapshot.name()
    } catch ( error ) {
      t.assert( error, 'Deprecated: `name` is no longer a function to access the key.' )
    }

    try {
      var keyValueforSnapshot = siteKeySnapshot.key()
    } catch ( error ) {
      t.assert( error, 'Deprecated: `key` is no longer a function, instead, a property getter.' )
    }
  } )
} )

test.onFinish( process.exit )