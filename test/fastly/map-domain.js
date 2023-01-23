const config = require('../config.js')
var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var fastlyWebhook = require( '../../libs/fastly/index.js' )

webhookTasks( grunt )

var cdn = fastlyWebhook( grunt.config().fastly )
var mapOptions = 

test( 'map-domain', async function ( t ) {
  try {
    const status = await cdn.mapDomain(config.fastly.mapDomain)
    t.ok(true, 'Succesfully set fastly map domain')
  }
  catch (error) {
    t.fail(error, 'Error in set fastly map domain')
  }
  finally {
    t.end()
  }
} )

test( 'get-mask-domain-for-content-domain', async function ( t ) {
  try {
    const maskDomain = await cdn.maskForContentDomain(config.fastly.mapDomain.contentDomain)  
    t.ok(maskDomain === config.fastly.mapDomain.maskDomain, 'The maskDomain should be equal to its input.')
  }
  catch (error) {
    t.fail(error, 'Error in get mask domain for content domain')
  }
  finally {
    t.end()
  }
})

test( 'remove-map-domain', async function ( t ) {
  try {
    await cdn.removeMapDomain(config.fastly.mapDomain)
    t.ok(true, 'Succcessfully removed map domain.')
  }
  catch (error) {
    t.fail(error, 'Error in removing map domain')
  }
  finally {
    t.end()
  }
} )