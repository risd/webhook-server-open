var testOptions = require( '../env-options.js' )()

var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

var cdn = fastlyWebhook( grunt.config().fastly )
var mapOptions = { maskDomain: testOptions.fastlyMapDomainKey, contentDomain: testOptions.fastlyMapDomainValue }

test( 'map-domain', function ( t ) {
  t.plan( 2 )

  cdn.mapDomain( mapOptions, function ( error, status ) {
    t.ok( error === null, 'The add error should be null.' )
    t.ok( typeof status === 'object', 'The add status should be represented by an object.' )
  } )
} )

test( 'get-mask-domain-for-content-domain', function ( t ) {
  t.plan( 2 )

  cdn.maskForContentDomain( mapOptions.contentDomain, function ( error, maskDomain ) {
    t.ok( error === null, 'The mask domain getter error should be null.' )
    t.ok( maskDomain === mapOptions.maskDomain, 'The maskDomain should be equal to its input.' )
  } )
} )

test( 'remove-map-domain', function ( t ) {
  t.plan( 2 )

  cdn.removeMapDomain( mapOptions, function ( error, status ) {
    t.ok( error === null, 'The remove error should be null.' )
    t.ok( typeof status === 'object', 'The remove status should be represented by an object.' )
  } )
} )