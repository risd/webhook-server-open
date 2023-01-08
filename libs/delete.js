const Deploys = require( 'webhook-deploy-configuration' )
const Fastly = require( './fastly/index.js' )
const Cloudflare = require( './cloudflare/index.js' )
const Firebase = require( './firebase/index.js' )
const Elastic = require('webhook-elastic-search')
const cloudStorage = require( './cloudStorage.js' )

module.exports = DeleteSite;

function DeleteSite ( options ) {
  if ( ! ( this instanceof DeleteSite ) ) return new DeleteSite( options )

  cloudStorage.configure(options.cloudStorage)
  this._firebase = Firebase( options.firebase )
  this._fastly = Fastly( options.fastly )
  this._cloudflare = Cloudflare( options.cloudflare )
  this._deploys = Deploys( this._firebase.database().ref() )
  this._elastic = Elastic( options.elastic )
}

DeleteSite.prototype.delete = WebhookSiteDelete;

function WebhookSiteDelete ( siteName ) {
  console.log('delete-site:', siteName)
  var self = this;

  return getDeploys()
    .then( deleteSite )

  async function getDeploys () {
    try {
      const deployConfiguration = await self._deploys.get({ siteName })
      return deployConfiguration.deploys.map(d => d.bucket)
    }
    catch (error) {
      console.log('Could not get deploys for site.')
      console.log(error)
      throw error
    }
  }

  function deleteSite ( buckets ) {
    var deletors = []
      .concat( buckets.map( deleteCnameForSiteNameTask ) )
      .concat( buckets.map( deleteCDNDomain ) )
      .concat( self._firebase.deleteSite( { siteName } ) )
      .concat( self._elastic.deleteIndex( { siteName } ) )
      .concat( buckets.map( deleteStorageBucketTask ) )

    return Promise.all( deletors )
  }

  function deleteCnameForSiteNameTask ( siteName ) {
    return self._cloudflare.deleteCnameForSiteName( siteName )
      .catch( function () {
        console.log( 'Could not find a CNAME to remove.' )
        return Promise.resolve()
      } )
  }

  function deleteCDNDomain ( siteName ) {
    return new Promise( function ( resolve, reject ) {
      self._fastly.removeDomain( siteName, function ( error ) {
        console.log( 'delete-cdn-domain' )
        console.log( error )
        if ( error ) reject( error )
        else resolve()
      } )
    } )
  }

  function deleteStorageBucketTask ( siteName ) {
    return new Promise( function ( resolve, reject ) {
      cloudStorage.objects.deleteAll( siteName, function ( error ) {
        if ( error ) {
          console.log('delete:bucket:error:')
          console.log(error)
          return reject(resolve)
        }

        cloudStorage.buckets.del( siteName, function ( error ) {
          if ( ( error && error === 204 ) ) return resolve()
          else if ( ( error && error === 404 ) ) return resolve()
          else if ( ! error ) return resolve()
          else return reject( error )
        } )
      } )
    } )
  }
}

