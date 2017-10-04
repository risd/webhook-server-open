var miss = require( 'mississippi' )
var request = require( 'request' )
var Fastly = require( 'fastly' )
var assert = require( 'assert' )

// cornerstones of the service
var REDIRECT_ONE_TO_ONE_URLS = 'redirect_one_to_one_urls';
var SNIPPET_RECV_REDIRECT = 'recv_redirect_urls';
var SNIPPET_ERROR_REDIRECT = 'error_redirect_synthetic';
var SNIPPET_RECV_TRAILING_SLASH = 'recv_trailing_slash';

module.exports = FastlyWebhookService;

function FastlyWebhookService ( options ) {
  if ( ! ( this instanceof FastlyWebhookService ) ) return new FastlyWebhookService( options )

  assert( typeof options === 'object', 'Requires an options object as first argument. Including `token` & `service_id` keys.' )

  this.token = options.token;

  // the one service that handles all traffic
  this._service_id = options.service_id;
  // the current version for that one service
  this._version;
  // version is active starts as true.
  // only made false base internally updating the state
  this._version_is_active = true;

  this.request = Fastly( token ).request;
  this.jsonRequest = configFastlyJsonRequest( token );
}


FastlyWebhookService.prototype.version = getSetVersion;
FastlyWebhookService.prototype.initialize = initializeService;
FastlyWebhookService.prototype.domain = addDomains
FastlyWebhookService.prototype.dictionaryRedirects = setDictionaryRedirects;

/**
 * Initialize the service. Given a service_id, ensure the service
 * is configured to handle interfacing with webhook fastly modules.
 * Internally manage the version so that new versions can be
 * activated as they are made.
 * 
 * @param  {string} service_id  The `service_id` to initialize
 * @param  {function} complete  Called when the service has been initialized.
 */
function initializeService ( service_id, complete ) {
  if ( typeof service_id === string ) this._service_id = service_id;
  var self = this;
  
  // if any errors occur, bail and complete early
  var ifSuccess = handleError( complete )
  
  return getService( service_id, ifSuccess( handleService( configureService( ifSuccess( complete ) ) ) ) )

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
          dictionaryArguments( REDIRECT_ONE_TO_ONE_URLS ),
          snippetArguments( SNIPPET_RECV_REDIRECT ),
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
 * Add domain configuration for the supplied domains.
 * @param {string|[string]} domains  String of domains to configure. Can be a single string, comman separated string, or array of strings representing domain names.
 * @param {[type]} complete [description]
 */
function addDomains ( domains, complete ) {
  if ( typeof domains === 'string' ) domains = domains.split( ',' )
  var updator = serviceConfigurationUpdater.apply( this );
  var domainTasks = domains.map( domainArguments ).map( updator.mapTask )
  return async.series( domainTasks, complete )
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

  dictionaryOfName( REDIRECT_ONE_TO_ONE_URLS, ifSuccess( getItems( ifSuccess(  ) ) ) )

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
      getRequest( args, ifError( callFnWithArgs( postRequest ) ) ) )
    }
  }

  function getRequest ( args, complete ) {
    var url = [ '/service', service_id, 'version', self.version(), args.type, args.get.name ].join( '/' )

    apiRequest( 'GET', url, function ( error, value ) {
      if ( error ) return complete.apply( null, [ args, complete ] )
      complete()
    } )
  }

  function postRequest ( args, complete ) {

    var url = [ '/service', service_id, 'version', self.version(), args.type  ].join( '/' )
    var postApiRequest = apiRequest.bind( null, 'POST', url, args.post, complete  );
    
    if ( self._version_is_active ) {
      // if version is active, create a new one that isn't
      var createVersionArgs = {
        method: 'POST',
        url: [ '/service', service_id, 'version' ].join( '/' ),
      }
      return apiRequest( createVersionArgs.method, createVersionArgs.url,
        handleErrorThenSuccess( complete )( ifSuccessSetDevelopmentVersionThen( postApiRequest ) ) )

    } 
    else {
      // already an inactive version to work off of
      return postApiRequest()
    }
  }

  function ifSuccessSetDevelopmentVersionThen ( continuation ) {
    return function setter ( createVersionResponse ) {
      self.version( createVersionResponse.number )
      continuation( createVersionResponse )
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
    { name: SNIPPET_RECV_TRAILING_SLASH,
      dynamic: 1,
      type: 'recv',
      priority: 99,
      content: 'if ( req.url !~ {"(?x)\n\t (?:/$) # last character isn\'t a slash\n\t | # or \n\t (?:/\\?) # query string isn\'t immediately preceded by a slash\n\t "} &&\n\t req.url ~ {"(?x)\n\t (?:/[^./]+$) # last path segment doesn\'t contain a . no query string\n\t | # or\n\t (?:/[^.?]+\\?) # last path segment doesn\'t contain a . with a query string\n\t "} ) {\n\t  set req.http.x-redirect-location = req.url "/";\n\terror 301;\n}',
    },
    { name: SNIPPET_RECV_REDIRECT,
      dynamic: 1,
      type: 'recv',
      priority: 100,
      content: 'if ( table.lookup( redirect_one_to_one_urls, req.url.path ) ) {\n  if ( table.lookup( redirect_one_to_one_urls, req.url.path ) ~ "^(http)?"  ) {\n    set req.http.x-redirect-location = table.lookup( redirect_one_to_one_urls, req.url.path );\n  } else {\n    set req.http.x-redirect-location = "http://" req.http.host table.lookup( redirect_one_to_one_urls, req.url.path );  \n  }\n  \n  error 301;\n}',
    },
    { name: SNIPPET_ERROR_REDIRECT,
      dynamic: 1,
      type: 'error',
      priority: 100,
      content: 'if (obj.status == 301 && req.http.x-redirect-location) {\n  set obj.http.Location = req.http.x-redirect-location;\n  set obj.response = "Found";\n  synthetic {""};\n  return(deliver);\n}',
    },
  ]
}

function activeVersionIn ( versions ) {
  var activeVersion = versions.filter( function isActive ( version ) { return version.active } )
  if ( activeVersion.length === 1 ) {
    return activeVersion[ 0 ].number;
  } else {
    return false;
  }
}


/* helpers:start */

// sets the new version, and flips the active switch to false
function getSetVersion ( version ) {
  if ( ! arguments.length ) return this._version;
  if ( this._version !== version ) {
    this._version = version;
    this._version_is_active = false;
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