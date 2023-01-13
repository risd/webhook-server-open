var fs = require('fs');
var _ = require('lodash');
var Firebase = require('./firebase/index.js');
var JobQueue = require('./jobQueue.js');
var WebHookElasticSearch = require( 'webhook-elastic-search' )
var firebaseEscape = require( './utils/firebase-escape.js' )
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
      const siteIndex = await search.siteIndex(siteName)
      if (!siteIndex) throw new Error('Failed to re-index CMS search index, no index found in elastic search.')
      const siteKeySnapshot = await firebase.siteKey({ siteName })
      const siteKey = siteKeySnapshot.val()
      const siteDataSnapshot = await firebase.siteDevData({ siteName, siteKey })
      const siteData = siteDataSnapshot.val()
      if (!siteData || !siteData.data || !siteData.contentType) throw new Error('Failed to re-index CMS search index, no CMS data found to index.')
      const results = await search.updateIndex({ siteName, siteData, siteIndex })
      console.log(results.items?.length)
      await firebase.siteMessageAdd({ siteName }, {
        code,
        status: 0,
        message: 'Re-index of CMS search index complete.'
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

  console.log(JobQueue.MESSAGES.WAITING)

  // Wait for a searhc index job, extract info from payload
  jobQueue.reserveJob('siteSearchReindex', 'siteSearchReindex', wrapJob);
}
