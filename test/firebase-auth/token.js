var test = require( 'tape' )
var grunt = require( 'grunt' )
var Firebase = require( 'firebase' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var firebaseName = grunt.config().firebase;
var firebaseToken = grunt.config().firebaseSecret;

var firebase = new Firebase( 'https://' + firebaseName + '.firebaseio.com' )

test( 'firebase-token-auth', function ( t ) {
  t.plan( 2 )
  firebase.auth( firebaseToken, function ( error, authentication ) {
    t.assert( error === null, 'No error' )
    t.assert( typeof authentication === 'object', 'Token is valid' )
  } )
} )
