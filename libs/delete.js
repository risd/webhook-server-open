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
      console.log('Could not get deploys for site', siteName)
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

  function deleteCnameForSiteNameTask ( bucket ) {
    return self._cloudflare.deleteCnameForSiteName( bucket )
      .catch( function () {
        console.log( 'Could not find a Cloudflare CNAME to remove', bucket )
        return Promise.resolve()
      } )
  }

  function deleteCDNDomain ( bucket ) {
    return self._fastly.removeDomain(bucket)
      .catch(function () {
        console.log('Could not remove domain from Fastly ', bucket)
        return Promise.resolve()
      })
  }

  function deleteStorageBucketTask ( bucket ) {
    return cloudStorage.objects.deleteAll(bucket)
      .then(() => {
        return cloudStorage.buckets.del(bucket)
      })
      .catch(() => {
        console.log('Could not delete cloud storage bucket ', bucket)
      })
  }
}

