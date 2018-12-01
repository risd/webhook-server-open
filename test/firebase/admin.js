var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var path = require( 'path' )
var grunt = require( 'grunt' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

test( 'firebase-admin', function ( t ) {
  t.plan( 9 )
  
  var firebase = Firebase( Object.assign( { initializationName: 'admin-test' }, grunt.config().firebase ) )
  t.assert( typeof firebase === 'object', 'Firebase instance is an object.' )

  var db = firebase.database()
  t.assert( typeof db === 'object', 'Firebase database instance is an object.' )

  var siteKeyPath = `/management/sites/${ testOptions.firebaseAdminSiteName }/key`
  try {
    db.child( siteKeyPath )
    t.fail( 'Should not be able to call `child` on the root database object.' )
  } catch ( error ) {
    t.pass( 'Deprecated: Child must be executed on a database reference, not the root database object.' )
  }

  var siteKeyPathRef = db.ref( siteKeyPath )
  t.assert( siteKeyPathRef.key === 'key', 'Ref has correct key.' )

  siteKeyPathRef.once( 'value', function ( siteKeySnapshot ) {
    var siteKey = siteKeySnapshot.val()
    t.assert( typeof siteKey === 'string' || siteKey === null, 'The site key value is a string.' )
    t.assert( siteKeySnapshot.key === 'key', 'The key of the snapshot is the last part of the path to get the snapshot.' )
    try {
      var keyValueforSnapshot = siteKeySnapshot.name()
    } catch ( error ) {
      t.pass( 'Deprecated: `name` is no longer a function to access the key.' )
    }

    try {
      var keyValueforSnapshot = siteKeySnapshot.key()
    } catch ( error ) {
      t.pass( 'Deprecated: `key` is no longer a function, instead, a property getter.' )
    }
  } )

  db.ref( '/buckets/site-does-not-exist' ).set( null )
    .then( handleNonExistentKeySetSuccess )
    .catch( handleNonExistentKeySetError )

  function handleNonExistentKeySetSuccess () {
    t.pass( 'Setting a non-existent key path to null completes successfully.' )
  }

  function handleNonExistentKeySetError () {
    t.fail( 'Setting a non-existent key path to null errors.' )
  }
} )

test.onFinish( process.exit )