var testOptions = require( '../env-options.js' )()
var test = require( 'tape' )
var path = require( 'path' )
var grunt = require( 'grunt' )
var Firebase = require( '../../libs/firebase/index.js' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

test( 'firebase-admin', async function ( t ) {
  
  try {
    const firebase = Firebase( Object.assign( { initializationName: 'admin-test' }, grunt.config().firebase ) )
    t.assert( typeof firebase === 'object', 'Firebase instance is an object.' )  

    const db = firebase.database()
    t.assert( typeof db === 'object', 'Firebase database instance is an object.' )

    const token = await firebase._getAccessToken()
    t.assert(typeof token === 'string', 'Firebase access token is a string')

    const siteKeySnapshot = await firebase.siteKey({ siteName: testOptions.firebaseAdminSiteName })
    t.assert(typeof siteKeySnapshot.val() === 'string', 'Got site management key')

    await firebase.siteKey({ siteName: 'non-existent-site' }, null)
    t.pass('Set non-existent value to null is ok')

    let siteDevDataSnapshot = await firebase.siteDevData({
      siteName: testOptions.firebaseAdminSiteName,
      siteKey: siteKeySnapshot.val(),
    })
    if (siteDevDataSnapshot.val() === null) {
      const baseSiteDevData = { data: {}, deploys: [], contentTypes: {} }
      await firebase.siteDevData({
        siteName: testOptions.firebaseAdminSiteName,
        siteKey: siteKeySnapshot.val(),
      }, baseSiteDevData)
      siteDevDataSnapshot = await firebase.siteDevData({
        siteName: testOptions.firebaseAdminSiteName,
        siteKey: siteKeySnapshot.val(),
      })
      console.log(siteDevDataSnapshot.val())
      t.deepEqual(baseSiteDevData, siteDevDataSnapshot.val(), 'Get/Set site data.')
    }
    else {
      t.assert(typeof siteDevDataSnapshot.val() === 'object', 'Got site dev data')
      await firebase.siteDevData({
        siteName: testOptions.firebaseAdminSiteName,
        siteKey: siteKeySnapshot.val(),
      }, siteDevDataSnapshot.val())
      let recentSiteDevDataSnapshot = await firebase.siteDevData({
        siteName: testOptions.firebaseAdminSiteName,
        siteKey: siteKeySnapshot.val(),
      })
      t.deepEqual(recentSiteDevDataSnapshot.val(), siteDevDataSnapshot.val(), 'Get/set site data')
    }

    const allSitesSnapshot = await firebase.allSites()
    t.assert(allSitesSnapshot.val() !== null, 'Got all sites.')
  }
  catch (error) {
    t.fail(error)
  }
  finally {
    t.end()  
  }
} )

test.onFinish( process.exit )