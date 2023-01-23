var test = require( 'tape' )
var grunt = require( 'grunt' );
var webhookTasks = require( '../../Gruntfile.js' );
var Cloudflare = require( '../../libs/cloudflare/index.js' )

webhookTasks( grunt )


var cloudflareOptions = grunt.config.get( 'cloudflare' )
var cnameRecordOptions = {
  siteBucket: `cname-create.${ grunt.config().developmentDomain }`,
  usesFastly: false,
}
var cloudflare = Cloudflare( cloudflareOptions )
var createCnameRecordOptions = Object.assign( cloudflareOptions, cnameRecordOptions )

var DEFAULT_CNAME_RECORD = require( '../../libs/creator.js' ).DEFAULT_CNAME_RECORD;
var createCnameRecord = require( '../../libs/creator.js' ).createCnameRecord;

test( 'create-cname-record', async function ( t ) {

  var DNSRecord = require( 'cloudflare' ).DNSRecord

  try {
    const cname = await createCnameRecord(createCnameRecordOptions)  
    t.ok(DNSRecord.is(cname), 'Return value is DNSRecord')
    t.ok(cname.toJSON().content === DEFAULT_CNAME_RECORD.content, 'CNAME default set correctly.')

    const cnameStub = await cloudflare.deleteCname(cname)
    t.pass( `Deleted the just created CNAME with ID: ${ cnameStub.id }` )
  }
  catch (error) {
    t.fail( `Error during delete of CNAME: ${ error.message }` )
  }
  finally {
    t.end()
  }
})

test( 'error-cname-for-domain', async function ( t ) {
  t.plan( 2 )

  var doNotSetCnameOptions = Object.assign( createCnameRecordOptions, {
    siteBucket: 'not-the-owner-of-this-domain.google.com',
  } )

  try {
    await createCnameRecord(doNotSetCnameOptions)
    t.fail(true, 'Should have thrown an error')
  }
  catch (error) {
    t.ok( error.message === Cloudflare.ZoneRequiredError().message, `Correct error occurs. ` )
  }
})

test.onFinish( process.exit )
