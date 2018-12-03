var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

grunt.config.merge( {
  suppressJobQueue: true,
} )

var unescape = require( '../../libs/utils/firebase-unescape.js' )
var commandDelegator = require( '../../libs/commandDelegator.js' )
var JobQueue = require( '../../libs/jobQueue.js' )

var commandor = commandDelegator.start( grunt.config, console.log )
var jobQueue = JobQueue.init( grunt.config )

var siteName = testOptions.createSiteName;

// accepts command data at a particular node in firebase
var options = [ {
  tube: 'build',
  data: {
    userid: 'test-user',
    sitename: siteName,
    branch: 'develop',
    buildtime: '1',
    id: 'unique-id',
    contentType: 'content-type',
    itemKey: 'item-key',
  },
  expectedData: {
    userid: 'test-user',
    sitename: siteName,
    branch: 'develop',
    buildtime: '1',
    id: 'unique-id',
    contentType: 'content-type',
    itemKey: 'item-key',
    siteBucket: unescape( siteName )
  },
  handler: function ( handlerPayload, handlerIdentifier, handlerData, handlerClient, handlerCallback ) {
    console.log( 'handler' )
    this.t.deepEqual( handlerData, this.expectedData, 'The payload is consistent for tube: ' + this.tube )
    handlerCallback()
  }
} ]


test( 'command-build', function ( t ) {
  t.plan( options.length )
  t.fail( 'Test does not currently work.' )
  t.end()
  console.log( `test-length:${ options.length }` )

  options.forEach( function ( opts ) {
    jobQueue.reserveJob( opts.tube, opts.lock, opts.handler.bind( Object.assign( { t: t }, opts ) ) )
  } )

  commandor.on( 'ready', function ( commandHandlers ) {
    console.log( 'ready' )
    console.lgo( commandHandlers )
    options.forEach( function ( opts ) {
      commandHandlers.queueFirebase( { tube: opts.tube, data: opts.data } )
    } )
  } )

  commandor.on( 'error', function () {
    t.fail( 'Command delegator could not connect.' )
    t.end()
  } )
} )

test.onFinish( process.exit )
