const config = require('../config.js')
const test = require( 'tape' )
const grunt = require( 'grunt' )
const Firebase = require( '../../libs/firebase/index.js' )
const webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

const { siteName, userId } = config.creator

test( 'firebase-admin', async function ( t ) {
  
  try {
    const firebase = Firebase( Object.assign( { initializationName: 'admin-test' }, grunt.config().firebase ) )
    t.assert( typeof firebase === 'object', 'Firebase instance is an object.' )  

    const db = firebase.database()
    t.assert( typeof db === 'object', 'Firebase database instance is an object.' )

    const token = await firebase._getAccessToken()
    t.assert(typeof token === 'string', 'Firebase access token is a string')

    let siteKeySnapshot = await firebase.siteKey({ siteName })
    if (typeof siteKeySnapshot.val() !== 'string') {
      let siteKey = 'site-key'
      await firebase.siteKey({ siteName }, siteKey)
      siteKeySnapshot = await firebase.siteKey({ siteName })
    }
    t.assert(typeof siteKeySnapshot.val() === 'string', 'Got site management key')

    await firebase.siteKey({ siteName: 'non-existent-site' }, null)
    t.pass('Set non-existent value to null is ok')

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