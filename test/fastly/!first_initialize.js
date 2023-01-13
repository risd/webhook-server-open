const test = require( 'tape' )
const grunt = require( 'grunt' )
const webhookTasks = require( '../../Gruntfile.js' )
const fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'cdn-service-initialize', async function ( t ) {
  const cdn = fastlyWebhook( grunt.config().fastly )

  try {
    const service = await cdn.initialize()
    t.ok( typeof service === 'object', 'The service should be represented by an object.' )
  }
  catch (error) {
    t.fail(error, 'Error in fastly service initialization')
  }

  t.end()
})
