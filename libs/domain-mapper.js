const _ = require( 'lodash' )
const async = require( 'async' )
const Firebase = require( './firebase/index.js' )
const Fastly = require( './fastly/index' )
const JobQueue = require( './jobQueue.js' )

module.exports.configure = configure
function configure (config) {
  const firebaseOptions = {
    initializationName: 'domain-mapper'
    ...config.get('firebase'),
  }
    
  const firebase = Firebase(firebaseOptions)
  const fastly = Fastly(config.get( 'fastly' ))

  return async function domainMapper ({ siteName, contentDomain, maskDomain }) {
    try {
      if (contentDomain && maskDomain) {
        // add mapping
        await fastly.domain(maskDomain)
        await fastly.mapDomain({ contentDomain, maskDomain })
        
        await firebase.siteMessageAdd({ siteName }, {
          message: `Succeeded mapping domain ${maskDomain} to ${contentDomain}.`,
          timestamp: Date.now(),
          status: 0,
          code: 'DOMAINS',
        })
      }
      else if (maskDomain) {
        // remove mapping
        await fastly.removeDomain(maskDomain)
        await fastly.removeMapDomain({ maskDomain })

        await firebase.siteMessageAdd({ siteName }, {
          message: `Succeeded removing domain mapping for ${maskDomain}.`,
          timestamp: Date.now(),
          status: 0,
          code: 'DOMAINS',
        })
      }
      else {
        throw new Error('Requires a { contentDomain, maskDomain } to add a mapping for , or { maskDomain } to remove a mapping for.')
      }
    }
    catch (error) {
      await firebase.siteMessageAdd({ siteName }, {
        message: `Failed Domain mapping attempt for ${maskDomain}.`,
        timestamp: Date.now(),
        status: 1,
        code: 'DOMAINS',
      })
    }
  }
}


module.exports.start = function ( config, logger ) {
  const job = configure(config)

  var jobQueue = JobQueue.init(config);

  const wrapJob = ({ siteName, contentDomain, maskDomain }, callback) => {
    job({ siteName, contentDomain, maskDomain })
      .then(() => {
        console.log('domain-mapper:job:complete')
        callback()
      })
      .catch((error) => {
        console.log('domain-mapper:job:error')
        console.log(error)
        callback(error)
      })

  console.log('Waiting for commands'.red);
}

function callbackDebug ( name, callback ) {
  if ( typeof name === 'function' ) callback = name;

  return function wrapsCallback ( error, result ) {
    if ( error ) {
      console.log( name + ':error' )
      console.log( error )
    }
    else {
      console.log( name + ':success' )
      console.log( result )
    }
    callback( error, result )
  }
}
