var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var Mailgun = require( 'mailgun-js' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var resetSiteKeys = require( '../../libs/firebase/reset-site-keys' )
var resetUserPasswords = require( '../../libs/firebase/reset-user-passwords' )

var firebase = Firebase( Object.assign( { initializationName: 'admin-test' }, grunt.config().firebase ) )
var mailgun = new Mailgun( { apiKey: grunt.config().mailgunKey, domain: grunt.config().mailgunDomain } )
var fromEmail = grunt.config().fromEmail;

Error.stackTraceLimit = Infinity;

// test( 'firebase-reset-site-keys', function ( t ) {
//   t.plan( 3 )
  
//   resetSiteKeys( { firebase: firebase }, handleResetKeys )

//   function handleResetKeys ( error, siteNamesKeys ) {
//     t.assert( error === null, 'Finish without error' )
//     t.assert( Array.isArray( siteNamesKeys ), 'Site name keys is an array' )
//     t.assert( allSitesUpdated( siteNamesKeys ), 'All site keys updated' )
//   }

//   function allSitesUpdated ( siteNamesKeys ) {
//     return siteNamesKeys.length === siteNamesKeys.filter( updated  ).length
//   }

//   function updated ( siteNameKeys ) {
//     return successfullyMigrated( siteNameKeys ) || noCurrentSiteKey( siteNameKeys )
//   }

//   function successfullyMigrated ( siteNameKeys ) {
//     return ( siteNameKeys.migratedData === true &&
//             siteNameKeys.removedOldData === true &&
//             siteNameKeys.newSiteKeySet === true )
//   }

//   function noCurrentSiteKey ( siteNameKeys ) {
//     return siteNameKeys.currentSiteKey === undefined
//   }
// } )

// test( 'firebase-reset-user-passwords', function ( t ) {
//   t.plan( 1 )

//   resetUserPasswords( { firebase: firebase, mailgun: mailgun, fromEmail, fromEmail }, handePasswordReset )

//   function handePasswordReset ( error ) {
//     t.assert( ! error, 'Finished without error' )
//   }

// } )

test.onFinish( process.exit )
