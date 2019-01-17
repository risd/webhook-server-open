var Deploys = require( 'webhook-deploy-configuration' )
var Fastly = require( './fastly/index.js' )
var Cloudflare = require( './cloudflare/index.js' )
var Firebase = require( './firebase/index.js' )
var ElasticSearch = require( './elastic-search/index.js' )
var cloudStorage = require( './cloudStorage.js' )

module.exports = DeleteSite;

// todo, add cloud storage bucket removal

function DeleteSite ( options ) {
  if ( ! ( this instanceof DeleteSite ) ) return new DeleteSite( options )

  this._firebase = Firebase( options.firebase )
  this._fastly = Fastly( options.fastly )
  this._cloudflare = Cloudflare( options.cloudflare )
  this._deploys = Deploys( this._firebase.database() )
  this._elastic = ElasticSearch( options.elastic )
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
          console.log( 'Could not get deploys for site.' )
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
      .concat( self._elastic.deleteSite( { siteName: siteName } ) )
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
        console.log( error )
        if ( error ) {
          return reject( error )
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

function pluck ( key ){ return function ( obj ) { return obj[ key ]  } }
