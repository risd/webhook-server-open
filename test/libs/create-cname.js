var test = require( 'tape' )
var grunt = require( 'grunt' );
var webhookTasks = require( '../../Gruntfile.js' );
var Cloudflare = require( '../../libs/cloudflare/index.js' )

webhookTasks( grunt );

var createCnameRecord = require( '../../libs/creator.js' ).createCnameRecord;

var cloudflareOptions = grunt.config.get( 'cloudflare' )
var cnameRecordOptions = {
  siteBucket: `cname-create.${ grunt.config().developmentDomain }`,
  usesFastly: false,
}
var cloudflare = Cloudflare( cloudflareOptions )

var createCnameRecordOptions = Object.assign( cloudflareOptions, cnameRecordOptions )

test( 'create-cname-record', function ( t ) {
  t.plan( 2 )

  var DNSRecord = require( 'cloudflare' ).DNSRecord

  createCnameRecord( createCnameRecordOptions, function ( error, cname ) {
    if ( error ) console.log( error )
    t.ok( DNSRecord.is( cname ), 'Return value is DNSRecord' )

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

test.onFinish( process.exit )
