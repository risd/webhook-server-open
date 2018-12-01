var Deploys = require( 'webhook-deploy-configuration' )
var Fastly = require( '../libs/fastly/index.js' )
var Cloudflare = require( '../libs/cloudflare/index.js' )
var Firebase = require( '../libs/firebase/index.js' )

module.exports = DeleteSite;

// todo, add removal of elastic search indexing

function DeleteSite ( options ) {
  if ( ! ( this instanceof DeleteSite ) ) return new DeleteSite( options )
    
  this._firebase = Firebase( options.firebase )
  this._fastly = Fastly( options.fastly )
  this._cloudflare = Cloudflare( options.cloudflare )
  this._deploys = Deploys( this._firebase.database() )
}

DeleteSite.prototype.delete = WebhookSiteDelete;

function WebhookSiteDelete ( siteName ) {
  var self = this;

  return getDeploys()
    .then( deleteSite )

  function getDeploys () {
    return new Promise( function ( resolve, reject ) {
      self._deploys.get( { siteName: siteName }, handleDeploys )

      function handleDeploys ( error, deployConfiguration ) {
        if ( error ) {
          reject( error )
        }
        else {
          resolve( deployConfiguration.deploys.map( pluck( 'bucket' ) ) )
        }
      }
    } )
  }

  function deleteSite ( buckets ) {
    var deletors = []
      .concat( buckets.map( deleteCnameForSiteNameTask ) )
      .concat( buckets.map( deleteCDNDomain ) )
      .concat( self._firebase.deleteSite( { siteName: siteName } ) )

    return Promise.all( deletors )
  }

  function deleteCnameForSiteNameTask ( siteName ) {
    return self._cloudflare.deleteCnameForSiteName( siteName )
  }

  function deleteCDNDomain ( siteName ) {
    return new Promise( function ( resolve, reject ) {
      self._fastly.removeDomain( siteName, function ( error ) {
        if ( error ) reject( error )
        else resolve()
      } )
    } )
  }
}

function pluck ( key ){ return function ( obj ) { return obj[ key ]  } }
