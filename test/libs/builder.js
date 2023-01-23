const config = require('../config')
var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks(grunt)

const buildSite = require( '../../libs/builder.js' ).configure(grunt.config)

test( 'builder', async function (t) {
  t.plan(1)
  try {
    await buildSite(config.builder.buildOptions)
    t.ok(true, 'built site')
  }
  catch (error) {
    console.log(error)
    t.fail(error, 'failed to build site')
  }
})

test.onFinish( process.exit )
