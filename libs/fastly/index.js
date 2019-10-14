var minimatch = require( 'minimatch' )
var miss = require( 'mississippi' )
var request = require( 'request' )
var assert = require( 'assert' )
var crypto = require( 'crypto' )
var Fastly = require( 'fastly' )
var async = require( 'async' )
var url = require( 'url' )

// base configuration of the service
var DICTIONARY_REDIRECT_HOSTS = 'dictionary_redirect_hosts';
var DICTIONARY_REDIRECT_URLS = 'dictionary_redirect_urls';
var DICTIONARY_HOST_BACKENDS = 'dictionary_host_backends'
var SNIPPET_RECV_REDIRECT_URLS = 'recv_redirect_urls';
var SNIPPET_RECV_REDIRECT_HOSTS = 'recv_redirect_hosts';
var SNIPPET_RECV_TRAILING_SLASH = 'recv_trailing_slash';
var SNIPPET_RECV_BACKEND_MAPPING = 'recv_backend_mapping';
var SNIPPET_FETCH_RESTORE_ORIGINAL_HOST = 'fetch_restore_original_host';
var SNIPPET_RECV_HOST_RISDDOTEDU_FORCE_HTTPS = 'host_risddotedu_force_https';
var SNIPPET_ERROR_REDIRECT = 'error_redirect_synthetic';
var GZIP_BASIC = 'gzip_basic';
var HEADER_CORS_ALLOW_ALL_ORIGINS = 'header_cors_allow_all_origins'

// todo
// update force_https to be based on process.env.FASTLY_DOMAINS values
// that have a `forceSSL` value set to true

module.exports = FastlyWebhookService;

function FastlyWebhookService ( options ) {
  if ( ! ( this instanceof FastlyWebhookService ) ) return new FastlyWebhookService( options )

  assert( typeof options === 'object', 'Requires an options object as first argument. Including `token` & `service_id` keys.' )
  assert( typeof options.token === 'string', 'Requires a `token` key in the options object that is a string of the Fastly API token.' )
  assert( typeof options.service_id === 'string', 'Requires a `service_id` key in the options object that is a string of the id of the Fastly service.' )

  var self = this;
  var token = options.token;

  // the one service that handles all traffic
  this._service_id = options.service_id;
  // the current version for that one service, starts as false
  this._version = false;
  this.unknownVersion = function () { return self._version === false; }
  // version is active starts as true.
  // only made false base internally updating the state
  this._version_is_active = true;
  // domain configuration : [ { domain, address, forceSSL } ]
  this._domains = ensureArray( options.domains )

  var fastly = Fastly( token )
  this.request = fastly.request.bind( fastly )
  this.jsonRequest = configFastlyJsonRequest( token )
}


FastlyWebhookService.prototype._activeVersion = getServiceActiveVersion;
FastlyWebhookService.prototype._ensureDevelopmentVersion = ensureDevelopmentVersion;
FastlyWebhookService.prototype.dictionary = dictionaryForName;
FastlyWebhookService.prototype.dictionaryId = dictionaryIdForName;
FastlyWebhookService.prototype.version = getSetVersion;
FastlyWebhookService.prototype.initialize = initializeService;
FastlyWebhookService.prototype.domain = addDomains;
FastlyWebhookService.prototype.removeDomain = removeDomains;
FastlyWebhookService.prototype.hasFastlyDomainConfiguration = hasFastlyDomainConfiguration;
FastlyWebhookService.prototype.isFastlyDomain = isFastlyDomain;
FastlyWebhookService.prototype.isSecureDomain = isSecureDomain;
FastlyWebhookService.prototype.addressForDomain = addressForDomain;
FastlyWebhookService.prototype.redirects = setRedirects;
FastlyWebhookService.prototype.mapDomain = mapDomain;
FastlyWebhookService.prototype.removeMapDomain = removeMapDomain;
FastlyWebhookService.prototype.maskForContentDomain = maskForContentDomain;
FastlyWebhookService.prototype.activate =activator;

/**
 * Activate the current service_id & version if it is not
 * currently active.
 *
 * @param  {function} complete The callback function to invoke when complete.
 */
function activator ( complete ) {
  var serviceOptions = {
    service_id: this._service_id,
    version: this.version(),
  }

  if ( this._version_is_active === true ) return complete( null, serviceOptions )

  var self = this;
  var activateOptions = Object.assign( { request: this.request }, serviceOptions )

  return activateVersion( activateOptions, function ( error, version ) {
    if ( error ) return complete( error )
    self._version_is_active = true;

    return complete( null, serviceOptions )
  } )
}

/**
 * Initialize the service. Given a service_id, ensure the service
 * is configured to handle interfacing with webhook fastly modules.
 * Internally manage the version so that new versions can be
 * activated as they are made.
 *
 * @param  {string} service_id  The `service_id` to initialize
 * @param  {function} complete  Called when the service has been initialized.
 *                              Returns ( error, ServiceVersion )
 */
function initializeService ( service_id, complete ) {
  if ( typeof service_id === 'string' ) this._service_id = service_id;
  if ( typeof service_id === 'function' ) complete = service_id;

  var self = this;

  // if any errors occur, bail and complete early
  var ifSuccess = handleError( complete )

  return this._activeVersion( ifSuccess( configureService( self.activate.bind( self, complete ) ) ) )

  function configureService ( continuation ) {
    return configurer;

    function configurer ( version ) {

      var updator = serviceConfigurationUpdater.apply( self )
      var getOrCreateTasks = [
          dictionaryArguments( DICTIONARY_REDIRECT_HOSTS ),
          dictionaryArguments( DICTIONARY_REDIRECT_URLS ),
          dictionaryArguments( DICTIONARY_HOST_BACKENDS ),
          snippetArguments( SNIPPET_RECV_REDIRECT_URLS ),
          snippetArguments( SNIPPET_RECV_REDIRECT_HOSTS ),
          snippetArguments( SNIPPET_ERROR_REDIRECT ),
          snippetArguments( SNIPPET_RECV_TRAILING_SLASH ),
          snippetArguments( SNIPPET_RECV_BACKEND_MAPPING ),
          snippetArguments( SNIPPET_FETCH_RESTORE_ORIGINAL_HOST ),
          snippetArguments( SNIPPET_RECV_HOST_RISDDOTEDU_FORCE_HTTPS ),
          gzipArguments( GZIP_BASIC ),
          headerArguments( HEADER_CORS_ALLOW_ALL_ORIGINS ),
        ]
        .map( updator.mapVersionedTask )

      return async.series( getOrCreateTasks, continuation )
    }
  }
}

/**
 * Get the current servie and active version number from Fastly
 * and set the variables that internally represent those values
 * within our abstraction.
 *
 * service_id : string? => complete : function => { service_id : string, version : string }
 *
 * @param  {string?} service_id Optionally pass in a service_id
 * @param  {function} complete  The callback function to invoke with the
 *                              current service_id &. version
 */
function getServiceActiveVersion ( service_id, complete ) {
  if ( typeof service_id === 'string' ) this._service_id = service_id;
  if ( typeof service_id === 'function' ) complete = service_id;

  var self = this;

  if ( self.version() !== false && self._version_is_active === true )
    return complete( null, { service_id: self.service_id, version: self.version() } )

  var ifSuccess = handleError( complete )

  return getService( this._service_id, ifSuccess( handleService( complete ) ) )

  function getService ( service_id, withService ) {
    self.request( 'GET', [ '/service', service_id ].join( '/' ), withService )
  }

  function handleService ( continuation ) {
    return serviceHandler;

    function serviceHandler ( service ) {
      self.version( activeVersionIn( service.versions ) )

      continuation( null, { service_id: self._service_id, version: self.version() } )
    }
  }
}

/**
 * Ensure's the version for the service_id is a cloned version
 * of the previously active version. Only cloned versions can be
 * developed on.
 *
 * If a current version is not set, acquire it, and clone it for
 * more development to occur on the newly cloned version.
 *
 * complete : function? => ( taskFn => { service_id, version } | undefined )
 *
 * @param  {[type]} complete [description]
 * @return {[type]}          [description]
 */
function ensureDevelopmentVersion ( complete ) {
  var self = this;

  var subtasks = [];
  if ( self.unknownVersion() ) subtasks = subtasks.concat( [ activeVersionTask ] )
  if ( self._version_is_active === true ) subtasks = subtasks.concat( [ cloneActiveVersion ] )

  if ( subtasks.length === 0 ) {
    if ( typeof complete === 'function' ) return complete( null, result() )
    else return;
  }
  if ( typeof complete === 'function' ) return taskFn( complete )

  return taskFn;

  function taskFn ( complete ) {
    async.waterfall( subtasks, complete )
  }

  function activeVersionTask ( taskComplete ) {
    self._activeVersion( taskComplete )
  }

  function cloneActiveVersion ( serviceMetadata, taskComplete ) {
    if ( typeof serviceMetadata === 'function' ) taskComplete = serviceMetadata;
    var service_id = self._service_id;
    var version = self.version();
    var urlStr = [ '/service', service_id, 'version', version, 'clone' ].join( '/' )
    var args = [ 'PUT', urlStr, setVersion ]

    self.request.apply( self, args )

    function setVersion ( error, clonedVersion ) {
      if ( error ) return taskComplete( error )
      // set the version number, this will set the version to internally
      self.version( clonedVersion.number )
      taskComplete( null, result() )
    }
  }

  function result () {
    return { service_id: self._service_id, version: self.version() }
  }
}

/**
 * Activate the version using the service id and API request function.
 * Callback with the result of the API call
 *
 * @param  {object} options
 * @param  {function} options.request   The API function to call
 * @param  {string} options.service_id  The service to call the activate API function on
 * @param  {string} options.version     The version to call the activate API function on
 * @param  {function} complete Callback ( error, version : { number : number, service_id : string } )
 */
function activateVersion ( options, complete ) {
  var request = options.request;
  var service_id = options.service_id;
  var version = options.version;
  var urlStr = [ '/service', service_id, 'version', version, 'activate' ].join( '/' )
  return request( 'PUT', urlStr, complete );
}

/**
 * Given a domain, return its configuration if it exists; else return null.
 *
 * @param {string} domain
 * @return {object|null}
 */
function hasFastlyDomainConfiguration ( domain ) {
  var domainConfigurations = this._domains.filter( isIncluded );

  function isIncluded ( included ) {
    return minimatch( domain, included.domain );
  }

  if ( domainConfigurations.length === 1 ) {
    return domainConfigurations[ 0 ]
  } else {
    return null;
  }
}

/**
 * Given a domain, return true if it is not a blacklisted domain.
 * Within webhook, we have development domains, that do not get
 * placed under fastly, and instead or handled directly through
 * cloudflare.
 *
 * @param  {string} domain
 * @return {boolean}
 */
function isFastlyDomain ( domain ) {
  return this._domains.filter( isIncluded ).length > 0;

  function isIncluded ( included ) {
    return minimatch( domain, included.domain );
  }
}

/**
 * Given a domain, return true if it is either an SSL-enabled Fastly domain
 * or a non-Fastly domain.
 *
 * @param {string} domain
 * @return {boolean}
 */
function isSecureDomain( domain ) {
  var isSecure = false;
  var domainConfiguration = hasFastlyDomainConfiguration.call( this, domain );

  if ( domainConfiguration ) {
    isSecure = domainConfiguration.forceSSL;
  } else {
    isSecure = true;
  }

  return isSecure;
}

/**
 * Given a domain, return the associated Fastly IP for the domain.
 * Returns false if the domain is not managed by Fastly.
 *
 * @param  {string} domain         The domain whose IP will be retrieved
 * @return {string|false} address  The address behind the Fastly domain
 */
function addressForDomain ( domain ) {
  var address = false;
  for (var i = 0; i < this._domains.length; i++) {
    if ( minimatch( domain, this._domains[ i ].domain ) ) {
      address = this._domains[ i ].address;
      break;
    }
  }
  return address;
}

/**
 * Add domain configuration for the supplied domains.
 * Add domain to host redirect table if it is a `www` subdomain or root domain.
 * The key will be opposite domain, with the value being the domain configured.
 *
 * @param {string|[string]} domains  String of domains to configure. Can be a single string, comman separated string, or array of strings representing domain names.
 * @param {function} complete  Called when the domain has been added.
 *                             Returns ( error, [ ServiceConfiguration ] )
 */
function addDomains ( domains, complete ) {
  if ( typeof domains === 'string' ) domains = domains.split( ',' )
  var self = this;

  // filter ignored domains
  domains = domains.filter( this.isFastlyDomain.bind( this ) )

  if ( domains.length === 0 ) return complete( null, { status: 'ok', noDomainsAdded: true } )

  // tasks to execute in order to add the domain
  var tasks = [];
  if ( this.unknownVersion() ) tasks = tasks.concat( [ activeVersionTask ] )

  var updator = serviceConfigurationUpdater.apply( this )

  var addDomainTasks = addRootAndWwwDomains( domains ).map( addDomainArguments ).map( updator.mapVersionedTask )
  tasks = tasks.concat( addDomainTasks )

  tasks = tasks.concat( redirectHostOperationsFor( domains ) )

  return async.series( tasks, handleCallbackError( complete )( self.activate.bind( self, complete ) ) )

  function activeVersionTask ( taskComplete ) {
    return self._activeVersion( taskComplete )
  }

  function redirectHostOperationsFor ( domains ) {
    var addRootRedirectDomains = domains.filter( isWwwDomain )
    var addWwwRedirectDomains = domains.filter( isRootDomain )
    var redirectDomains = addRootRedirectDomains.concat( addWwwRedirectDomains )

    if ( redirectDomains.length === 0 ) return [];

    var addRootRedirectArguments = addRootRedirectDomains.map( redirectRootArguments )
    var addWwwRedirectArguments = addWwwRedirectDomains.map( redirectWwwArguments )
    var redirectHostArguments = addRootRedirectArguments.concat( addWwwRedirectArguments )

    var redirectDictionaryItemArguments = { operations: operations }

    return [ addDictionaryId, redirectHostDictionaryUpdate ]

    function addDictionaryId ( taskComplete ) {
      self.dictionaryId( DICTIONARY_REDIRECT_HOSTS, function ( error, dictionaryId ) {
        if ( error ) return taskComplete( error )
        redirectDictionaryItemArguments.id = dictionaryId;
        taskComplete()
      } )
    }

    function redirectHostDictionaryUpdate ( taskComplete ) {
      updator.mapVersionlessTask( apiDictionaryItemArguments( redirectDictionaryItemArguments ) )( taskComplete )
    }

    function operations ( redirectHostsTable ) {
      var ops = [];

      for (var j = 0; j < redirectHostArguments.length; j++) {
        var operationBase = redirectHostArguments[ j ]
        var op = 'create';

        for (var i = 0; i < redirectHostsTable.length; i++) {
          if ( redirectHostsTable[ i ].item_key === operationBase.item_key ) {
            if ( redirectHostsTable[ i ].item_value === operationBase.item_value ) {
              op = false; // already exists
              continue;
            }
            else {
              op = 'update'
              continue;
            }
          }
        }

        if ( op ) ops = ops.concat( [ Object.assign( { op: op }, operationBase ) ] )
      }

      return ops;
    }
  }
}

/**
 * Ensure the dictionary_host_backends table includes
 * the maskDomain as a key, and the content domain as
 * its value.
 *
 * @param  {object|array} options[]
 * @param  {string} options[].maskDomain
 * @param  {string} options[].contentDomain
 * @param  {function} complete The callback function to call upon completion
 */
function mapDomain ( options, complete ) {
  var self = this;
  if ( ! Array.isArray( options ) && typeof options === 'object' ) options =  [ options ]

  var mapDomainOptions = options.map( toMapDomainOptions )

  // This function performs a series of tasks that update this object
  // which represents the arguments for a series of functions that will
  // update the appropriate table in Fastly
  var mapDomainItemArguments = { operations: mapDomainOperationsFor( mapDomainOptions ) }

  var tasks = [ dictionaryIdForName( DICTIONARY_HOST_BACKENDS  ), mapDomainDictionaryUpdateFor( mapDomainItemArguments ) ];

  return async.series( tasks, function ( error, taskResults ) {
    if ( error ) return complete ( error )
    complete( null, taskResults[ taskResults.length - 1 ] )
  } )

  function toMapDomainOptions ( domainPair ) {
    return { item_key: domainPair.maskDomain, item_value: domainPair.contentDomain }
  }

  function mapDomainOperationsFor ( mapDomains ) {
    return function mapDomainOperations ( hostBackendTable ) {
      var ops = []

      for (var i = 0; i < mapDomains.length; i++) {
        var op = 'create';
        var baseOperation = mapDomains[ i ];

        for (var j = 0; j < hostBackendTable.length; j++) {
          if ( hostBackendTable[ j ].item_key === baseOperation.item_key ) {
            if ( hostBackendTable[ j ].item_value === baseOperation.item_value ) {
              // key & value pair already exists, do nothing
              op = false;
            }
            else {
              // key exists with another value, patch the value
              op = 'update'
            }
          }
        }

        if ( op ) ops = ops.concat( [ Object.assign( { op: op }, baseOperation ) ] )
      }

      return ops;
    }
  }

  function dictionaryIdForName ( dictionaryName ) {
    return function addDictionaryId ( taskComplete ) {
      self.dictionaryId( dictionaryName, function ( error, dictionaryId ) {
        if ( error ) return taskComplete( error )
        mapDomainItemArguments.id = dictionaryId;
        taskComplete()
      } )
    }
  }

  function mapDomainDictionaryUpdateFor ( dictionaryItemArguments ) {
    return function mapDomainDictionaryUpdate ( taskComplete ) {
      serviceConfigurationUpdater.apply( self )
        .mapVersionlessTask( apiDictionaryItemArguments( dictionaryItemArguments ) )( taskComplete )

    }
  }
}

/**
 * Ensure the dictionary_host_backends table does not include
 * the maskDomain as a key.
 *
 * @param  {object|array} options[]
 * @param  {string} options[].maskDomain
 * @param  {function} complete The callback function to call upon completion
 */
function removeMapDomain ( options, complete ) {
  var self = this;
  if ( ! Array.isArray( options ) && typeof options === 'object' ) options = [ options ]

  var removeMapDomainOptions = options.map( toRemoveMapDomainOptions )

  // This function is a series of tasks that update this object
  // which represents the arguments for a series of functions that will
  // update the appropriate table in fastly
  var removeMapDomainItemArguments = { operations: removeMapDomainOperationsFor( removeMapDomainOptions ) }

  var tasks = [ dictionaryIdForName( DICTIONARY_HOST_BACKENDS ), mapDomainDictionaryUpdateFor( removeMapDomainItemArguments )  ]

  return async.series( tasks, function ( error, taskResults ) {
    if ( error ) return complete ( error )
    complete( null, taskResults[ taskResults.length - 1 ] )
  } )

  function toRemoveMapDomainOptions( domainSingle ) {
    return { item_key: domainSingle.maskDomain }
  }

  function removeMapDomainOperationsFor ( removeMapDomains ) {
    return function removeMapDomainOperations( hostBackendTable ) {
      var ops = [];

      for (var i = 0; i < removeMapDomains.length; i++) {
        var baseOperation = removeMapDomains[ i ];
        var op = false;  // do nothing by default

        for (var j = 0; j < hostBackendTable.length; j++) {
          if ( hostBackendTable[ j ].item_key === baseOperation.item_key ) {
            op = 'delete' // there is a matching key, lets remove it
          }
        }

        if ( op ) ops = ops.concat( [ Object.assign( { op: op }, baseOperation ) ] )
      }

      return ops;
    }
  }

  function dictionaryIdForName ( dictionaryName ) {
    return function addDictionaryId ( taskComplete ) {
      self.dictionaryId( dictionaryName, function ( error, dictionaryId ) {
        if ( error ) return taskComplete( error )
        removeMapDomainItemArguments.id = dictionaryId;
        taskComplete()
      } )
    }
  }

  function mapDomainDictionaryUpdateFor ( dictionaryItemArguments ) {
    return function mapDomainDictionaryUpdate ( taskComplete ) {
      serviceConfigurationUpdater.apply( self )
        .mapVersionlessTask( apiDictionaryItemArguments( dictionaryItemArguments ) )( taskComplete )

    }
  }
}


/**
 * Retrieves the mask domain for the specified content domain.
 * If there is no mask domain, return undefined.
 *
 * ( contentDomain : string, complete ) => ( error, maskDomain : string | undefined )
 *
 * @param  {string} contentDomain The value to find in the dictionary_host_backends table
 * @param  {function} complete    The function to invoke with the maskDomain value.
 */
function maskForContentDomain ( contentDomain, complete ) {
  assert( typeof contentDomain === 'string', 'Content domain is a string.')
  assert( typeof complete === 'function', 'Complete callback is a function.' )
  var self = this;

  var tasks = [ getDictionaryId( DICTIONARY_HOST_BACKENDS ), getDictionaryItems ]

  async.waterfall( tasks, returnMaskDomainFor( contentDomain, complete ) )

  function getDictionaryId ( dictionaryName ) {
    return function task ( taskComplete ) {
      self.dictionaryId( dictionaryName, taskComplete )
    }
  }

  function getDictionaryItems ( dictionaryId, taskComplete ) {
    var dictionaryItemsUrl = [ '/service', self._service_id, 'dictionary', dictionaryId, 'items' ].join( '/' )
    self.request( 'GET', dictionaryItemsUrl, taskComplete)
  }

  function returnMaskDomainFor ( contentDomain, taskComplete ) {
    return function withDictionaryItems ( error, dictionaryItems ) {
      if ( error ) return taskComplete( error )

      var maskDomain = undefined;
      var hasContentDomain = dictionaryItems.filter( valueIsContentDomain )
      if ( hasContentDomain.length === 1 ) maskDomain = hasContentDomain[ 0 ].item_key;

      return taskComplete( null, maskDomain )

      function valueIsContentDomain ( dictionaryItem ) {
        return dictionaryItem.item_value === contentDomain;
      }
    }
  }
}

/* domain {add,remove} helpers */

function isWwwDomain ( domain ) {
  var parts = domain.split( '.' )
  return ( parts[ 0 ] === 'www' && parts.length === 3 )
}

function isRootDomain ( domain ) {
  var parts = domain.split( '.' )
  return ( parts.length === 2 )
}

function addRootAndWwwDomains ( domains ) {
  var additionalDomains = []
  for (var i = domains.length - 1; i >= 0; i--) {
    if ( isWwwDomain( domains[ i ] ) ) {
      additionalDomains = additionalDomains.concat( [ domains[ i ].slice( 4 ) ] )
    }
    else if ( isRootDomain( domains[ i ] ) ) {
      additionalDomains = additionalDomains.concat( [ ( 'www.' + domains[ i ] ) ] )
    }
  }
  return domains.concat( additionalDomains )
}

function redirectRootArguments ( domain ) {
  var redirectDomain = domain.slice( 4 )
  return { item_key: redirectDomain, item_value: domain }
}

function redirectWwwArguments ( domain ) {
  var redirectDomain = [ 'www', domain ].join( '.' )
  return { item_key: redirectDomain, item_value: domain }
}

/* domain {add,remove} helpers:end */

/**
 * Given a domain, or list of domains, remove them from the active Fastly configuration.
 * @param  {string|string[]} domains
 * @param  {Function} complete
 */
function removeDomains ( domains, complete ) {
  if ( typeof domains === 'string' ) domains = domains.split( ',' )
  var self = this;
  var service_id = self._service_id;

  domains = domains.filter( this.isFastlyDomain.bind( this ) )

  if ( domains.length === 0 ) return complete( null, { status: 'ok', noDomainsRemoved: true } )

  // remove the domain
  // remove the redirects
  var tasks = [];
  if ( this.unknownVersion() ) tasks = tasks.concat( [ activeVersionTask ] )
  tasks = tasks.concat( addRootAndWwwDomains( domains ).map( mapDomainsToRemoveTask ) )
    .concat( domains.map( mapPathRedirectsRemoveTask ) )
    .concat( domains.map( mapHostRedirectsRemoveTask ) )

  return async.series( tasks, handleCallbackError( complete )( self.activate.bind( self, complete ) ) )

  function activeVersionTask ( taskComplete ) {
    return self._activeVersion( taskComplete )
  }

  // removes the domain configuration
  function mapDomainsToRemoveTask ( domain ) {
    var urlFn = function () {
      return [ '/service', service_id, 'version', self.version(), 'domain', domain ].join( '/' )
    }
    return function removeTask ( taskComplete ) {

      return async.waterfall( [ getSubTask, conditionalVersionClone, removeSubTask ], taskComplete )

      function getSubTask ( subTaskComplete ) {
        self.request( 'GET', urlFn(), function ( error, domainMetadata ) {
          if ( error ) return subTaskComplete( null, null )
          subTaskComplete( null, domainMetadata )
        } )
      }

      function conditionalVersionClone ( domainMetadata, subTaskComplete ) {
        if ( ! domainMetadata ) return subTaskComplete( null, null )
        self._ensureDevelopmentVersion( subTaskComplete )
      }

      function removeSubTask ( serviceState, subTaskComplete ) {
        if ( ! serviceState ) return subTaskComplete( null, { status: 'ok' } )
        self.request( 'DELETE', urlFn(), subTaskComplete )
      }
    }
  }

  // removes the dictionary redirects
  function mapPathRedirectsRemoveTask ( domain ) {
    var redirectsOptions = { host: domain, redirects: [] }
    return function dictionaryRemoveTask ( taskComplete ) {
      console.log( 'remove:redirects' )
      return self.redirects( redirectsOptions, taskComplete )
    }
  }

  function mapHostRedirectsRemoveTask ( domain ) {
    var removeRootRedirectDomains = [ domain ].filter( isWwwDomain )
    var removeWwwRedirectDomains =  [ domain ].filter( isRootDomain )

    var removeRootRedirectArguments = removeRootRedirectDomains.map( redirectRootArguments )
    var removeWwwRedirectArguments = removeWwwRedirectDomains.map( redirectWwwArguments )

    var removeHostRedirectArguments = removeRootRedirectArguments.concat( removeWwwRedirectArguments )

    return function removeHostRedirectsTask ( taskComplete ) {
      console.log( 'map-host-redirects-remove-task' )
      return async.waterfall( [ getDictionaryId, redirectHostDictionaryUpdate ], taskComplete )
    }

    function getDictionaryId ( taskComplete ) {
      console.log( 'get-dictionary-id' )
      self.dictionaryId( DICTIONARY_REDIRECT_HOSTS, taskComplete )
    }

    function redirectHostDictionaryUpdate ( dictionaryId, taskComplete ) {
      console.log( `redirect-host-dictionary-update:${ dictionaryId }` )
      var redirectDictionaryItemArguments = { id: dictionaryId, operations: operations }
      var updator = serviceConfigurationUpdater.apply( self )
      updator.mapVersionlessTask( apiDictionaryItemArguments( redirectDictionaryItemArguments ) )( taskComplete )
    }

    function operations ( redirectHostsTable ) {
      var ops = []

      for (var i = removeHostRedirectArguments.length - 1; i >= 0; i--) {
        var operationBase = removeHostRedirectArguments[ i ]
        var op = false

        for (var j = redirectHostsTable.length - 1; j >= 0; j--) {
          if ( redirectHostsTable[ j ].item_key === operationBase.item_key ) {
            op = 'delete'
          }
        }

        if ( op ) ops = ops.concat( [ Object.assign( { op: op }, operationBase ) ] )
      }

      return ops;
    }
  }
}

/**
 * Sets redirects for service based on options.
 * Redirects are saved as dictionary values for one : one redirects,
 * and snippets for regex based redirects.
 *
 * redirect : { pattern : string, destination : string }
 * redirects : [ redirect ]
 * host : string
 * options : { host, redirects }
 *
 * @param {object} options
 * @param {string} options.host
 * @param {object} options.redirects
 * @param {object} options.redirects.pattern
 * @param {object} options.redirects.destination
 * @param {function} complete  The function to call upon completion.
 */
function setRedirects ( options, complete ) {
  var self = this;

  var redirects = options.redirects
    .filter( patternWithProtocolOrHost )
    .filter( sameUrl )

  async.series( [
    setDictionaryRedirectsTask( Object.assign( {}, options, { redirects: redirects.filter( isNotRegex ) } ) ),
    setSnippetRedirectTasks( Object.assign( {}, options, { redirects: redirects.filter( isRegex ) } ) )
  ], complete )

  function setDictionaryRedirectsTask ( args ) {
    return function task ( taskComplete ) {
      setDictionaryRedirects.apply( self, [ args, debugCallback( 'dictionary', taskComplete ) ] )
    }
  }

  function setSnippetRedirectTasks ( args ) {
    return function task ( taskComplete ) {
      console.log( 'set-snippet-redirects' )
      setSnippetRedirects.apply( self, [ args, debugCallback( 'snippets', taskComplete ) ] )
    }
  }

  function isRegex ( redirect ) {
    return redirect.pattern.match( /\^|\\|\$/g )
  }

  function isNotRegex ( redirect ) {
    return !isRegex( redirect )
  }

  function patternWithProtocolOrHost ( redirect ) {
    var parsedPattern = url.parse( redirect.pattern )
    return parsedPattern.protocol === null && parsedPattern.host === null
  }

  function sameUrl ( redirect ) {
    var parsedPattern = url.parse( redirect.pattern )
    var parsedDestination = url.parse( redirect.destination )
    var areTheSame = (
      parsedPattern.protocol === parsedDestination.protocol &&
      parsedPattern.host === parsedDestination.host &&
      parsedPattern.path === parsedDestination.path)
    return ! areTheSame;
  }
}

/**
 * Set one : one redirects as dictionary keys and values.
 *
 * redirect : { pattern : string, destination : string }
 * redirects : [ redirect ]
 * host : string
 * options : { host, redirects }
 *
 * @param {object} options
 * @param {string} options.host
 * @param {object} options.redirects
 * @param {object} options.redirects.pattern
 * @param {object} options.redirects.destination
 * @param {function} complete  The function to call upon completion.
 */
function setDictionaryRedirects ( options, complete ) {
  var self = this;

  var updator = serviceConfigurationUpdater.apply( this )

  var args = { operations: dictionaryOperations( options ) }

  var tasks = [ populateDictionaryId, patchDictionaryRedirects ]

  async.waterfall( tasks, complete )

  // adds { id : dictionaryId : string }
  function populateDictionaryId ( taskComplete ) {
    self.dictionaryId( DICTIONARY_REDIRECT_URLS, function ( error, dictionaryId ) {
      if ( error ) return taskComplete( error )
      taskComplete( null, Object.assign( args, { id: dictionaryId } ) )
    } )
  }

  // ( args : { id, operations } ) => ( error?, statusObject : { status : string } )
  function patchDictionaryRedirects ( args, taskComplete ) {
    updator.mapVersionlessTask( apiDictionaryItemArguments( args ) )( taskComplete )
  }

  // ( host, redirects ) => ( dictionaryRedirectsTable : [ item_key : string, item_value : string ] ) => ( operations : [ op : 'create'|'delete'|'update', item_key : string, item_value : string? ] )
  function dictionaryOperations ( options ) {
    var host = options.host;
    var cmsRedirects = options.redirects.map( prefix( host ) );
    var isHostRedirect = function ( cdnRedirect ) {
      return cdnRedirect.item_key.startsWith( host )
    }
    return function createOperationsList ( dictionaryRedirectsTable ) {
      dictionaryRedirectsTable = dictionaryRedirectsTable.filter( isHostRedirect )
      var ops = cmsRedirects.map( createOrUpdateOperations ).filter( isNotFalse )
          .concat( dictionaryRedirectsTable.map( deleteOperations ).filter( isNotFalse ) )

      return ops;

      function createOrUpdateOperations ( cmsRedirect ) {
        for (var i = 0; i < dictionaryRedirectsTable.length; i++) {
          if ( dictionaryRedirectsTable[ i ].item_key === cmsRedirect.pattern ) {
            if ( dictionaryRedirectsTable[ i ].item_value === cmsRedirect.destination ) {
              return false; // already exists
            }
            else {
              // exists with different value than is currently set, lets update
              return opFor( 'update', cmsRedirect )
            }
          }
        }
        // does not exist, lets create
        return opFor( 'create', cmsRedirect )

        function opFor ( operation, redirect ) {
          return {
            op: operation,
            item_key: redirect.pattern,
            item_value: redirect.destination,
          }
        }
      }

      function deleteOperations( cdnRedirect ) {
        for (var i = 0; i < cmsRedirects.length; i++) {
          if ( cmsRedirects[ i ].pattern === cdnRedirect.item_key ) return false;
        }
        return { op: 'delete', item_key: cdnRedirect.item_key }
      }
    }

    function prefix ( prefixStr ) {
      return function prefixer ( objToPrefix ) {
        Object.keys( objToPrefix ).forEach( function ( key ) {
          if ( objToPrefix[ key ].startsWith( '/' ) ) {
            objToPrefix[ key ] = [ prefixStr, objToPrefix[ key ] ].join( '' )
          }
        } )
        return objToPrefix;
      }
    }
  }
}

/**
 * Set many : one redirects as snippets in fastly.
 *
 * redirect : { pattern : string, destination : string }
 * redirects : [ redirect ]
 * host : string
 * options : { host, redirects }
 *
 * @param {object} options
 * @param {string} options.host
 * @param {object} options.redirects
 * @param {object} options.redirects.pattern
 * @param {object} options.redirects.destination
 * @param {function} complete  The function to call upon completion.
 */
function setSnippetRedirects ( options, complete ) {
  var self = this;
  var host = options.host;
  var snippetContentFor = snippetContentFactory( host )
  var snippetNameFor = snippetNameFactory( host )

  var tasks = [ updateSnippets( options ), activateVersion ]

  return async.series( tasks, complete )

  function updateSnippets ( options ) {
    return function updateSnippetsTask ( taskComplete ) {
      var subtasks = [ getCdnRedirectSnippets, createOperationsFrom( options ), conditionalVersionClone, executeOperations ]
      return async.waterfall( subtasks, taskComplete )
    }
  }

  function activateVersion ( taskComplete ) {
    return self.activate( taskComplete )
  }

  // () => cdnSnippets : [ { name : string, content : string, ... } ]
  function getCdnRedirectSnippets ( taskComplete ) {
    var apiRequest = self.request;
    var service_id = self._service_id;
    var version = self.version();

    var urlStr = [ '/service', service_id, 'version', version, 'snippet' ].join( '/' )

    console.log( `get-cdn:${ urlStr }` )

    apiRequest( 'GET', urlStr, taskComplete )
  }

  // options => cdnSnippets => cdnOperations : [ [ method, urlStr, body ] ]
  function createOperationsFrom ( options ) {
    var service_id = self._service_id;
    var version = self.version();

    var host = options.host;
    var redirects = options.redirects;
    var isHostRedirect = isRedirectForHost( host )

    return operationsMaker;

    function operationsMaker ( cdnSnippets, taskComplete ) {
      console.log( 'operations-maker' )

      var hostRedirects = cdnSnippets.filter( isHostRedirect )

      var cdnOperations = redirects.map( createOperations( hostRedirects ) ).filter( isNotFalse )
        .concat( hostRedirects.map( deleteOperations( redirects ) ).filter( isNotFalse ) )

      taskComplete( null, cdnOperations )
    }

    function isRedirectForHost ( host ) {
      var snippetHostPrefix = snippetNamePrefix( host )
      return function isRedirect ( redirect ) {
        return redirect.name.startsWith( snippetHostPrefix )
      }
    }

    // [ VCLSnippet ] => { pattern, destination } => [ method : string, urlStr : string, body : VCLSnippet ]
    function createOperations ( cdnRedirects ) {
      return function forRedirect ( redirect ) {
        var snippetName = snippetNameFor( redirect )
        for (var i = cdnRedirects.length - 1; i >= 0; i--) {
          // already exists
          if ( cdnRedirects[ i ].name === snippetName ) return false;
        }
        // do not exist, lets make it.
        var createBody = {
          name: snippetName,
          priority: 100,
          dynamic: 1,
          type: 'recv',
          content: snippetContentFor( redirect ),
        }
        return op.bind( self, createBody )

        function op ( createBody ) {
          return [ 'POST', urlFn(), createBody ]
          function urlFn () {
            return [ '/service', service_id, 'version', self.version(), 'snippet' ].join( '/' )
          }
        }
      }
    }

    // [ { pattern, destination } ] => VCLSnippet => [ method : string, urlStr : string, body : {} ]
    function deleteOperations ( redirects ) {
      var deleteBody = {};

      return function forSnippet ( cdnSnippet ) {
        for (var i = redirects.length - 1; i >= 0; i--) {
          // exists, should not be deleted
          if ( snippetNameFor( redirects[ i ] ) === cdnSnippet.name ) return false;
        }
        // does not exist, lets delete
        return op.bind( self, cdnSnippet, deleteBody )
      }

      function op ( cdnSnippet, deleteBody ) {
        return [ 'DELETE', urlFn(), deleteBody ]
        function urlFn () {
          return [ '/service', service_id, 'version', self.version(), 'snippet', cdnSnippet.name ].join( '/' )
        }
      }
    }
  }

  function conditionalVersionClone ( cdnOperations, taskComplete ) {
    if ( cdnOperations.length === 0 ) return taskComplete( null, cdnOperations )
    self._ensureDevelopmentVersion( function ( error ) {
      if ( error ) return taskComplete( error )
      taskComplete( null, cdnOperations )
    } )
  }

  // cdnOperations => results
  function executeOperations ( cdnOperations, taskComplete ) {
    if ( cdnOperations.length === 0 ) {
      return taskComplete()
    }

    return async.parallelLimit( cdnOperations.map( executeTask ), 10, taskComplete )

    function executeTask ( operation ) {
      if ( typeof operation !== 'function' ) console.log( operation )
      return function task ( taskComplete ) {
        var args = operation().concat( [ taskComplete ] )
        self.request.apply( self, args )
      }
    }
  }

  function snippetNameFactory ( host ) {
    return function snippetNameFor ( redirect ) {
      return `${ snippetNamePrefix( host ) }_${ hashForContent( snippetContentFor( redirect ) ) }`

      function hashForContent( content ) {
        var hash = crypto.createHash('md5').update(content).digest('base64')
        var base36 = {
          encode: function (str) {
            return Array.prototype.map.call(str, function (c) {
              return c.charCodeAt(0).toString(36);
            }).join("");
          },
          decode: function (str) {
            //assumes one character base36 strings have been zero padded by encodeAscii
            var chunked = [];
            for (var i = 0; i < str.length; i = i + 2) {
              chunked[i] = String.fromCharCode(parseInt(str[i] + str[i + 1], 36));
            }
            return chunked.join("");
          },
          encodeAscii: function (str) {
            return Array.prototype.map.call(str, function (c) {
              var b36 = base36.encode(c, "");
              if (b36.length === 1) {
                b36 = "0" + b36;
              }
              return b36;
            }).join("")
          },
          decodeAscii: function (str) {
            //ignores special characters/seperators if they're included
            return str.replace(/[a-z0-9]{2}/gi, function (s) {
              return base36.decode(s);
            })
          }
        }

        return base36.encodeAscii( hash )
      }
    }
  }

  function snippetNamePrefix ( host ) {
    return `redirect_${ host }`
  }

  function snippetContentFactory ( host ) {
    return function snippetContentFor ( redirect ) {
      return `if ( req.http.host == "${ host }" && req.url.path ~ "${ redirect.pattern }" ) {
        set req.http.x-redirect-location = "http://" req.http.host "${ redirect.destination }";
        error 301;
      }`
    }
  }

}

function dictionaryIdForName ( name, complete ) {
  var self = this;
  this.dictionary( name, function ( error, dictionary ) {
    if ( error ) return complete( error )
    return complete( null, dictionary.id )
  } )
}

function dictionaryForName ( name, complete ) {
  var self = this;
  var tasks = []
  if ( self.version() === false ) tasks = tasks.concat( [ activeVersionTask ] )

  tasks = tasks.concat( dictionaryTask )

  async.series( tasks, function ( error, results ) {
    if ( error ) return complete( error )
    // the dictionary is in the last result
    complete( null, results[ results.length - 1 ] )
  } )

  function  activeVersionTask ( taskComplete ) {
    return self._activeVersion( taskComplete )
  }

  function dictionaryTask ( taskComplete ) {
    var dictionaryNameUrl = [ '/service', self._service_id, 'version', self.version(), 'dictionary', name ].join( '/' )
    self.request( 'GET', dictionaryNameUrl, taskComplete )
  }

}

function serviceConfigurationUpdater () {
  var self = this;

  return {
    mapVersionedTask: mapVersionedTask,
    mapVersionlessTask: mapVersionlessTask,
  }

  /**
   * Gets items from fastly, runs an operations function to
   * produce an array of operations objects, which get patched
   * back into the versionless item.
   *
   * @param  {object} args
   * @param  {String} args.type            ('dictionary'|'acl')
   * @param  {Function} args.operations    Expects the results of the GET function, returns input of PATCH function.
   * @param  {object} args.get             Base arguments for the GET function
   * @param  {string} args.get.id          The ID of the versionless asset
   * @param  {string} args.get.property    The named property of the versionless asset
   * @param  {object} args.patch           Base arguments for the PATCH function
   * @param  {string} args.patch.id        The ID of the versionless asset
   * @param  {string} args.patch.property  The named property of the versionless asset
   * @return {Function} task               completeFn -> getFn -> operationsFn -> patchFn
   */
  function mapVersionlessTask ( args ) {
    return function task ( taskComplete ) {
      var apiRequest = self.request;
      var service_id = self._service_id;

      var urlStr = [ '/service', service_id, args.type, args.id, args.property ].join( '/' )

      console.log( `map-version-less-task:${ urlStr }` )

      self.request( 'GET', urlStr, function ( error, items ) {
        if ( error ) return taskComplete( error )

        console.log( `map-version-less-task:items` )

        var itemOperations = args.operations( items )

        if ( itemOperations.length === 0 ) return taskComplete( null, null )

        // account for itemOperations > 1000. split into thousands
        var maxOperations = 1000;
        var patchRequests = Math.ceil( itemOperations.length / maxOperations )

        var patchTasks = []
        for (var i = patchRequests - 1; i >= 0; i--) {
          var startSubset = i * maxOperations;
          var endSubset = ( i + 1 ) * maxOperations;
          var operationsSubset = itemOperations.slice( startSubset, endSubset )
          patchTasks = patchTasks.concat( [ patchOperations( operationsSubset ) ] )
        }

        console.log( `patch-tasks:${ patchTasks.length }` )

        if ( patchTasks.length === 1 ) return patchTasks[ 0 ]( taskComplete )

        return async.series( patchTasks, taskComplete )

        function patchOperations( operations ) {
          var patchBody = {}
          patchBody[ args.property ] = operations;
          return function patchTask ( subTaskComplete ) {
            self.jsonRequest( 'PATCH', urlStr, patchBody, function ( error, status ) {
              if ( error ) return subTaskComplete( error )
              subTaskComplete( null, status )
            } )
          }
        }
      } )
    }
  }

  /**
   * Get items from fastly, if result is obtained, run a check to see
   * if the result should be updated. If the get items query fails, post
   * the items.
   *
   * @param  {object} args
   * @param  {string} args.type  ('snippet'|'dictionary'|'domain')
   * @param  {Function} args.checkUpdate ( result => (undefined|function) ) given the result of the get request, return a function that will produce arguments for the update request, or an undefined value to not execute the update.
   * @param  {object} args.get           Gets data
   * @param  {string} args.get.id
   * @param  {string} args.get.property
   * @param  {object} args.put           Updates data if `checkPut` returns a function.
   * @param  {object} args.put.id
   * @param  {object} args.put.property
   * @param  {object} args.put.content
   * @param  {object} args.post          Creates data if it did not exist on the get request
   * @param  {string} args.post.id
   * @param  {string} args.post.property
   * @return {Function} task
   */
  function mapVersionedTask ( args ) {
    return function task ( taskComplete ) {
      var ifError = handleCallbackSuccess( checkGetForUpdate( args, taskComplete ) )
      getRequestVersioned( args, ifError( callFnWithArgs( postRequestVersioned.bind( self, args, taskComplete ) ) ) )
    }
  }

  function getRequestVersioned ( args, complete ) {
    var apiRequest = self.request;
    var service_id = self._service_id;
    var version = self.version()

    var urlStr = [ '/service', service_id, 'version', version, args.type, args.get.name ].join( '/' )

    apiRequest( 'GET', urlStr, complete )
  }

  function checkGetForUpdate ( args, taskComplete ) {
    var apiRequest = self.request;
    var service_id = self._service_id;

    return function getSuccessfulResponse ( error, getResult ) {
      if ( typeof args.checkUpdate !== 'function' ) return taskComplete( null, getResult )

      var tasks = []

      if ( args.type === 'snippet' ) tasks = tasks.concat( [ getSnippet ] )

      tasks = tasks.concat( [ checkGetForUpdate, ifUpdateEnsureDevelopementVersion, putUpdate ] )
      return async.waterfall( tasks, taskComplete )

      function getSnippet ( subTaskComplete ) {
        var getSnippetUrl = [ '/service', service_id, args.type, getResult.id ].join( '/' )
        return apiRequest( 'GET', getSnippetUrl, subTaskComplete )
      }

      function checkGetForUpdate ( cdnSnippet, subTaskComplete ) {
        // occurs in the case of gzip, where fetching
        if ( typeof cdnSnippet === 'function' ) subTaskComplete = cdnSnippet;

        try {
          if ( args.type === 'snippet' ) {
            var updateArgsFn = args.checkUpdate( cdnSnippet )
            var updateArgs = updateArgsFn( {
              service_id: service_id,
              snippet_id: getResult.id,
            } )
          }
          else if ( args.type === 'gzip' ) {
            var updateArgsFn = args.checkUpdate( getResult )
            var updateArgs = updateArgsFn( {
              service_id: service_id,
              name: getResult.name,
            } )
          }
          else {
            throw new Error( `args.type "${ args.type }" not coded for.` )
          }

          return subTaskComplete( null, updateArgs )
        }
        catch ( error ) {
          return subTaskComplete()
        }
      }

      function ifUpdateEnsureDevelopementVersion ( updateArgs, subTaskComplete ) {
        if ( typeof updateArgs === 'function' ) return updateArgs(); // no update case, updateArgs is callback
        return self._ensureDevelopmentVersion( onVersion )

        function onVersion ( error ) {
          if ( error ) return subTaskComplete( error )
          return subTaskComplete( null, updateArgs )
        }
      }

      function putUpdate ( updateArgs, subTaskComplete ) {
        if ( typeof updateArgs === 'function' ) return updateArgs(); // no update case, updateArgs is callback
        return apiRequest.apply( self, updateArgs.concat( [ logger ] ) )
        function logger ( error, results) {
          console.log( 'logger' )
          console.log( error )
          console.log( results )
          subTaskComplete( error, results )
        }
      }
    }
  }

  function postRequestVersioned ( args, complete ) {
    var apiRequest = self.request;
    var service_id = self._service_id;
    var version = self.version()

    var urlStr = [ '/service', service_id, 'version', version, args.type  ].join( '/' )

    var ensureDevelopmentVersion = self._ensureDevelopmentVersion()
    if ( ensureDevelopmentVersion ) {
      return ensureDevelopmentVersion( handleErrorThenSuccess( complete )( postRequestVersioned.bind( self, args, complete ) ) )
    }
    else {
      // already an inactive version to work off of
      return apiRequest.apply( self, [ 'POST', urlStr, args.post, complete ] )
    }
  }

  function callFnWithArgs ( continuation ) {
    return function mayNeverBeCalled ( args ) {
      continuation( args )
    }
  }
}

// versioned configuration base
function apiArguments ( type, name ) {
  return {
    type: type,
    get:  { name: name },
    put:  { name: name },
    post: { name: name },
  }
}

// versioned configuration
function dictionaryArguments ( name ) {
  return Object.assign( apiArguments( 'dictionary', name ), {
    checkPut: function dictionaryCheckPut () {
      // dictionary never needs to be pushed. just a container for other values.
      return;
    }
  } )
}

// versioned configuration
function addDomainArguments ( name ) {
  return Object.assign( apiArguments( 'domain', name ), {
    checkPut: function domainCheckPut () {
      // domain never needs to be updated.
      return;
    }
  } )
}

// versionless configuration
function apiDictionaryItemArguments ( options ) {
  return {
    type: 'dictionary',
    id: options.id,
    operations: options.operations,  // result of get, input for patch
    property: 'items',
  }
}

// versioned configuration
function headerArguments ( name ) {
  var args = apiArguments( 'header', name )
  var headerOptions = headerOptionsForName( name )
  
  Object.assign( args, { checkUpdate: checkUpdate } )
  Object.assign( args.post, headerOptions )

  return args;

  function checkUpdate ( cdnHeader ) {
    var sameHeader = ( cdnHeader.name === headerOptions.name ) &&
      ( cdnHeader.type === headerOptions.type ) &&
      ( cdnHeader.action === headerOptions.action ) &&
      ( cdnHeader.dst === headerOptions.dst ) &&
      ( cdnHeader.src === headerOptions.src ) &&
      ( cdnHeader.priority === headerOptions.priority ) &&
      ( cdnHeader.priority === headerOptions.ignore_if_set )

    if ( sameHeader ) return
    else return putArgsFn;

    // options : { service_id, version }
    function putArgsFn ( options ) {
      var service_id = options.service_id;
      var version = options.version;
      var method = 'PUT';
      var urlStr = [ '/service', service_id, 'version', version, args.type, headerOptions.name ].join( '/' )
      var body = Object.assign( {}, headerOptions )
      return [ method, urlStr, body ]
    }
  }

  function headerOptionsForName ( name ) {
    var headerConfiguration = {}

    headerConfiguration[ HEADER_CORS_ALLOW_ALL_ORIGINS ] = {
      name: HEADER_CORS_ALLOW_ALL_ORIGINS,
      type: 'cache',
      action: 'set',
      dst: 'http.Access-Control-Allow-Origin',
      src: '"*"',
      ignore_if_set: 0,
      priority: 10,
    }

    try {
      return headerConfiguration[ name ]
    }
    catch ( error ) {
      throw new Error( `header configuration "${ name }" does not exist.` )
    }
  }
}

// versioned configuration
function gzipArguments ( name ) {
  var args = apiArguments( 'gzip', name )
  Object.assign( args, { checkUpdate: checkUpdate } )
  var gzipOptions = gzipOptionsForName( name )
  Object.assign( args.post, gzipOptions )

  return args;

  function checkUpdate ( gzip ) {
    var sameContent = ( gzip.content_types === gzipOptions.content_types ) &&
      ( gzip.extensions === gzipOptions.extensions  )

    if ( sameContent ) return;
    else {
      // options : { service_id, version }
      return function putArgsFn ( options ) {
        var service_id = options.service_id;
        var version = options.version;
        var method = 'PUT';
        var urlStr = [ '/service', service_id, 'version', version, args.type, gzipOptions.name ].join( '/' )
        var body = Object.assign( {}, gzipOptions )
        return [ method, urlStr, body ]
      }
    }
  }

  function gzipOptionsForName ( name ) {
    var gzipConfigurations = {}

    gzipConfigurations[ GZIP_BASIC ] = {
      name: GZIP_BASIC,
      cache_condition: "",
      content_types: "text/html application/x-javascript text/css " +
        "application/javascript text/javascript application/json " +
        "application/vnd.ms-fontobject application/x-font-opentype " +
        "application/x-font-truetype application/x-font-ttf application/xml " +
        "font/eot font/opentype font/otf image/svg+xml image/vnd.microsoft.icon " +
        "text/plain text/xml",
      extensions: "css js html eot ico otf ttf json",
    }

    try {
      return gzipConfigurations[ name ]
    }
    catch ( error ) {
      throw new Error( `gzip configuration "${ name }" does not exist.` )
    }
  }
}

// versioned configuration
function snippetArguments ( name, options ) {
  if ( typeof name === 'object' ) {
    options = Object.assign( {}, name )
    name = '*'
  }
  if ( ! options ) options = {}

  var args = apiArguments( 'snippet', name )
  var snippetOptions = snippetOptionsForName( name, options )
  Object.assign( args, { checkUpdate: checkUpdate } )
  Object.assign( args.post, snippetOptions )

  return args;

  // checks the content & priority of the snippet.
  // if they are the same, then do not update.
  // if they are different, return arguments for a put request
  function checkUpdate ( cdnSnippet ) {
    console.log( 'check-update' )
    var sameContent = cdnSnippet.content === snippetOptions.content;

    if ( sameContent ) {
      // arguments do not need to be updated.
      return;
    }
    else {
      var putBody = {}
      if ( ! sameContent ) putBody.content = snippetOptions.content;
      console.log( 'putArgsFn' )
      return putArgsFn;

      // options : { service_id, snippet_id }
      function putArgsFn ( options ) {
        var service_id = options.service_id;
        var snippet_id = options.snippet_id;
        var method = 'PUT';
        var urlStr = [ '/service', service_id, args.type, snippet_id ].join( '/' )
        var body = putBody;
        console.log( 'put-args' )
        console.log( method )
        console.log( urlStr )
        console.log( body )
        return [ method, urlStr, body ]
      }
    }
  }


  function snippetOptionsForName ( name, options ) {
    var snippet = baseSnippets( name )
    assert( typeof snippet === 'function', 'snippetOptionsForName is a mapping. The mapping was not successful.' )
    return snippet( options );
  }

  function baseSnippets ( name ) {
    var WILDCARD = '*';
    var snippets =  {}
    snippets[ SNIPPET_RECV_REDIRECT_HOSTS ] = function () {
      return {
        name: SNIPPET_RECV_REDIRECT_HOSTS,
        dynamic: 1,
        type: 'recv',
        priority: 97,
        content: `if ( table.lookup( ${ DICTIONARY_REDIRECT_HOSTS }, req.http.host ) ) {
          set req.http.x-redirect-location = "http://" table.lookup( ${ DICTIONARY_REDIRECT_HOSTS }, req.http.host ) req.url;
          error 301;
        }`,
      }
    }
    snippets[ SNIPPET_RECV_REDIRECT_URLS ] = function () {
      /**
       * Handles setting an `x-redirect-location` uri to redirect to
       * based on the DICTIONARY_REDIRECT_URLS table, which stores
       * 1:1 redirects.
       * This system does not currently handle query parameters interally,
       * so it just passes them along.
       * Hash URL paths are assumed to lead somewhere on the final page, so
       * they too are passed along.
       */
      return {
        name: SNIPPET_RECV_REDIRECT_URLS,
        dynamic: 1,
        type: 'recv',
        priority: 98,
        content: `
        declare local var.host_path STRING;
        declare local var.redirect_location STRING;

        set var.host_path = req.http.host req.url.path;

        set var.redirect_location = table.lookup( ${ DICTIONARY_REDIRECT_URLS }, var.host_path );

        if ( std.strlen( var.redirect_location ) == 0 ) {
          declare local var.host_url STRING;
          set var.host_url = req.http.host req.url;
          set var.redirect_location = table.lookup( ${ DICTIONARY_REDIRECT_URLS }, var.host_url );
        }

        if ( std.strlen( var.redirect_location ) > 0 ) {
          if ( ! var.redirect_location ~ "^http" ) {
            set var.redirect_location = "http://" var.redirect_location;
          }

          if ( std.strlen( req.url.qs ) > 0 ) {
            set var.redirect_location = var.redirect_location "?" req.url.qs;
          }

          set req.http.x-redirect-location = var.redirect_location;

          error 301;
        }
        `.trim(),
      }
    }
    snippets[ SNIPPET_RECV_TRAILING_SLASH ] = function () {
      return {
        name: SNIPPET_RECV_TRAILING_SLASH,
        dynamic: 1,
        type: 'recv',
        priority: 99,
        content: `
        if ( req.url !~ {"(?x)
            (?:/$) # last character isn\'t a slash
            | # or
            (?:/\\?) # query string isn\'t immediately preceded by a slash
          "} &&
          req.url ~ {"(?x)
            (?:/[^./]+$) # last path segment doesn\'t contain a . no query string
            | # or
            (?:/[^.?]+\\?) # last path segment doesn\'t contain a . with a query string
            | # or
            (?:/[^.?]+\\#) # last path segment doesn\'t contain a . with an anchor string
          "} ) {

          set req.http.x-redirect-location = "http://" req.http.host req.url.path "/";

          if ( std.strlen( req.url.qs ) > 0 ) {
            set req.http.x-redirect-location = req.http.x-redirect-location "?" req.url.qs;
          }

          error 301;
        }`.trim(),
      }
    }
    snippets[ SNIPPET_RECV_HOST_RISDDOTEDU_FORCE_HTTPS ] = function () {
      return {
        name: SNIPPET_RECV_HOST_RISDDOTEDU_FORCE_HTTPS,
        dynamic: 1,
        type: 'recv',
        priority: 104,
        content: `if ( req.http.host ~ "risd.edu$" && ! req.http.Fastly-SSL ) {
          set req.http.x-redirect-location = "https://" req.http.host req.url;
          error 301;
        }`
      }
    }
    snippets[ SNIPPET_RECV_BACKEND_MAPPING ] = function () {
      return {
        name: SNIPPET_RECV_BACKEND_MAPPING,
        dynamic: 1,
        type: 'recv',
        priority: 105,
        content: `if ( table.lookup( dictionary_host_backends, req.http.host ) ) {
          set req.http.requested-host = req.http.host;
          set req.http.host = table.lookup( dictionary_host_backends, req.http.host );
        }`
      }
    }
    snippets[ SNIPPET_FETCH_RESTORE_ORIGINAL_HOST ] = function () {
      return {
        name: SNIPPET_FETCH_RESTORE_ORIGINAL_HOST,
        dynamic: 1,
        type: 'fetch',
        priority: 105,
        content: `if ( req.http.requested-host ) {
          set req.http.host = req.http.requested-host;
        }`
      }
    }
    snippets[ SNIPPET_ERROR_REDIRECT ] = function () {
      return {
        name: SNIPPET_ERROR_REDIRECT,
        dynamic: 1,
        type: 'error',
        priority: 100,
        content: `if (obj.status == 301 && req.http.x-redirect-location) {
          set obj.http.Location = req.http.x-redirect-location;
          set obj.response = "Found";
          synthetic {""};
          return(deliver);
        }`,
      }
    },
    snippets[ WILDCARD ] = function ( options ) {
      return Object.assign( {}, options )
    }


    if ( snippets.hasOwnProperty( name ) ) {
      return snippets[ name ]
    }
    else {
      return snippets[ WILDCARD ];
    }
  }

}

function activeVersionIn ( versions ) {
  var activeVersions = versions.filter( function isActive ( version ) { return version.active } )
  if ( activeVersions.length === 1 ) {
    return activeVersions[ 0 ].number;
  } else {
    return false;
  }
}


/* helpers:start */

function isNotFalse ( value ) { return value !== false; }

// sets the new version, and flips the active switch to false
function getSetVersion ( version ) {
  if ( ! arguments.length ) return this._version;
  if ( this._version !== version ) {
    if ( typeof this._version === 'number' ) {
      // only set this if the _version has already been set
      this._version_is_active = false;
    }
    this._version = version;
  }
  return this;
}

/* handleCallback* will take two functions, and be ready to handle the
   result of an async function using the previous two function inputs.
   These functions maintains the callback ( error, result ) convention. */
function handleCallbackError ( errorFn ) {
  return function handleSuccess ( successFn ) {
    return function asyncFn ( error, value ) {
      if ( error ) return errorFn( error )
      successFn( null, value )
    }
  }
}

function handleCallbackSuccess ( successFn ) {
  return function handleError ( errorFn  ) {
    return function asyncFn ( error, value ) {
      if ( error ) return errorFn( error )
      successFn( null, value )
    }
  }
}

/* handle{Error,Success}* will take two functions, and be ready to handle
   the result of an async function using the previous two inputs.
   These functions maintain the Promise convention of returning only
   ( error ) or ( result ) as appropriate. */
function handleError ( errorFn ) {
  return function successCase ( successFn ) {
    return function asyncFn ( error, value ) {
      if ( error ) errorFn( error )
      else successFn( value )
    }
  }
}

function handleErrorThenSuccess ( errorFn ) { return handleError( errorFn ) }

function handleSuccess ( successFn ) {
  return function errorCase ( errorFn ) {
    return function asyncFn ( error, value ) {
      if ( error ) errorFn( error )
      else successFn( value )
    }
  }
}

function handleSuccessThenError( successFn ) { return handleSuccess( successFn ) }

function debugCallback( name, fn ) {
  return function ( error, result ) {
    if ( error ) {
      console.log( name + ':error' )
      console.log( error )
      return fn( error )
    }
    else {
      console.log( name + ':result' )
      console.log( result )
      return fn( null, result )
    }
  }
}

// configureDomains
// domains : [ domain : string ] -> result

// updateDomainRedirects
// domain : string, redirects : [ { pattern : string, destination : string } ] -> result



function configFastlyJsonRequest ( token ) {
  return function fastlyJsonRequest ( method, urlStr, json, callback ) {
    var headers = {
      'fastly-key': token,
      'content-type': 'application/json',
      'accept': 'application/json'
    };

    // HTTP request
    request({
      method: method,
      url: 'https://api.fastly.com' + urlStr,
      headers: headers,
      body: JSON.stringify( json ),
    }, function (err, response, body) {
        if (response) {
            var statusCode = response.statusCode;
            if (!err && (statusCode < 200 || statusCode > 302))
                err = new Error(body);
            if (err) err.statusCode = statusCode;
        }
        if (err) return callback(err);
        if (response.headers['content-type'] === 'application/json') {
            try {
                body = JSON.parse(body);
            } catch (er) {
                return callback(er);
            }
        }

        callback(null, body);
    });
  }
}

function ensureArray ( value ) {
  return Array.isArray( value )
    ? value
    : typeof value === 'object'
      ? [ value ]
      : []
}

/* helpers:end */
