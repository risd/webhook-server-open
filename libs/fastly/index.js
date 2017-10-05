var miss = require( 'mississippi' )
var request = require( 'request' )
var Fastly = require( 'fastly' )
var assert = require( 'assert' )
var async = require( 'async' )

// base configuration of the service
var DICTIONARY_REDIRECT_HOSTS = 'dictionary_redirect_hosts';
var DICTIONARY_REDIRECT_URLS = 'dictionary_redirect_urls';
var SNIPPET_RECV_REDIRECT_URLS = 'recv_redirect_urls';
var SNIPPET_RECV_REDIRECT_HOSTS = 'recv_redirect_hosts';
var SNIPPET_RECV_TRAILING_SLASH = 'recv_trailing_slash';
var SNIPPET_ERROR_REDIRECT = 'error_redirect_synthetic';

module.exports = FastlyWebhookService;

function FastlyWebhookService ( options ) {
  if ( ! ( this instanceof FastlyWebhookService ) ) return new FastlyWebhookService( options )

  assert( typeof options === 'object', 'Requires an options object as first argument. Including `token` & `service_id` keys.' )
  assert( typeof options.token === 'string', 'Requires a `token` key in the options object that is a string of the Fastly API token.' )
  assert( typeof options.service_id === 'string', 'Requires a `service_id` key in the options object that is a string of the id of the Fastly service.' )

  var token = options.token;

  // the one service that handles all traffic
  this._service_id = options.service_id;
  // the current version for that one service, starts as false
  this._version = false;
  // version is active starts as true.
  // only made false base internally updating the state
  this._version_is_active = true;

  var fastly = Fastly( token )
  this.request = fastly.request.bind( fastly )
  this.jsonRequest = configFastlyJsonRequest( token )
}


FastlyWebhookService.prototype.version = getSetVersion;
FastlyWebhookService.prototype.initialize = initializeService;
FastlyWebhookService.prototype.domain = addDomains;
FastlyWebhookService.prototype.dictionaryRedirects = setDictionaryRedirects;
FastlyWebhookService.prototype.activate = function activator ( complete ) {
  if ( this._version_is_active === true ) return complete()
  var self = this;
  var options = {
    request: this.request,
    service_id: this._service_id,
    version: this.version(),
  }
  return activateVersion( options, function ( error, version ) {
    if ( error ) return complete( error )
    self._version_is_active = true;
    return complete( null, version )
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
  
  return getService( this._service_id, ifSuccess( handleService( configureService( self.activate.bind( self, complete ) ) ) ) )

  function handleService ( continuation ) {
    return serviceHandler;

    function serviceHandler ( service ) {
      self.version( activeVersionIn( service.versions ) )
      continuation( self.version() )
    }
  }

  function configureService ( continuation ) {
    return configurer;

    function configurer ( version ) {

      var updator = serviceConfigurationUpdater.apply( self )

      var getOrCreateTasks = [
          dictionaryArguments( DICTIONARY_REDIRECT_HOSTS ),
          dictionaryArguments( DICTIONARY_REDIRECT_URLS ),
          snippetArguments( SNIPPET_RECV_REDIRECT_URLS ),
          snippetArguments( SNIPPET_RECV_REDIRECT_HOSTS ),
          snippetArguments( SNIPPET_ERROR_REDIRECT ),
          snippetArguments( SNIPPET_RECV_TRAILING_SLASH ),
        ]
        .map( updator.mapTask )

      return async.series( getOrCreateTasks, ifSuccess( continuation ) )
    }
  }

  function getService ( service_id, withService ) {
    self.request( 'GET', [ '/service', service_id ].join( '/' ), withService )
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
  var url = [ '/service', service_id, 'version', version, 'activate' ].join( '/' )
  return request( 'PUT', url, complete );
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
  var updator = serviceConfigurationUpdater.apply( this )
  var domainTasks = domains.map( domainArguments ).map( updator.mapTask )
  return async.series( domainTasks, handleErrorThenSuccess( complete )( self.activate.bind( self, complete ) ) )
}

/**
 * Set one : one redirects as dictionary keys and values.
 * 
 * redirect : { pattern : string, destination : string } 
 * redirects : [ redirect ]
 * 
 * @param {object} redirects   Array of redirect objects.
 * @param {function} complete  The function to call upon completion.
 */
function setDictionaryRedirects ( redirects, complete ) {
  var self = this;

  var ifSuccess = handleError( complete )

  dictionaryOfName( DICTIONARY_REDIRECT_URLS, ifSuccess( getItems( ifSuccess(  ) ) ) )

  function dictionaryOfName ( name, continuation ) {
    var dictionaryNameUrl = [ '/service', self._service_id, 'version', self.version(), 'dictionary', name ].join( '/' )
    self.request( 'GET', dictionaryNameUrl, continuation )
  }
  function getItems ( continuation ) {
    return function from ( dictionary ) {
      var itemsUrl = [ '/service', self._service_id, 'dictionary', dictionary.id, 'items' ].join( '/' )
      self.request( 'GET', itemsUrl, continuation )
    }
  }
}

function serviceConfigurationUpdater () {
  var self = this;

  return {
    mapTask: mapTask,
  }

  function mapTask ( args ) {
    return function task ( taskComplete ) {
      var ifError = handleSuccess( taskComplete )
      getRequest( args, ifError( callFnWithArgs( postRequest.bind( self, args, taskComplete ) ) ) )
    }
  }

  function getRequest ( args, complete ) {
    var apiRequest = self.request;
    var service_id = self._service_id;
    var version = self.version()

    var url = [ '/service', service_id, 'version', version, args.type, args.get.name ].join( '/' )

    apiRequest( 'GET', url, complete )
  }

  function postRequest ( args, complete ) {
    var apiRequest = self.request;
    var service_id = self._service_id;
    var version = self.version()

    var url = [ '/service', service_id, 'version', version, args.type  ].join( '/' )

    if ( self._version_is_active ) {
      // if version is active, create a new one that isn't
      var cloneVersionArgs = {
        method: 'PUT',
        url: [ '/service', service_id, 'version', version, 'clone' ].join( '/' ),
      }
      return apiRequest( cloneVersionArgs.method, cloneVersionArgs.url,
        handleErrorThenSuccess( complete )( ifSuccessSetDevelopmentVersionThen( postRequest.bind( self, args, complete ) ) ) )

    } 
    else {
      // already an inactive version to work off of
      return apiRequest.apply( self, [ 'POST', url, args.post, complete ] )
    }
  }

  function ifSuccessSetDevelopmentVersionThen ( continuation ) {
    return function setter ( createVersionResponse ) {
      self.version( createVersionResponse.number )
      continuation()
    }
  }

  function callFnWithArgs ( continuation ) {
    return function mayNeverBeCalled ( args ) {
      continuation( args )
    }
  }
}

function apiArguments ( type, name ) {
  return {
    type: type,
    get: { name: name },
    post: { name: name },
  }
}

function dictionaryArguments ( name ) { return apiArguments( 'dictionary', name ) }
function domainArguments ( name ) { return apiArguments( 'domain', name ) }

function snippetArguments ( name ) {
  var args = apiArguments( 'snippet', name )
  Object.assign( args.post, snippetOptionsForName( name ) )
  return args;
}

function snippetOptionsForName ( name ) {
  var snippet = baseSnippets().filter( function ( snippets ) { return snippets.name === name } )
  assert( snippet.length === 1, 'snippetOptionsForName is a mapping. The mapping was not successful.' )
  return snippet[ 0 ];
}

function baseSnippets () {
  return [
    { name: SNIPPET_RECV_REDIRECT_HOSTS,
      dynamic: 1,
      type: 'recv',
      priority: 98,
      content: `if ( table.lookup( ${ DICTIONARY_REDIRECT_HOSTS }, req.http.host ) ) {
        set req.http.x-redirect-location = "http://" table.lookup( ${ DICTIONARY_REDIRECT_HOSTS }, req.http.host ) req.url;
        error 301;
      }`,
    },
    { name: SNIPPET_RECV_TRAILING_SLASH,
      dynamic: 1,
      type: 'recv',
      priority: 99,
      content: `if ( req.url !~ {"(?x)
          (?:/$) # last character isn\'t a slash
          | # or
          (?:/\\?) # query string isn\'t immediately preceded by a slash
        "} &&
        req.url ~ {"(?x)
          (?:/[^./]+$) # last path segment doesn\'t contain a . no query string
          | # or
          (?:/[^.?]+\\?) # last path segment doesn\'t contain a . with a query string
        "} ) {
        set req.http.x-redirect-location = req.url "/";
        error 301;
      }`,
    },
    { name: SNIPPET_RECV_REDIRECT_URLS,
      dynamic: 1,
      type: 'recv',
      priority: 100,
      content: `if ( table.lookup( ${ DICTIONARY_REDIRECT_URLS }, req.url.path ) ) {
        if ( table.lookup( ${ DICTIONARY_REDIRECT_URLS }, req.url.path ) ~ "^(http)?"  ) {
          set req.http.x-redirect-location = table.lookup( ${ DICTIONARY_REDIRECT_URLS }, req.url.path );
        } else {
           set req.http.x-redirect-location = "http://" req.http.host table.lookup( ${ DICTIONARY_REDIRECT_URLS }, req.url.path );
        }
        error 301;
      }`,
    },
    { name: SNIPPET_ERROR_REDIRECT,
      dynamic: 1,
      type: 'error',
      priority: 100,
      content: `if (obj.status == 301 && req.http.x-redirect-location) {
        set obj.http.Location = req.http.x-redirect-location;
        set obj.response = "Found";
        synthetic {""};
        return(deliver);
      }`,
    },
  ]
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


// initialization
// - ensure service exists
// - ensure table redirect_one_to_one_urls
// - ensure snippet recv_trailing_slash
// - ensure snippet recv_redirect_urls
// - ensure snippet error_redirect_synthetic

// configureDomains
// domains : [ domain : string ] -> result

// updateDomainRedirects
// domain : string, redirects : [ { pattern : string, destination : string } ] -> result



function configFastlyJsonRequest ( token ) {
  return function fastlyJsonRequest ( method, url, json, callback ) {
    var headers = {
      'fastly-key': token,
      'content-type': 'application/json',
      'accept': 'application/json'
    };

    // HTTP request
    request({
      method: method,
      url: 'https://api.fastly.com' + url,
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

/* helpers:end */