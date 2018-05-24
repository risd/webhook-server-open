var testOptions = require( './env-options.js' )()

var test = require( 'tape' )
var grunt = require( 'grunt' )
var async = require( 'async' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'remove-domain', function ( t ) {
  t.plan( 6 )

  var cdn = fastlyWebhook( grunt.config().fastly )

  async.series( [ removeDomain, doNotRemoveDomain, removeDomainEdu ], function () {} )

  function removeDomain ( next ) {
    cdn.removeDomain( testOptions.fastlyAddDomain, function ( error, service ) {
      t.ok( error === null, 'The error should be undefined.' )
      t.ok( typeof service === 'object' && service.hasOwnProperty( 'service_id' ), 'The service should be represented by an object.' )
      next()
    } )
  }

  function doNotRemoveDomain ( next ) {
    cdn.removeDomain( 'test.risd.systems', function ( error, service ) {
      t.ok( error === null, 'The error object should be null for successfully not removing a domain.' )
      t.ok( typeof service === 'object' && service.hasOwnProperty( 'noDomainsRemoved' ) && service.noDomainsRemoved === true, 'Response should include a flag that no domains were removed.' )
      next()
    } )
  }

  function removeDomainEdu ( next ) {
    cdn.removeDomain( 'test.risd.edu', function ( error, service ) {
      t.ok( error === null, 'The error object should be null for successful domain removal.' )
      t.ok( typeof service === 'object' && service.hasOwnProperty( 'service_id' ), 'The service should be represented by an object for edu domain.' )
      next()
    } )
  }
} )
