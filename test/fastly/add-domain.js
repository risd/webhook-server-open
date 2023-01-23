const config = require('../config.js')
const test = require( 'tape' )
const grunt = require( 'grunt' )
const webhookTasks = require( '../../Gruntfile.js' )
const fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks(grunt)

test( 'add-domain', async function ( t ) {

  const cdn = fastlyWebhook( grunt.config().fastly )

  try {
    const service = await cdn.domain(config.fastly.addDomain)
    t.ok( typeof service === 'object' && service.hasOwnProperty( 'service_id' ), 'The service should be represented by an object.' )
  }
  catch (error) {
     t.fail(error, 'Error in successful domain addition.')
  }

  try {
    const service = await cdn.domain(config.fastly.doNotAddDomain)
    t.ok( typeof service === 'object' && service.hasOwnProperty( 'noDomainsAdded' ) && service.noDomainsAdded === true, 'Response should include a flag that no domains were addded.' )
  }
  catch (error) {
    t.fail(error, 'Error in successfully not adding a domain')
  }

  t.end()
})
