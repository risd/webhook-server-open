const debug = require('debug')('deletor')
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
      .concat( deleteFirebaseReferences(siteName) )
      .concat( deleteElasticIndex(siteName) )
      .concat( buckets.map( deleteStorageBucketTask ) )

    return Promise.all( deletors )
  }

  function deleteElasticIndex (siteName) {
    return self._elastic.deleteIndex({ siteName })
      .catch((error) => {
        console.log('Could not delete elastic site index for siteName=', siteName)
        debug(error)
        return Promise.resolve()
      })
  }

  function deleteFirebaseReferences (siteName) {
    return self._firebase.deleteSite( { siteName } )
      .catch((error) => {
        console.log('Could not delete firebase references for siteName=', siteName)
        debug(error)
        return Promise.resolve()
      })
  }

  function deleteCnameForSiteNameTask ( bucket ) {
    return self._cloudflare.deleteCnameForSiteName( bucket )
      .catch( function (error) {
        console.log( 'Could not find a Cloudflare CNAME to remove', bucket )
        debug(error)
        return Promise.resolve()
      } )
  }

  function deleteCDNDomain ( bucket ) {
    return self._fastly.removeDomain(bucket)
      .catch(function (error) {
        console.log('Could not remove domain from Fastly ', bucket)
        debug(error)
        return Promise.resolve()
      })
  }

  function deleteStorageBucketTask ( bucket ) {
    return cloudStorage.objects.deleteAll(bucket)
      .then(() => {
        return cloudStorage.buckets.del(bucket)
      })
      .catch((error) => {
        console.log('Could not delete cloud storage bucket ', bucket)
        debug(error)
        return Promise.resolve()
      })
  }
}

