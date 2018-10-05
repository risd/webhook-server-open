var testOptions = require( './env-options.js' )()
var test = require( 'tape' )
var async = require( 'async' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt )

var DomainMapper = require( '../libs/domain-mapper.js' )
var Firebase = require( '../libs/firebase/index.js' )
var firebaseEscape = require( '../libs/utils/firebase-escape.js' )

grunt.config.merge( { suppressJobQueue: true } )

var firebase = Firebase( grunt.config.get( 'firebase' ) )

var mockClient = { put: function () {} }

test( 'domain-mapper:add', function ( t ) {
  console.log( testOptions.domainMapperSitename )
  var domainMapperAddOptions = {
    maskDomain: testOptions.domainMapperKey,
    contentDomain: testOptions.domainMapperValue,
    sitename: firebaseEscape( testOptions.domainMapperSitename ),
  }

  t.plan( 1 )
  mapDomain( domainMapperAddOptions, domainMapperAddHandler )

  function domainMapperAddHandler ( error ) {
    t.assert( ! error, 'Domain map was added successfully.' )
  }
} )

test( 'domain-mapper:remove', function ( t ) {
  var domainMapperRemoveOptions = {
    maskDomain: testOptions.domainMapperKey,
  }

  t.plan( 1 )
  mapDomain( domainMapperRemoveOptions, domainMapperRemoveHandler )

  function domainMapperRemoveHandler ( error ) {
    t.assert( ! error, 'Domain map was removed successfully.' )
  }
} )

test.onFinish( process.exit )

function mapDomain ( payload, mapHandler ) {
  var mapper = DomainMapper.start( grunt.config, grunt.log )
  Object.assign( payload, { userid: testOptions.buildUserId } )
  var options = Object.assign( { payload: payload }, { identifier: '' } )
  mapper( options, options.identifier, payload, mockClient, mapHandler )
}
