var test = require( 'tape' )
var path = require( 'path' )
var grunt = require( 'grunt' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

test( 'firebase-admin', function ( t ) {
  t.plan( 5 )
  
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
} )

test.onFinish( process.exit )