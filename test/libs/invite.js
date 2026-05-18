const config = require('../config')
var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks(grunt)

const inviter = require( '../../libs/invite.js' ).configure(grunt.config)

test( 'builder', async function (t) {
  t.plan(1)
  try {
    console.log(config.invite)
    await inviter(config.invite)
    t.ok(true, 'built site')
  }
  catch (error) {
    console.log(error)
    t.fail(error, 'failed to build site')
  }
})

test.onFinish( process.exit )
