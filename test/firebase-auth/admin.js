var test = require( 'tape' )
var path = require( 'path' )
var grunt = require( 'grunt' )
var firebaseInitialize = require( path.join( '..', '..', 'libs', 'firebase', 'initialize.js' ) )
var webhookTasks = require( path.join( '..', '..', 'Gruntfile.js' ) )

webhookTasks( grunt )

test( 'firebase-admin-initialize', function ( t ) {
  t.plan( 1 )
  var firebase = firebaseInitialize( grunt.config() )
  t.assert( typeof firebase === 'object', 'Firebase instance is an object.' )
} )
