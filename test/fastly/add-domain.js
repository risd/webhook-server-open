var testOptions = require( './env-options.js' )()

var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'add-domain', function ( t ) {
  t.plan( 2 )

  var cdn = fastlyWebhook( grunt.config().fastly )

  cdn.domain( testOptions.fastlyAddDomain, function ( error, service ) {
    t.ok( error === null, 'The error should be undefined.' )
    t.ok( typeof service === 'object', 'The service should be represented by an object.' )
  } )

} )
