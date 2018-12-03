var test = require( 'tape' )
var grunt = require( 'grunt' );
var webhookTasks = require( '../../Gruntfile.js' );
var Cloudflare = require( '../../libs/cloudflare/index.js' )

webhookTasks( grunt );

grunt.config.merge( {
  suppressJobQueue: true,
} )


var cloudflareOptions = grunt.config.get( 'cloudflare' )
var cnameRecordOptions = {
  siteBucket: `cname-create.${ grunt.config().developmentDomain }`,
  usesFastly: false,
}
var cloudflare = Cloudflare( cloudflareOptions )
var createCnameRecordOptions = Object.assign( cloudflareOptions, cnameRecordOptions )

var DEFAULT_CNAME_RECORD = require( '../../libs/creator.js' ).DEFAULT_CNAME_RECORD;
var createCnameRecord = require( '../../libs/creator.js' ).createCnameRecord;

test( 'create-cname-record', function ( t ) {
  t.plan( 3 )

  var DNSRecord = require( 'cloudflare' ).DNSRecord

  createCnameRecord( createCnameRecordOptions, function ( error, cname ) {
    if ( error ) console.log( error )
    t.ok( DNSRecord.is( cname ), 'Return value is DNSRecord' )
    t.ok( cname.toJSON().content === DEFAULT_CNAME_RECORD.content, 'CNAME default set correctly.' )

    cloudflare.deleteCname( cname )
      .then( handleDelete )
      .catch( handleDeleteError )
  } )

  function handleDelete ( cnameStub ) {
    t.pass( `Deleted the just created CNAME with ID: ${ cnameStub.id }` )
  }
 
  function handleDeleteError ( error ) {
    t.fail( `Error during delete of CNAME: ${ error.message }` )
  }
} )

test( 'error-cname-for-domain', function ( t ) {
  t.plan( 2 )

  var doNotSetCnameOptions = Object.assign( createCnameRecordOptions, {
    siteBucket: 'not-the-owner-of-this-domain.google.com',
  } )

  createCnameRecord( doNotSetCnameOptions, function ( error, cname ) {
    t.ok( error.message === Cloudflare.ZoneRequiredError().message, `Correct error occurs. ` )
    t.ok( cname === undefined, `No CNAME set.` )
  } )
} )

test.onFinish( process.exit )
