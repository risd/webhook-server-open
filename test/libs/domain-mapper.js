var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks(grunt)

const {configure} = require( '../../libs/domain-mapper.js' )
const mapDomain = configure(grunt.config)

test( 'domain-mapper:add', async function ( t ) {
  var domainMapperAddOptions = {
    maskDomain: testOptions.domainMapperKey,
    contentDomain: testOptions.domainMapperValue,
    sitename: testOptions.domainMapperSitename,
  }

  t.plan( 1 )
  try {
    await mapDomain(domainMapperAddOptions)  
    t.ok(true, 'Domain map was added successfully.')
  }
  catch (error) {
    t.fail(error, 'Domain map failed to be added.' )  
  }
} )

test( 'domain-mapper:remove', function ( t ) {
  var domainMapperRemoveOptions = {
    maskDomain: testOptions.domainMapperKey,
  }

  t.plan( 1 )
  try {
    await mapDomain(domainMapperRemoveOptions)
    t.ok(true, 'Domain map was removed successfully.' )
  }
  catch (error) {
    t.fail(error, 'Domain map failed to be removed.' )
  }
} )

test.onFinish( process.exit )
