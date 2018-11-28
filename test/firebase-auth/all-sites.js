var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

test( 'firebase-all-sites', function ( t ) {
  t.plan( 1 )
  
  var firebase = Firebase( Object.assign( { initializationName: 'admin-test' }, grunt.config().firebase ) )
  
  firebase.allSites()
    .then( handleSnapshot )
    .catch( handleError )

  function handleSnapshot ( allSitesSnapshot ) {
    var allSites = allSitesSnapshot.val()
    t.assert( allSites !== null && typeof allSites === 'object', 'All sites found.' )
  }

  function handleError ( error ) {
    t.fail( error )
  }
} )

test.onFinish( process.exit )
