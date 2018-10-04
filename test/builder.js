var testOptions = require( './env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )

webhookTasks( grunt )

var builder = require( '../libs/builder.js' )
var webhookTasks = require( '../Gruntfile.js' )

grunt.config.merge( { suppressJobQueue: true } )

test( 'builder', function ( t ) {
  t.plan( 1 )

  var command = {
    identifier: `${testOptions.buildSiteName}_${testOptions.buildBucketName}`,
    payload: {
      userid: testOptions.buildUserId,
      sitename: testOptions.buildSiteName,
      siteBucket: testOptions.buildBucketName,
      branch: testOptions.buildDeployBranch,
    }
  }

  var mockClient = { put: function () {} }

  var build = builder.start( grunt.config, console.log )

  build( command, command.identifier, command.payload, mockClient, jobCallback )
  
  function jobCallback ( error ) {
    t.assert( error === undefined, 'Build completed without error.' )
  }

} )
