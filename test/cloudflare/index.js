const config = require('../config.js')
const test = require( 'tape' )
const grunt = require( 'grunt' )
const webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var Cloudflare = require( '../../libs/cloudflare/index.js' )
var cloudflare = Cloudflare( grunt.config().cloudflare.client )

var siteName = config.creator.siteName;

Error.stackTraceLimit = Infinity;

test( 'cloudflare-internal', function ( t ) {
  t.plan( 2 )

  cloudflare.getZone( siteName )
    .then( handleZone )
    .catch( handleZoneError )

  function handleZone ( zone ) {
    t.pass( `Successfully acquired zone id: ${ zone.id } for site name: ${ siteName }` )
    testGetCname( zone.id )
  }

  function handleZoneError ( error ) {
    t.fail( `Errored while getting ${ siteName } zone: ${ error.message }` )
    t.fail( `Can not test get CNAME without a zone id.` )
  }

  function testGetCname ( zoneId ) {
    cloudflare.getCnames( zoneId )
      .then( handleCnames )
      .catch( handleCnameError )
  }

  function handleCnames ( cnames ) {
    t.ok( Array.isArray( cnames ), `Successfully acquired CNAMEs.` )
  }

  function handleCnameError ( error ) {
    t.fail( `Errored while getting CNAMEs.` )
  }
} )

test( 'cloudflare-create-cname', function ( t ) {
  t.plan( 1 )

  cloudflare.getCnameForSiteName( siteName )
    .then( handleCname )
    .catch( handleCnameError )

  function handleCname ( cname ) {
    t.pass( `Successfully acquired CNAME for site name ${ siteName }.` )
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

  function handleDelete () {
    t.pass( `Successfully deleted CNAME for site name ${ siteName }.` )
  }

  function handleDeleteError ( error ) {
    t.fail( `Errored while deleting CNAME for site name ${ siteName }.` )
  }
} )
