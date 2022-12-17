const test = require( 'tape' )
const grunt = require( 'grunt' )
const webhookTasks = require( '../../Gruntfile.js' )

webhookTasks(grunt)

const backup = require( '../../libs/backup.js' )

test('backup', async function (t) {
  t.plan(1)
  try {
    const { file, timestamp } = await backup.start(grunt.config)
    t.ok(true, 'successfully ran firebase backup')
  }
  catch (error) {
    console.log(error)
    t.fail(error, 'failed to backup')
  }
})

test.onFinish(process.exit)
