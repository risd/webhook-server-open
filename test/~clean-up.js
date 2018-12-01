var testOptions = require( './env-options.js' )()
var grunt = require( 'grunt' )
var async = require( 'async' )
var test = require( 'tape' )
var Deploys = require( 'webhook-deploy-configuration' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt )

var Fastly = require( '../libs/fastly/index.js' )
var Cloudflare = require( '../libs/cloudflare/index.js' )
var Firebase = require( '../libs/firebase/index.js' )

var cloudflare = Cloudflare( grunt.config().cloudflare )
var firebase = Firebase( grunt.config().firebase )
var fastly = Fastly( grunt.config().fastly )
var deploys = Deploys( firebase.database() )

var siteName = testOptions.createSiteName;

test( 'delete-cloudflare-cnames', function ( t ) {
  var testCount = 1;
  t.plan( testCount )

  deploys.get( { siteName: siteName }, handleDeploys )

  function handleDeploys ( error, deployConfiguration ) {
    if ( error ) {
      t.fail( `Could not get deploy configuration for ${ siteName }.` )
      t.end()
    }

    var tasks = deployConfiguration.deploys
      .map( pluck( 'bucket' ) )
      .slice( 0, testCount )
      .map( deleteCnameForSiteNameTask )

    async.series( tasks, handleDeleteTasks )
  }

  function handleDeleteTasks ( error ) {
    t.assert( ! error, `Deleted CNAMEs without error.` )
  }

  function deleteCnameForSiteNameTask ( siteName ) {
     return function deleteTask ( step ) {
       cloudflare.deleteCnameForSiteName( siteName )
         .then( function ( tombstoneStub ) {
           step()
         } )
         .catch( step )
     } 
  }
} )

test( 'delete-fastly-domains', function ( t ) {
  var testCount = 1;
  t.plan( testCount )

  deploys.get( { siteName: siteName }, handleDeploys )

  function handleDeploys ( error, deployConfiguration ) {
    if ( error ) {
      t.fail( `Could not get deploy configuration for ${ siteName }.` )
      t.end()
    }

    var domains = deployConfiguration.deploys.map( pluck( 'bucket' ) )

    fastly.removeDomain( domains, function ( error ) {
      t.assert( ! error, `Deleted domain from fastly without error.` )
    } )
  }
} )

test( 'delete-firebase-data', function ( t ) {
  t.plan( 1 )

  // deleteSite( testOptions.createSiteName, deleteHandler )
  firebase.deleteSite( { siteName: siteName } )
    .then( deleteHandler )
    .catch( deleteErrorHandler )

  function deleteHandler () {
    t.pass( 'Delete site firebase data succeeded.' )
  }
  function deleteErrorHandler ( error ) {
    console.log( error )
    t.fail( 'Delete site firebase data errored.' )
  }
} )

test.onFinish( process.exit )

function pluck ( key ){ return function ( obj ) { return obj[ key ]  } }
