const testOptions = require('../env-options.js' )()
const grunt = require('grunt')
const test = require('tape')

require('../../Gruntfile.js')(grunt)

grunt.config.merge({
  suppressJobQueue: true,
})

const creator = require( '../../libs/creator.js' )
const Firebase = require( '../../libs/firebase/index.js' )
const firebaseEscape = require( '../../libs/utils/firebase-escape.js' )

var firebase = Firebase(grunt.config.get('firebase'))
var deploys = Deploys(firebase.database().ref())

const siteName = `${testOptions.lifeCycleSiteName}-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-')}}.${testOptions.lifeCycleDomain}`

test('create', async (t) => {
  try {
    // add ownser user for the site to run creator
    const ownerData = {}
    ownerData[firebaseEscape(testOptions.createUserId)] = testOptions.createUserId
    await firebase.siteOwners({ siteName }, ownerData)
    t.pass('Set user owner')

    await makeCreateWithHandler({ siteName })
    t.pass('Created site.')
  }
  catch (error) {
    t.fail(error)
  }
  finally {
    t.end()
  }
})

function makeCreateWithHandler ({ siteName }) {
  const mockClient = { put: function () {} }

  const create = creator.start(grunt.config, console.log)

  return new Promise((resolve, reject) => {
    create({
      siteName,
      userId: testOptions.createUserId,
    }, (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
  return 
}
