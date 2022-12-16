var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var async = require( 'async' )
var grunt = require( 'grunt' )
var Deploys = require( 'webhook-deploy-configuration' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

grunt.config.merge( {
  suppressJobQueue: true,
} )

var creator = require( '../../libs/creator.js' )
var Firebase = require( '../../libs/firebase/index.js' )
var firebaseEscape = require( '../../libs/utils/firebase-escape.js' )

grunt.config.merge( { suppressJobQueue: true } )

var firebase = Firebase( grunt.config.get( 'firebase' ) )
var deploys = Deploys( firebase.database().ref() )

test( 'add-owner', async function ( t ) {
  /* Add owner is a task that is accomplished by the `wh create` command
     in anticipation of submitting the signal command to create the site. */
  t.plan( 1 )

  var ownerData = {}
  ownerData[ firebaseEscape( testOptions.createUserId ) ] = testOptions.createUserId

  try {
    await firebase.siteOwners({ siteName: testOptions.createSiteName }, ownerData)  
    t.ok(true, 'added site owner without error.')
  }
  catch (error) {
    t.fail(error, 'failed to add site owner' )
  }
} ) 


test( 'create-site', function ( t ) {
  t.plan( 1 )

  
  makeCreateWithHandler( createSiteHandler )
  
  function createSiteHandler ( error ) {
    t.assert( error === undefined, 'Create completed without error.' )
  }
} )

test( 'set-deploy', function ( t ) {
  t.plan( 1 )

  firebase.siteKey( { siteName: testOptions.createSiteName } )
    .then( setDeployWithToken )
    .catch( siteTokenError )

  async function setDeployWithToken ( token ) {
    var setterOptions = {
      siteName: testOptions.createSiteName,
      key: token.val(),
      deploy: {
        branch: testOptions.createDeployBranch,
        bucket: testOptions.createDeployBucket,
      },
    }
    try {
      await deploys.setBucket(setterOptions)
      t.ok( 'creator:deploy-settings-made' )
    }
    catch (error) {
      t.fail( error )
    }
  }

  function siteTokenError ( error ) {
    t.fail( error.message )
  }
} )

test( 'create-existing-site', function ( t ) {
  t.plan( 2 )

  makeCreateWithHandler( createExistingSiteHandler )

  function createExistingSiteHandler ( error ) {
    t.assert( error, 'Create existing site correctly errored.' )
    t.equal( error.message, 'site-exists', 'Create existing site errored with the correct message.' )
  }

} )

test.onFinish( process.exit )

function makeCreateWithHandler ( createHandler ) {
  var createOptions = {
    userId: testOptions.createUserId,
    siteName: testOptions.createSiteName,
  }

  var mockClient = { put: function () {} }

  var create = creator.start( grunt.config, console.log )

  return create(createOptions, createHandler)
}

function firebaseSitePaths ( siteName ) {
  return {
    management: `management/sites/${ siteName }`,
    billing: `billing/sites/${ siteName }`,
    buckets: `buckets/${ siteName }`,
  }
}
