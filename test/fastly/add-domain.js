var testOptions = require( './env-options.js' )()

var test = require( 'tape' )
var grunt = require( 'grunt' )
var async = require( 'async' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'add-domain', function ( t ) {
  t.plan( 6 )

  var cdn = fastlyWebhook( grunt.config().fastly )

  async.series( [ addDomain, doNotAddDomain, addDomainEdu ], function () {} )

  function addDomain ( next ) {
    cdn.domain( testOptions.fastlyAddDomain, function ( error, service ) {
      t.ok( error === null, 'The error should be null for successful domain addition.' )
      t.ok( typeof service === 'object' && service.hasOwnProperty( 'service_id' ), 'The service should be represented by an object.' )
      next()
    } )
  }

  function doNotAddDomain ( next ) {
    cdn.domain( 'test.risd.systems', function ( error, service ) {
      t.ok( error === null, 'The error object should be null for successfully not adding a domain.' )
      t.ok( typeof service === 'object' && service.hasOwnProperty( 'noDomainsAdded' ) && service.noDomainsAdded === true, 'Response should include a flag that no domains were addded.' )
      next()
    } )
  }
 
  function addDomainEdu ( next ) {
    cdn.domain( 'test.risd.edu', function ( error, service ) {
      t.ok( error === null, 'The error object should be null for successful domain addition.' )
      t.ok( typeof service === 'object' && service.hasOwnProperty( 'service_id' ), 'The service should be represented by an object for edu domain.' )
      next()
    } )
  }
} )
