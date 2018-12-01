var Cloudflare = require( 'cloudflare' )
var unescape = require( '../utils/firebase-unescape.js' )

module.exports = WHCloudFlare;

function WHCloudFlare ( options ) {
  if ( ! ( this instanceof WHCloudFlare ) ) return new WHCloudFlare( options )

  if ( options && options.client ) {
    options = options.client;
  }

  this._client = new Cloudflare( options )
}

WHCloudFlare.prototype.getZone = getZone;
WHCloudFlare.prototype.getCnames = getCnames;
WHCloudFlare.prototype.createCname = createCname;
WHCloudFlare.prototype.updateCname = updateCname;
WHCloudFlare.prototype.deleteCname = deleteCname;
WHCloudFlare.prototype.getCnameForSiteName = getCnameForSiteName;
WHCloudFlare.prototype.deleteCnameForSiteName = deleteCnameForSiteName;

function getZone ( bucket ) {
  var domain = domainForBucket( bucket )

  return this._client.browseZones( { name: domain } )
      .then( handleZones )

  function handleZones ( zones ) {
    var seekingZones = zones.result.filter( function ( zone ) { return zone.name === domain } )

    if ( seekingZones.length === 1 ) {
      return Promise.resolve( seekingZones[ 0 ] )
    } else {
      return Promise.resolve( false )
    }
  }

  function domainForBucket ( bucket ) {
    return unescape( bucket ).split( '.' ).slice( -2 ).join( '.' )
  }
}

function getCnames ( zone ) {
  if ( ! zone ) return Promise.reject( ZoneRequiredError )
  var zone_id = typeof zone === 'string'
    ? zone
    : zone.id;

  var client = this._client;

  var cnames = concatArray()

  return getCnameRecords( { page: 1 } )

  function getCnameRecords ( pagination ) {
    var getCnameOptions =  gatherCnameOptions( pagination )
    return client.browseDNS( zone_id, getCnameOptions )
      .then( handleCnameResponse )
  }

  function handleCnameResponse ( response ) {
    cnames( response.result )

    if ( response.page < response.totalPages ) {
      return getCnameRecords( { page: response.page + 1 } )
    }
    else {
      return Promise.resolve( cnames() )
    }
  }

  function gatherCnameOptions ( pagination ) {
    return Object.assign( { type: 'CNAME' }, pagination )
  }
}

function createCname ( recordValues ) {
  var cnameRecord = Cloudflare.DNSRecord.create( Object.assign( {}, recordValues ) )
  return this._client.addDNS( cnameRecord )
}

function updateCname ( cnameRecord ) {
  return this._client.editDNS( cnameRecord )
}

function deleteCname ( cnameRecord ) {
  return this._client.deleteDNS( cnameRecord )
}

function getCnameForSiteName ( siteName, zone ) {
  if ( siteName && zone ) {
    var resolveZone = Promise.resolve( zone )
  }
  else if ( siteName ) {
    var resolveZone = this.getZone( siteName )
  }
  
  return resolveZone
    .then( this.getCnames.bind( this ) )
    .then( pluckCnameForSiteName( siteName ) )

  function pluckCnameForSiteName ( siteName ) {
    return pluckCname;

    function pluckCname ( cnames ) {
      var siteCnameRecord = valueInArray( cnames, nameKey, unescape( siteName ) )
      if ( ! siteCnameRecord ) return Promise.resolve()
      else return Promise.resolve( siteCnameRecord )
    }
  }

  function valueInArray ( arr, keyFn, seekingValue ) {
    var index = arr.map( keyFn ).indexOf( seekingValue )
    if ( index === -1 ) return undefined;
    return arr[ index ]
  }

  function nameKey ( record ) {
    return record.name;
  }
}

function deleteCnameForSiteName ( siteName ) {
  var client = this._client;

  return this.getCnameForSiteName( siteName )
    .then( handleCnameRecord )

  function handleCnameRecord ( cnameRecord ) {
    if ( cnameRecord ) {
      return client.deleteDNS( cnameRecord )
    }
    else {
      return Promise.resolve()
    }
  }
}

function ZoneRequiredError () {
  return new Error( 'In order to get a CNAME, a `zone` DNS record is required, or the zone ID.' )
}

// helpers

function concatArray ( arr ) {
  if ( ! arr ) arr = []

  function getSet ( append ) {
    if ( ! append ) return arr
    if ( ! Array.isArray( append ) ) throw new Error( 'Must be an array.' )
    arr = arr.concat( append )
    return getSet;
  }

  return getSet;
}
