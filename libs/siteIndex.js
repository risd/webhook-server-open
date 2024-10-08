var fs = require('fs');
var Firebase = require('./firebase/index.js');
var JobQueue = require('./jobQueue.js');
var WebHookElasticSearch = require( 'webhook-elastic-search' )
var firebaseUnescape = require( './utils/firebase-unescape.js' )

module.exports = configure
function configure (config) {
  const search = WebHookElasticSearch(config.get('elastic'))
  const firebase = Firebase({
    initializationName: 'cms-search-indexer',
    ...config.get('firebase'),
  })

  const code = 'SITE_INDEX'

  return async function siteIndexer ({ siteName }) {
    siteName = firebaseUnescape(siteName)
    try {
      try {
        // ensure we have an elastic index to work with
        await search.createIndex({ siteName })
      }
      catch (error) {
        // we swallow the error if the index exists
        if (error.message.indexOf('exists') === -1) {
          throw error
        }
      }
      const elasticData = await search.siteIndex(siteName)
      if (!elasticData) throw new Error('Failed to re-index CMS search index, no index found in elastic search.')
      const siteKeySnapshot = await firebase.siteKey({ siteName })
      const siteKey = siteKeySnapshot.val()
      const siteDataSnapshot = await firebase.siteDevData({ siteName, siteKey })
      const cmsData = siteDataSnapshot.val()
      if (!cmsData || !cmsData.data || !cmsData.contentType) throw new Error('Failed to re-index CMS search index, no CMS data found to index.')
      const results = await search.updateIndex({ siteName, cmsData, elasticData })
      let message = 'Re-index of CMS search index complete.'
      if (results.errors === true) {
        // if we start seeing this message, dig into the errors.
        // should not be happening as of `webhook-elastic-search@3.0.3`
        message = 'Re-index of CMS search index only partially complete'
      }
      await firebase.siteMessageAdd({ siteName }, {
        code,
        status: 0,
        message,
        timestamp: Date.now(),
      })
    }
    catch (error) {
      console.log(error)
      await firebase.siteMessageAdd({ siteName },{
        code,
        status: 1,
        message: error.message,
        timestamp: Date.now(),
      })
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
        console.log('site-indexer:job:complete')
        callback()
      })
      .catch((error) => {
        console.log('site-indexer:job:error')
        console.log(error)
        callback(error)
      })
  }

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);

  // Wait for a searhc index job, extract info from payload
  jobQueue.reserveJob('siteSearchReindex', 'siteSearchReindex', wrapJob);
}
