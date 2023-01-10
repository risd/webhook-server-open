/*

Redirects management via Fastly.

*/

const debug = require('debug')('redirects')
var _ = require( 'lodash' )
var async = require( 'async' )
var FastlyWebhook = require( './fastly/index' )
var Firebase = require( './firebase/index' )
var JobQueue = require('./jobQueue.js')
var Deploys = require( 'webhook-deploy-configuration' )
var isAscii = require( 'is-ascii' );
var firebaseUnescape = require( './utils/firebase-unescape.js' )

module.exports.configure = configure

function configure (config) {
  // redirects are not established for development domains
  var fastly = FastlyWebhook(config.get( 'fastly' ))
  const firebase = Firebase({
    initializationName: 'redirects-worker',
    ...config.get('firebase'),
  })
  const deploys = Deploys(firebase.database().ref())

  const code = 'REDIRECTS'

  return async function ({ siteName }) {
    siteName = firebaseUnescape(siteName)
    try {
      const deployConfiguration = await deploys.get({ siteName })
      const siteBuckets = deployConfiguration.deploys.map(c => c.bucket)
      const fastlyRedirectDomains = []
      for (const siteBucket of siteBuckets) {
        const maskDomain = await fastly.maskForContentDomain(siteBucket)
        const redirectDomain = maskDomain || siteBucket
        const isFastlyDomain = fastly.isFastlyDomain(redirectDomain)
        if (isFastlyDomain) fastlyRedirectDomains.push(redirectDomain)
      }
      if (fastlyRedirectDomains.length === 0) throw new Error(`No fastly domains to set redirects on.`)
      await fastly.domain(fastlyRedirectDomains)
      const siteKeySnapshot = await firebase.siteKey({ siteName })
      const siteKey = siteKeySnapshot.val()
      const redirectsSnapshot = await firebase.siteRedirects({ siteName, siteKey })
      const redirects = redirectsSnapshot.val() || []
      let cmsRedirects = []
      Object.keys( redirects ).forEach( function ( redirectKey ) {
        cmsRedirects.push( redirects[ redirectKey ] )
      } )
      cmsRedirects = _.uniqWith( cmsRedirects, function ( a, b ) { return a.pattern === b.pattern } )
      cmsRedirects = cmsRedirects.filter( function ( redirect ) {
        return isAscii( redirect.pattern ) && isAscii( redirect.destination )
      } )
      const errorDomains = []
      for (const redirectDomain of fastlyRedirectDomains) {
        try {
          await fastly.redirects({ host: redirectDomain, redirects: cmsRedirects })  
        }
        catch (error) {
          errorDomains.push(redirectDomain)
        }
      }
      if (errorDomains.length > 0) throw new Error(`Error setting redirects for ${ errorDomains.join(', ') }`)
      await fastly.activate()
      await firebase.siteMessageAdd({siteName}, {
        code,
        status: 0,
        message: `Successfully set redirects for ${fastlyRedirectDomains.join(', ')}.`,
        timestamp: Date.now(),
      })
    }
    catch (error) {
      await firebase.siteMessageAdd({siteName}, {
        code,
        status: 1,
        message: error.message,
        timestamp: Date.now()
      })
      throw error
    }
  }
}

/**
 * JobQueue wrapper used by the command delegator
 */
module.exports.start = function (config) {
  const job = configure(config)

  const wrapJob = (payload, callback) => {
    job(payload)
      .then(() => {
        console.log('redirects:job:complete')
        callback()
      })
      .catch((error) => {
        console.log('redirects:job:error')
        console.log(error)
        callback(error)
      })
  }

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);

  console.log( 'Waiting for commands'.red )

  // Wait for create commands from firebase
  jobQueue.reserveJob( 'redirects', 'redirects', wrapJob )
}
