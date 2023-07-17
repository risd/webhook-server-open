const debug = require('debug')('get-img-resize-url')
const axios = require('axios')

module.exports = getImgResizeUrl

function getImgResizeUrl () {

  let resizeServiceUrl

  const resizer = (url) => {
    const encodedUrl = encodeURIComponentsForURL( removeProtocolFromURL( url ) )
    const getResizeUrl = `${resizeServiceUrl}/${ encodedUrl  }`
    debug('getResizeUrl', getResizeUrl)
    return axios.get(getResizeUrl).then((response) => {
      let resizeUrl = response.data
      if (resizeUrl.length > 0 && resizeUrl.indexOf( 'http://' ) === 0) {
        resizeUrl = `https${ resizeUrl.slice( 4 )}`
      }
      debug('resizeUrl', resizeUrl)
      return resizeUrl
    })
  }

  resizer.serviceUrl = (url) => {
    if (!url) return resizeServiceUrl
    resizeServiceUrl = url
    return resizer
  }

  resizer.serviceUrlFromGoogleProjectId = (googleProjectId) => {
    resizeServiceUrl = `https://${ googleProjectId }.appspot.com`
    return resizer
  }

  return resizer
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
