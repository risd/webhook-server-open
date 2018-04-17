var testOptions = require( './env-options.js' )()

var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'update-redirects', function ( t ) {
  t.plan( 2 )

  var cdn = fastlyWebhook( grunt.config().fastly )

  var options = {
    host: testOptions.fastlyAddDomain,
    redirects: [
      { pattern: '/short/', destination: '/much/longer/' },
      { pattern: '/sm/', destination: '/x/l' },
      { pattern: '^/regular/.', destination: '/supes-norm/' },
    ]
  }

  cdn.redirects( options, function ( error, result ) {
    t.ok( error === null, 'The error should be undefined.' )
    t.ok( typeof result === 'object', 'The result should be represented by an object.' )
  } )

} )
