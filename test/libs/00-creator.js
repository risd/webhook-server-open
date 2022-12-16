const config = require('../config.js')
var test = require( 'tape' )
var async = require( 'async' )
var grunt = require( 'grunt' )
var Deploys = require( 'webhook-deploy-configuration' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var creator = require( '../../libs/creator.js' )
var Firebase = require( '../../libs/firebase/index.js' )
var firebaseEscape = require( '../../libs/utils/firebase-escape.js' )

var firebase = Firebase( grunt.config.get( 'firebase' ) )
var deploys = Deploys( firebase.database().ref() )

const createOptions = {
  userId: config.createor.userId,
  siteName: config.createor.siteName,
}

const createSite = creator.configure(grunt.config)

test( 'add-owner', async function ( t ) {
  /* Add owner is a task that is accomplished by the `wh create` command
     in anticipation of submitting the signal command to create the site. */
  t.plan( 1 )

  var ownerData = {}
  ownerData[ firebaseEscape( createOptions.userId ) ] = testOptions.createUserId

  try {
    await firebase.siteOwners({ siteName: createOptions.siteName }, ownerData)  
    t.ok(true, 'added site owner without error.')
  }
  catch (error) {
    t.fail(error, 'failed to add site owner' )
  }
} ) 


test( 'create-site', async function ( t ) {
  t.plan( 1 )

  try {
    await createSite(createOptions)  
    t.ok(true, 'created site')
  }
  catch (error) {
    t.fail(error, 'failed to create site')
  }
} )

test( 'set-deploy', async function ( t ) {
  try {
    const siteKeySnapshot = await firebase.siteKey({ siteName: createOptions.siteName })
    t.ok(true, 'creator:got-site-key')
    const siteKey = siteKeySnapshot.val()
    const setterOptions = {
      siteName: createOptions.siteName,
      key: siteKey,
      deploy: {
        branch: 'develop',
        bucket: createOptions.deploy.bucket,
      },
    }
    await deploys.setBucket(setterOptions)
    t.ok(true, 'creator:deploy-settings-made')
  }
  catch (error) {
    t.fail(error)
  }
  finally {
    t.end()
  }
})

test( 'create-existing-site', function ( t ) {
  t.plan( 1 )

  try {
    await createSite(createOptions)  
    t.ok(true, 'failed by creating an already existing site')
  }
  catch (error) {
    t.fail(error, 'create existing site errored correctly')
  }

} )

test.onFinish( process.exit )

function firebaseSitePaths ( siteName ) {
  return {
    management: `management/sites/${ siteName }`,
    billing: `billing/sites/${ siteName }`,
    buckets: `buckets/${ siteName }`,
  }
}
