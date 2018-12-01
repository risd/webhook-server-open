var test = require( 'tape' )

var grunt = require( 'grunt' );
var webhookTasks = require( '../../Gruntfile.js' );

webhookTasks( grunt );

var createCnameRecord = require( '../../libs/creator.js' ).createCnameRecord;

var cloudflareOptions = grunt.config.get( 'cloudflare' )
var cnameRecordOptions = {
  record: 'cname-create.risd.systems',
  content: 'c.storage.googleapis.com',
}

var createCnameRecordOptions = Object.assign( cloudflareOptions, cnameRecordOptions )

test( 'create-dns-record', function ( t ) {
  t.plan( 1 )

  var DNSRecord = require( 'cloudflare' ).DNSRecord

  createCnameRecord( createCnameRecordOptions, function ( error, cname ) {
    if ( error ) console.log( error )
    t.ok( DNSRecord.is( cname ), 'Return value is DNSRecord' )
  } )

} )

test.onFinish( process.exit )
