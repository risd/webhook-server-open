var testOptions = require( './env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var creator = require( '../libs/creator.js' )
var Firebase = require( '../libs/firebase/index.js' )
var webhookTasks = require( '../Gruntfile.js' )

var firebaseEscape = require( '../libs/utils/firebase-escape.js' )

webhookTasks( grunt )

grunt.config.merge( { suppressJobQueue: true } )

var firebase = Firebase( grunt.config.get( 'firebase' ) )

// test( 'add-owner', function ( t ) {
//   /* Add owner is a task that is accomplished by the `wh create` command
//      in anticipation of submitting the signal command to create the site. */
//   t.plan( 1 )

//   var ownerData = {}
//   ownerData[ firebaseEscape( testOptions.createUserId ) ] = testOptions.createUserId

//   firebase.database()
//     .ref( `management/sites/${ testOptions.createSiteName }/owners` )
//     .set( ownerData, onOwnerAdded )

//   function  onOwnerAdded ( error ) {
//     t.assert( error === null, 'Added site owner without error.' )
//   }
// } ) 

// test( 'create-site', function ( t ) {
//   t.plan( 1 )

//   var command = {
//     identifier: testOptions.createSiteName,
//     payload: {
//       userid: testOptions.createUserId,
//       sitename: testOptions.createSiteName,
//     }
//   }

//   var mockClient = { put: function () {} }

//   var create = creator.start( grunt.config, console.log )

//   create( command, command.identifier, command.payload, mockClient, jobCallback )
  
//   function jobCallback ( error ) {
//     t.assert( error === undefined, 'Create completed without error.' )
//   }

// } )

// test( 'set-bad-data', function ( t ) {
//   t.plan( 2 )

//   firebase.database().ref( 'new-key' ).set( {}, function ( error ) {
//     console.log( 'callback-error' )
//     console.log( error )
//     t.assert( error, 'Firebase throws error when setting a key that should not be set.' )
//   } )

//   firebase.database().ref( 'new-key' ).set( {} )
//     .then( function () {
//       t.fail( 'Promise success should not be reached.' )
//     } )
//     .catch( function ( error ) {
//       console.log( 'promise-error' )
//       console.log( 'error' )
//       t.asssert(  error, 'Firebase throws error when setting a bad key' )
//     } )
// } )

test( 'check-version', function ( t ) {
  t.plan( 1 )
  console.log( firebase.database().SDK_VERSION )
  t.assert( firebase.SDK_VERSION !== firebase.database().SDK_VERSION, 'Database & admin version should be different.' )
} )
