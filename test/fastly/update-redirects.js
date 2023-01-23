const config = require('../config.js')

var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'update-redirects', async function ( t ) {
  var cdn = fastlyWebhook( grunt.config().fastly )

  var options = {
    host: config.fastly.addDomain,
    redirects: [
      { pattern: '/short/', destination: '/much/longer/' },
      { pattern: '/sm/', destination: '/x/l' },
      { pattern: '^/regular/.', destination: '/supes-norm/' },
    ]
  }

  try {
    await cdn.redirects(options)
    t.ok(true, 'Succesfully set fastly redirects')
  }
  catch (error) {
    t.fail(error, 'Error in setting fastly redirects')
  }
  finally {
    t.end()
  }
} )
