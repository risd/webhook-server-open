var testOptions = require( '../env-options.js' )()
var grunt = require( 'grunt' )
var async = require( 'async' )
var test = require( 'tape' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks(grunt)

var deleteSite = require( '../../libs/delete.js' )

var siteName = testOptions.createSiteName;

test( 'delete-site', function ( t ) {
  t.plan( 1 )

  var deletor = deleteSite(grunt.config())
  
  deletor.delete( siteName )
    .then( handleDelete )
    .catch( handleDeleteError )
  
  function handleDelete () {
    t.pass( `Successfully deleted site ${ siteName }.` )
  }

  function handleDeleteError ( error ) {
    t.fail( `Could not delete site ${ siteName }.` )
  }

} )

test.onFinish( process.exit )
