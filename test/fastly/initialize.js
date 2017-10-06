var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'cdn-service-initialize', function ( t ) {
  t.plan( 2 )

  var cdn = fastlyWebhook( grunt.config().fastly )

  cdn.initialize( function ( error, service ) {
    console.log( error )
    t.ok( error === null, 'The error should be null.' )
    t.ok( typeof service === 'object', 'The service should be represented by an object.' )
  } )

} )
