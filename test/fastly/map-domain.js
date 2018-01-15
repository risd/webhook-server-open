var testOptions = require( './env-options.js' )()

var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'map-domain', function ( t ) {
  t.plan( 4 )

  var cdn = fastlyWebhook( grunt.config().fastly )
  var mapOptions = { maskDomain: process.env.FASTLY_MAP_DOMAIN_KEY, contentDomain: process.env.FASTLY_MAP_DOMAIN_VALUE }

  cdn.mapDomain( mapOptions, function ( error, status ) {
    t.ok( error === null, 'The add error should be undefined.' )
    t.ok( typeof status === 'object', 'The add status should be represented by an object.' )

    cdn.removeMapDomain( mapOptions, function ( error, status ) {
      t.ok( error === null, 'The remove error should be undefined.' )
      t.ok( typeof status === 'object', 'The remove status should be represented by an object.' )
    } )
  } )
} )
