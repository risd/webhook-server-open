var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var siteIndex = require( '../../libs/siteIndex.js' )

test( 'index-site-with-no-data', function ( t ) {
  t.plan( 1 )
  
  var indexer = siteIndex.start( grunt.config, console.log )

  var mockClient = { put: function () {} }

  var indexOptions = {
    identifier: testOptions.siteIndexSiteName,
    payload: {
      userid: testOptions.siteIndexUserId,
      sitename: testOptions.siteIndexSiteName,
    }
  }

  indexer( indexOptions, indexOptions.identifier, indexOptions.payload, mockClient, handleSiteIndex )

  function handleSiteIndex ( error ) {
    t.assert( error, 'Site index completes with error.' )
  }
} )

test.onFinish( process.exit )
