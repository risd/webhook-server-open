var test = require( 'tape' )
var path = require( 'path' )
var grunt = require( 'grunt' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

test( 'firebase-admin', function ( t ) {
  t.plan( 4 )
  
  var firebase = Firebase( grunt.config() )
  t.assert( typeof firebase === 'object', 'Firebase instance is an object.' )

  var db = firebase.database()
  t.assert( typeof db === 'object', 'Firebase database instance is an object.' )

  firebase.token( 'test-token', function ( error, token ) {
    t.assert( error === null, 'Firebase token error is null.' )
    t.assert( typeof token === 'string', 'Firebase token is a string.' )
  } )
} )
