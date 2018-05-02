var path = require( 'path' )

module.exports = EnvOptions;

function EnvOptions ( options ) {
  if ( ! ( this instanceof EnvOptions ) ) return new EnvOptions( options )
  if ( typeof options !== 'object' ) options = {}

  require( 'dotenv-safe' ).load( {
    allowEmptyValues: true,
    path: path.join( process.cwd(), '.env.test' ),
    sample: path.join( process.cwd(), '.env.test.example' ),
  } )

  var envOptions = {
    fastlyAddDomain: process.env.FASTLY_ADD_DOMAIN,
    fastlyMapDomainKey: process.env.FASTLY_MAP_DOMAIN_KEY,
    fastlyMapDomainValue: process.env.FASTLY_MAP_DOMAIN_VALUE,
  }

  Object.assign( envOptions, options )

  Object.keys( envOptions ).forEach( undefinedIfEmptyString( envOptions ) )

  return envOptions;

  function undefinedIfEmptyString ( object ) {
    return function forKey ( key ) {
      var value = object[ key ]
      if ( typeof value === 'string' && value.length === 0 ) object[ key ] = undefined; 
    }
  }
}
