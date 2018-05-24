var test = require( 'tape' )

var grunt = require( 'grunt' )
var async = require( 'async' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt );

var cloudflareOptions = grunt.config.get( 'cloudflare' )

var DNSRecord = require( 'cloudflare' ).DNSRecord
var createCnameRecord = require( '../libs/creator.js' ).createCnameRecord;
var cnameForDomain = require( '../libs/creator.js' ).cnameForDomain.bind( null, cloudflareOptions.domains );
var DEFAULT_CNAME_RECORD = require( '../libs/creator.js' ).DEFAULT_CNAME_RECORD;

var cnameRecordOptions = [ {
  name: 'Success default CNAME record set',
  input: {
    siteBucket: 'cname-create.risd.systems',
  },
  output: function ( error, cname ) {
    this.t.ok( error === null, `${ this.name } error is null.` )
    this.t.ok( DNSRecord.is( cname ), `${ this.name } return value is a DNS record.` )
    this.t.ok( cname.toJSON().content === DEFAULT_CNAME_RECORD.content, `${ this.name }, CNAME content is correct.` )
  },
  testCount: 3,
}, {
  name: 'Success no-set risd.edu',
  input: {
    siteBucket: 'cname-create.risd.edu',
  },
  output: function ( error, cname ) {
    this.t.ok( error === null, `${ this.name } error is null. ` )
    this.t.ok( cname === false, `${ this.name } CNAME value is false.` )
  },
  testCount: 2,
}, {
  name: 'Success configured CNAME record set',
  input: {
    siteBucket: 'cname-create.risdweekend.com',
  },
  output: function ( error, cname ) {
    this.t.ok( error === null, `${ this.name } error is null.` )
    this.t.ok( DNSRecord.is( cname ), `${ this.name } return value is a DNS record.` )
    this.t.ok( cname.toJSON().content === cnameForDomain( this.input.siteBucket ).content, `${ this.name }, CNAME content is correct.` )
  },
  testCount: 3,
} ]

var createCnameRecordOptions = Object.assign( cloudflareOptions, cnameRecordOptions )

test( 'create-dns-record', function ( t ) {
  t.plan( testsCountInOptions( cnameRecordOptions ) )

  var testTasks = cnameRecordOptions
    .map( addTester( t ) )
    .map( addBaseInputKeys )
    .map( optionsToTestTask )

  async.series( testTasks, function () {} )
} )

function testsCountInOptions ( options ) {
  return options
    .map( obj => obj.testCount )
    .reduce( ( previous, current ) => previous + current, 0 )
}

function addTester ( tester ) {
  return function adder ( options ) {
    options.t = tester;
    return options;
  }
}

function addBaseInputKeys ( options ) {
  Object.assign( options.input, cloudflareOptions )
  return options;
}

function optionsToTestTask ( options ) {
  return function task ( next ) {
    createCnameRecord( options.input, function onCreate ( error, value ) {
      options.output.apply( options, [ error, value ] )
      next()
    } )
  }
}
