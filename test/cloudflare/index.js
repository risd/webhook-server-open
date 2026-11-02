const config = require('../config.js')
const test = require( 'tape' )
const grunt = require( 'grunt' )
const webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var Cloudflare = require( '../../libs/cloudflare/index.js' )
const options = grunt.config().cloudflare.client
var cloudflare = Cloudflare( options )
var siteName = config.creator.siteName;

var DEFAULT_CNAME_RECORD = require( '../../libs/creator.js' ).DEFAULT_CNAME_RECORD;
var createCnameRecord = require( '../../libs/creator.js' ).createCnameRecord;

var cnameRecordOptions = {
  siteBucket: siteName,
  usesFastly: false,
}
var createCnameRecordOptions = Object.assign(
  grunt.config.get( 'cloudflare' ),
  cnameRecordOptions )


Error.stackTraceLimit = Infinity;

test( 'cloudflare-internal', function ( t ) {
  cloudflare.getZone( siteName )
    .then( handleZone )
    .catch( handleZoneError )

  function handleZone ( zone ) {
    t.pass( `Successfully acquired zone id: ${ zone.id } for site name: ${ siteName }` )
    return testGetCname( zone.id )
  }

  function handleZoneError ( error ) {
    t.fail( `Errored while getting ${ siteName } zone: ${ error.message }` )
    t.fail( `Can not test get CNAME without a zone id.` )
    t.end()
    return error
  }

  async function testGetCname ( zoneId ) {
    try {
      let allCnames = []
      for await (const cnames of cloudflare.getCnamesGenerator(zoneId)) {
        allCnames.push(...cnames)
      }
      return handleCnames(allCnames)  
    }
    catch (error) {
      return handleCnameError(error)
    }
  }

  function handleCnames ( cnames ) {
    t.ok( Array.isArray( cnames ), `Successfully acquired CNAMEs.` )
    t.end()
    return cnames
  }

  function handleCnameError ( error ) {
    t.fail( `Errored while getting CNAMEs.` )
    console.log(error)
    t.end()
    return error
  }
} )

test( 'create-cname-record', async function ( t ) {
  try {
    const cname = await createCnameRecord({...createCnameRecordOptions})
    t.ok(cname.content === DEFAULT_CNAME_RECORD.content, 'CNAME default set correctly.')
    t.ok(cname.id, 'cname has id')
    t.ok(cname.zoneId, 'cname has zone id')
  }
  catch (error) {
    t.fail( `Error during delete of CNAME: ${ error.message }` )
  }
  finally {
    t.end()
  }
})

test( 'cloudflare-get-cname', function ( t ) {
  t.plan( 1 )

  cloudflare.getCnameForSiteName( siteName )
    .then( handleCname )
    .catch( handleCnameError )

  function handleCname ( cname ) {
    t.ok(cname, `Successfully acquired CNAME for site name ${ siteName }.` )
  }

  function handleCnameError ( error ) {
    t.fail( `Errored while getting CNAME for site name ${ siteName }.` )
  }
} )

test( 'cloudflare-delete-cname', function ( t ) {
  t.plan( 1 )

  cloudflare.deleteCnameForSiteName( siteName )
    .then( handleDelete )
    .catch( handleDeleteError )

  function handleDelete (deleted) {
    t.ok(deleted, `Successfully deleted CNAME for site name ${ siteName }.` )
  }

  function handleDeleteError ( error ) {
    t.fail( `Errored while deleting CNAME for site name ${ siteName }.` )
    console.log(error)
  }
} )

test( 'error-cname-for-domain', async function ( t ) {
  var doNotSetCnameOptions = {
    ...createCnameRecordOptions,
    siteBucket: 'not-the-owner-of-this-domain.google.com',
  }

  try {
    await createCnameRecord(doNotSetCnameOptions)
    t.fail(true, 'Should have thrown an error')
  }
  catch (error) {
    t.ok( error.message === Cloudflare.ZoneNotFound().message, `Correct error occurs. ` )
  }
  finally {
    t.end()
  }
})

test.onFinish( process.exit )