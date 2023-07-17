const debug = require('debug')('get-img-resize-url')
const axios = require('axios')

module.exports = getImgResizeUrl

/**
 * options: {
 *   serviceUrl?: ''  // the complete service url to resize against. useful for local dev
 *   appEngine?: {
 *     projectId: ''
 *     version?: ''
 *     domain?: '' | 'appspot.com'
 *     protocol?: '' | 'https'
 *   }
 * } => async (imageUrl) => resizeUrl
 *
 * Given a [resizing service](https://github.com/risd/webhook-images) URL as 
 * `serviceUrl` or the appEngine description of your resizing service, return a
 * function that accepts an `imageUrl` that is a URL to a Google Storage stored
 * image, and return an image resizing URL
 */
function getImgResizeUrl ({ serviceUrl, appEngine }) {

  let resizeServiceUrl
  if (serviceUrl) {
    resizeServiceUrl = serviceUrl
  }
  else if (appEngine?.projectId) {
    const {projectId} = appEngine
    const protocol = appEngine.protocol || 'https'
    const version = appEngine.version
      ? `${appEngine.version}-dot-`
      : ''
    const domain = appEngine.domain || 'appspot.com'
    resizeServiceUrl = `${protocol}://${version}${projectId}.${domain}`
  }
  else {
    throw new Error('Must include an image resizing service URL.')
  }

  return (imageUrl) => {
    const encodedUrl = encodeURIComponentsForURL( removeProtocolFromURL( imageUrl ) )
    const imageResizerUrl = `${resizeServiceUrl}/${ encodedUrl  }`
    debug('imageResizerUrl', imageResizerUrl)
    return axios.get(imageResizerUrl).then((response) => {
      let resizeUrl = response.data
      if (resizeUrl.length > 0 && resizeUrl.indexOf( 'http://' ) === 0) {
        resizeUrl = `https${ resizeUrl.slice( 4 )}`
      }
      debug('resizeUrl', resizeUrl)
      return resizeUrl
    })
  }
}

function encodeURIComponentsForURL ( url ) {
  var protocolIndex = url.indexOf( '//' )
  var includesProtocol = protocolIndex === -1
    ? false
    : true

  if ( includesProtocol ) {
    var protocolString = url.split( '//' )[ 0 ]
    url = url.slice( protocolIndex + 2 )
  }

  var encodedUrl = url.split( '/' ).map( encodeURIComponent ).join( '/' )

  if ( includesProtocol ) {
    encodedUrl = [ protocolString, encodedUrl ].join( '//' )
  }

  return encodedUrl
}

function removeProtocolFromURL ( url ) {
  var protocolIndex = url.indexOf( '//' )
  var includesProtocol = protocolIndex === -1
    ? false
    : true

  if ( includesProtocol ) return url.slice( protocolIndex + 2 )

  return url;
}
