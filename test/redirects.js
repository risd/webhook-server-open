var testOptions = require( './env-options.js' )()
var webhookTasks = require( '../Gruntfile.js' )
var grunt = require( 'grunt' )
var test = require( 'tape' )

webhookTasks( grunt )

grunt.config.merge( { suppressJobQueue: true } )

var redirector = require( '../libs/redirects.js' ).start( grunt.config, grunt.log )

var redirectsOptions = {
  identifier: `${ testOptions.redirectsSiteName }-redirects`,
  payload: {
    sitename: testOptions.redirectsSiteName,
  }
}

var mockClient = { put: function () {} }

test( 'redirects', function ( t ) {
  t.plan( 1 )

  redirector( redirectsOptions, redirectsOptions.identifier, redirectsOptions.payload, mockClient, redirectsHandler )

  function redirectsHandler ( error ) {
    t.assert( ! error, 'Invited user without error.' )
  }
} )

test.onFinish( process.exit )
