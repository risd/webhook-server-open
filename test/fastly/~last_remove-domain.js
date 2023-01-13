const config = require('../config.js')
const test = require( 'tape' )
const grunt = require( 'grunt' )
const webhookTasks = require( '../../Gruntfile.js' )
const fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

test( 'remove-domain', async function ( t ) {
  var cdn = fastlyWebhook( grunt.config().fastly )

  try {
    const service = cdn.removeDomain(config.fastly.addDomain)
    t.ok( typeof service === 'object' && service.hasOwnProperty( 'service_id' ), 'The service should be represented by an object.' )
  }
  catch (error) {
    t.fail(error, 'Error in remove domain.')
  }

  try {
    const service = await.cdn.removeDomain(config.fastly.doNotAddDomain)
     t.ok( typeof service === 'object' && service.hasOwnProperty( 'noDomainsRemoved' ) && service.noDomainsRemoved === true, 'Response should include a flag that no domains were removed.' ) 
  }
  catch (error) {
    t.fail(error, 'Error in remove domain not in service')
  }

  t.end()
} )
