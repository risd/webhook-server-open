var firebaseUnescape = require( '../libs/utils/firebase-unescape' )
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
    buildSiteName: process.env.CREATE_SITE_NAME,
    buildUserId: process.env.BUILD_USER_ID,
    createUserId: process.env.CREATE_USER_ID,
    createSiteName: process.env.CREATE_SITE_NAME,
    createGithubUserRepo: process.env.CREATE_GITHUB_USER_REPO,
    createDeployBucket: process.env.CREATE_DEPLOY_BUCKET,
    createDeployBranch: process.env.CREATE_DEPLOY_BRANCH,
    domainUserId: process.env.BUILD_USER_ID,
    domainMapperSitename: process.env.CREATE_SITE_NAME,
    domainMapperKey: process.env.FASTLY_MAP_DOMAIN_KEY,
    domainMapperValue: process.env.FASTLY_MAP_DOMAIN_VALUE,
    inviteUser: process.env.CREATE_USER_ID,
    inviteSiteName: process.env.CREATE_SITE_NAME,
    redirectsSiteName: process.env.CREATE_SITE_NAME,
    siteIndexSiteName: process.env.CREATE_SITE_NAME,
    siteIndexUserId: process.env.CREATE_USER_ID,
    firebaseAdminSiteName: process.env.CREATE_SITE_NAME,
    serverSiteName: process.env.CREATE_SITE_NAME,
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
