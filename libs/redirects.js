/*

Redirects management via Fastly.

*/

var _ = require( 'lodash' )
var url = require( 'url' )
var crypto = require( 'crypto' )
var request = require( 'request' )
var Fastly = require( 'fastly' )
var firebase = require( 'firebase' )
var JobQueue = require('./jobQueue.js')
var Deploys = require( 'webhook-deploy-configuration' )
var miss = require( 'mississippi' )
var throughConcurrent = require( 'through2-concurrent' )
var utils = require( './utils.js' )
var isAscii = require( 'is-ascii' );

// Util streams
var usingArguments = utils.usingArguments;
var sink = utils.sink;

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

// name of the dictionary on fastly that contains redirects
var REDIRECT_ONE_TO_ONE_URLS = 'redirect_one_to_one_urls';
var SNIPPET_RECV_REDIRECT = 'recv_redirect_urls';
var SNIPPET_ERROR_REDIRECT = 'error_redirect_synthetic';
var SNIPPET_RECV_TRAILING_SLASH = 'recv_trailing_slash';

module.exports.start = function ( config, logger ) {
  var self = this;

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init( config );

  var fastly = Fastly( config.get( 'fastlyToken' ) )
  fastly.jsonRequest = fastlyJsonRequest;

  var firebaseUrl = config.get( 'firebase' ) || '';
  this.root = new firebase( 'https://' + firebaseUrl +  '.firebaseio.com/' );

  var deploys = Deploys( this.root.child( 'buckets' ) )

  var reportStatus = function(site, message, status) {
    var messagesRef = self.root.root().child('/management/sites/' + site + '/messages/');
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: 'REDIRECTS' }, function() {
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limit(1).once('child_added', function(snap) {
            snap.ref().remove();
          });
        }
      });
    });
  }

  var baseSnippets = [ SNIPPET_RECV_REDIRECT, SNIPPET_ERROR_REDIRECT, SNIPPET_RECV_TRAILING_SLASH ]

  self.root.auth( config.get( 'firebaseSecret' ), function(err) {
    if( err ) {
      console.log( err.red )
      process.exit( 1 )
    }

    console.log( 'Waiting for commands'.red )

    // Wait for create commands from firebase
    jobQueue.reserveJob( 'redirects', 'redirects', redirects )
  } )

  return redirects;

  function redirects ( payload, identifier, data, client, callback ) {
    var site = data.sitename;
    var siteName = unescapeSite( site )

    miss.pipe(
      domainsToConfigure( siteName ),  // { domain }
      serviceForDomain( fastly ),      // { domain, service_id, active_version, dictionary_id }
      redirectsForDomain( site ),      // { domain, service_id, active_version, dictionary_id, cms_redirects, cdn_items, cdn_snippets }
      actionsForService(),             // { domain, service_id, active_version, dictionary_id, item_actions, actions }
      applyItemsForService(),          // { domain, service_id, active_version, dictionary_id, item_actions, actions }
      applyActionsForService(),        // { domain, service_id, active_version, dictionary_id, item_actions, actions }
      sink( console.log ),
      function onComplete ( error ) {
        if ( error ) {
          reportStatus( site, 'Redirects update failed.', 1 )
          return callback( error )
        }
        console.log( 'done' )
        reportStatus( site, 'Redirects updated.', 0 )
        callback()
      } )

  }

  function domainsToConfigure ( siteName ) {
    var emitter = miss.through.obj();

    domainsToConfigureFn( siteName, function ( error, domains ) {
      if ( error ) return emitter.emit( 'error', error )
      domains
        // .filter( function ( domain ) { return domain === 'stage.edu.risd.systems' } )
        .forEach( function ( domain ) { emitter.push( { domain: domain } ) } )
      emitter.push( null )
    } )

    return emitter;
  }

  function domainsToConfigureFn ( siteName, callback ) {

    var domainForDeploy = function ( deploy ) {
      return deploy.bucket;
    }

    deploys.get( { siteName: siteName }, function ( error, configuration ) {
      if ( error ) {
        console.log( error )
        return;
      }
      var fastlyDomains = configuration.deploys.map( domainForDeploy )
      callback( null, fastlyDomains )
    } )
  }

  function redirectsForDomain ( site ) {
    var cms_redirects = undefined;

    return miss.through.obj( function ( args, enc, next ) {

      miss.pipe(
        usingArguments( Object.assign( {}, args ) ),  // { domain, service_id, active_version, dictionary_id }
        getCmsRedirects( site ),                      // sets cms_redirects
        getCdnItems(),                                // { domain, service_id, active_version, dictionary_id, cdn_items }
        getCdnSnippets(),                             // { domain, service_id, active_version, dictionary_id, cdn_items, cdn_snippets }
        sink( function ( row ) {
          var nextArgs = Object.assign( {}, row, { cms_redirects: cms_redirects  } )
          next( null, nextArgs )
        } ),
        function onComplete ( error ) {
          if ( error ) return next( error )
        } )
    } )

    function getCmsRedirects ( site ) {
      return miss.through.obj( function ( args, enc, next ) {
        if ( Array.isArray( cms_redirects ) ) return next( null, args )

        miss.pipe(
          usingArguments( { site: site } ),
          getSiteKey(),                      // { site, siteKey }
          getRedirects(),                    // { site, siteKey } sets cms_redirects
          sink( function ( row ) {
            next( null, args )
          } ),
          function onComplete ( error ) {
            if ( error ) return next( error )
          } )
      } )

      function getSiteKey () {
        return miss.through.obj( function ( args, enc, next ) {
          self.root.child( 'management/sites/' + args.site ).once( 'value', onSiteData, onSiteDataError )

          function onSiteData ( siteData ) {
            var siteValues = siteData.val();
            args.siteKey = siteValues.key;
            next( null, args )
          }

          function onSiteDataError ( error ) {
            next( error )
          }
        } )
      }

      function getRedirects () {
        return miss.through.obj( function ( args, enc, next ) {
          self.root.child( 'buckets' ).child( args.site ).child( args.siteKey )
            .child( 'dev/settings/redirect' )
            .once( 'value', onRedirects, onRedirectsError )

          function onRedirects ( redirectsData ) {
            var redirects = redirectsData.val()
            cms_redirects = [];
            if ( typeof redirects === 'object' ) {
              Object.keys( redirects ).forEach( function ( redirectKey ) {
                cms_redirects.push( redirects[ redirectKey ] )
              } )
            }
            cms_redirects = _.uniqWith( cms_redirects, function ( a, b ) { return a.pattern === b.pattern } )
            cms_redirects = cms_redirects.filter( function ( redirect ) { return isAscii( redirect.pattern ) && isAscii( redirect.destination ) } )
            next( null, args )
          }

          function onRedirectsError ( error ) {
            cms_redirects = [];
            next( null, args )
          }

         } ) 
      }
    }

    function getCdnItems () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'dictionary', args.dictionary_id, 'items' ].join( '/' )
        fastly.request( 'GET', apiUrl, function ( error, items ) {
          if ( error ) return next( error )
          args.cdn_items = items;
          next( null, args )
        } )
      } )
    }

    function getCdnSnippets () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'snippet' ].join( '/' )
        fastly.request( 'GET', apiUrl, function ( error, snippets ) {
          if ( error ) return next( error )
          args.cdn_snippets = snippets.filter( function ( snippet ) {
            return baseSnippets.indexOf( snippet.name ) === -1;
          } );
          next( null, args )
        } )
      } )
    }
  }

  function actionsForService () {

    return miss.through.obj( function ( args, enc, next ) {
      var item_actions = [];
      var actions = [];

      var cms_redirects_items = args.cms_redirects.filter( isNotRegex )
      var cms_redirects_snippets = args.cms_redirects.filter( isRegex )

      item_actions = item_actions.concat( cms_redirects_items.map( createOrUpdateItemActions ).filter( isNotFalse ) )
      item_actions = item_actions.concat( args.cdn_items.map( deleteItemActions ).filter( isNotFalse ) )

      actions = actions.concat( cms_redirects_snippets.map( createSnippetActions ).filter( isNotFalse ) )
      actions = actions.concat( args.cdn_snippets.map( deleteSnippetActions ).filter( isNotFalse ) )

      console.log( 'item_actions:' + item_actions.length )

      next( null, {
        item_actions: item_actions,
        actions: actions,
        domain: args.domain,
        service_id: args.service_id,
        active_version: args.active_version,
        dictionary_id: args.dictionary_id,
      } )

      function createOrUpdateItemActions ( cms_redirect ) {
        for (var i = args.cdn_items.length - 1; i >= 0; i--) {
          if ( args.cdn_items[i].item_key === cms_redirect.pattern ) {
            if ( args.cdn_items[i].item_value === cms_redirect.destination ) {
              // already exists, no updated needed
              return false;
            } else {
              // already exists, but updated
              return actionFor( 'update', cms_redirect )
            }
          }
        }

        // not found in cdn_items, lets make it
        return actionFor( 'create', cms_redirect )
    
        function actionFor ( operation, redirect ) {
          return {
            op: operation,
            item_key: redirect.pattern,
            item_value: redirect.destination,
          }
        }
      }

      function deleteItemActions ( cdn_item ) {
        for (var i = cms_redirects_items.length - 1; i >= 0; i--) {
          if ( cms_redirects_items[i].pattern === cdn_item.item_key ) return false;
        }

        return {
          op: "delete",
          item_key: cdn_item.item_key,
        }
      }

      function createSnippetActions ( cms_redirect ) {
        var snippetName = snippetNameFor( cms_redirect )

        for (var i = args.cdn_snippets.length - 1; i >= 0; i--) {
          if ( args.cdn_snippets[i].name === snippetName ) {
            // name is unique to thhe contents of the redirect, so it already exists
            return false;
          }
        }

        // not found in cdn_items, lets make it
        return actionFor( 'POST', cms_redirect )

        function actionFor ( method, redirect ) {
          if ( method === 'PUT' ) {
            var snippetApiUrl = function ( service_id, version ) {
              return [ '/service', service_id, 'version', version, 'snippet', snippetName ].join( '/' )
            }
          }
          if ( method === 'POST' ) {
            var snippetApiUrl = function ( service_id, version ) {
              return [ '/service', service_id, 'version', version, 'snippet' ].join( '/' )
            }
          }
          return {
            requestMethod: method,
            url: snippetApiUrl,
            params: {
              name: snippetName,
              priority: 100,
              dynamic: 1,
              type: 'recv',
              content: snippetContentFor( redirect ),
            },
          }
        }

        // sample content
        // if ( req.url ~ "^/academics/graphic-design/faculty/" ) {\n  set req.http.x-redirect-location = "http://" req.http.host "/academics/graphic-design/faculty/";\n  error 301;\n}
        function patternFromSnippet ( content ) {
          if ( !content ) return false;
          return content.split( 'req.url ~ "' )[ 1 ].split( '" ) {\n' )[ 0 ]
        }

        function destinationFromSnippet ( content ) {
          if ( !content ) return false;
          return content.split( 'req.http.host "' )[ 1 ].split( '";\n  error 301' )[ 0 ]
        }
      }

      function deleteSnippetActions ( cdn_snippet ) {

        for (var i = 0; i < cms_redirects_snippets.length; i++) {
          if ( snippetNameFor( cms_redirects_snippets[i] ) === cdn_snippet.name ) return false;
        }

        var snippetApiUrl = function ( service_id, version ) {
          return [ '/service', service_id, 'version', version, 'snippet', cdn_snippet.name ].join( '/' )
        }
        return {
          requestMethod: 'DELETE',
          url: snippetApiUrl,
          params: {},
        }
      }

      function snippetNameFor ( redirect ) {
        return 'redirect_' + hashForContent( snippetContentFor( redirect ) )

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

      function snippetContentFor( redirect ) {
        return 'if ( req.url ~ "' + redirect.pattern + '" ) {\n  set req.http.x-redirect-location = "http://" req.http.host "' + redirect.destination + '";\n  error 301;\n}'
      }

      function isNotFalse ( value ) { return value !== false; }

      function isRegex ( redirect ) {
        return redirect.pattern.startsWith( '^' )
      }

      function isNotRegex ( redirect ) {
        return !isRegex( redirect )
      }
    } )
  }

  function applyItemsForService () {
    return miss.through.obj( function ( args, enc, next ) {
      if ( args.item_actions.length === 0 && typeof args.dictionary_id !== 'number' ) return next( null, args )

      miss.pipe(
        feedActions( args ),
        applyActions(),
        sink(),
        function onComplete ( error ) {
          if ( error ) return next( error )
          next( null, args )
        } )
    } )

    function feedActions ( args ) {
      var emitter = miss.through.obj()
      var maxActions = 400;
      var iterations = Math.ceil( args.item_actions.length / maxActions )
      var item_actions_chunks = []
      for (var i = 0; i < iterations; i++) {
        item_actions_chunks.push( args.item_actions.slice( ( maxActions * i ), ( maxActions * ( i + 1 ) ) ) )
      }
      item_actions_chunks.forEach( function ( item_actions ) {
        setTimeout( function () {
          emitter.push( {
            service_id: args.service_id,
            domain: args.domain,
            dictionary_id: args.dictionary_id,
            item_actions: item_actions
          } )
        }, 1 )
      } )
      setTimeout( function () { emitter.push( null ) }, 1 )

      return emitter;
    }

    function applyActions () {
      var requests = 0;
      var requests_limit = 100;

      return throughConcurrent.obj( { maxConcurrency: 10 }, function ( args, enc, next ) {

        if ( requests >= requests_limit ) return next( null, args )

        var apiUrl = [ '/service', args.service_id, 'dictionary', args.dictionary_id, 'items' ].join( '/' )
        fastly.jsonRequest( 'PATCH', apiUrl, { items: args.item_actions }, function ( error, result ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
    }
  }

  function applyActionsForService () {
    return miss.through.obj( function ( args, enc, next ) {
      if ( args.actions.length === 0 ) return next( null, args )

      miss.pipe(
        usingArguments( args ),
        cloneServiceVersion(),
        feedActions(),
        applyActions(),
        sink(),
        function onComplete ( error ) {
          if ( error ) return next( error )

          miss.pipe(
            usingArguments( args ),
            activateServiceVersion( fastly ),
            sink(),
            function onActivateComplete( error ) {
              if ( error ) return next( error )
              next( null, args )
            } )
        } )

    } )

    function cloneServiceVersion () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'clone' ].join( '/' )
        fastly.request( 'PUT', apiUrl, function ( error, new_version ) {
          if ( error ) return next( error )
          next( null, Object.assign( args, { active_version: new_version.number } ) )
        } )
      } )
    }

    function feedActions () {
      return miss.through.obj( function ( args, enc, next ) {
        var stream = this;
        args.actions.forEach( function ( action ) {
          stream.push( { service_id: args.service_id, domain: args.domain, active_version: args.active_version, action: action } )
        } )
        next()
      } )
    }

    function applyActions () {
      var requests = 0;
      var requests_limit = 500;

      return throughConcurrent.obj( { maxConcurrency: 10 }, function ( args, enc, next ) {

        if ( requests >= requests_limit ) return next( null, args )

        var service_id = args.service_id;
        var version = args.active_version;
        var action = args.action;

        miss.pipe(
          usingArguments( action ),
          miss.through.obj( execute ),
          sink(),
          function onComplete ( error ) {
            if ( error ) return next( error )
            next( null, args )
          } )

        function execute ( actionArgs, actionEnc, nextAction ) {
          requests = requests + 1;

          var maxAttempts = 5;
          var attempts = actionArgs.attempt || 0;
          fastly.request( actionArgs.requestMethod, actionArgs.url( service_id, version ), actionArgs.params, function ( error, value ) {
            if ( error ) {
              console.log( 'execute:error' )
              console.log( actionArgs )
              if ( actionArgs.attempt < maxAttempts ) {
                actionArgs.attempt = actionArgs.attempt + 1;
                return setTimeout( function () {
                  execute( actionArgs, actionEnc, nextAction )
                }, exponentialBackoff( actionArgs.attempt ) )
              }
              return nextAction( error )
            }
            nextAction( null,  actionArgs )
          } )
        }

      } )

      function exponentialBackoff ( attempt ) {
        return Math.pow( 2, attempt ) + ( Math.random() * 1000 )
      }
    }
  }

  function fastlyJsonRequest ( method, url, json, callback ) {
    var headers = {
      'fastly-key': config.get( 'fastlyToken' ),
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

module.exports.serviceForDomain = serviceForDomain;

function serviceForDomain ( fastly ) {
  return miss.through.obj( function ( args, enc, next ) {

    if ( !usesFastly( args.domain ) ) return next()

    console.log( 'serviceForDomain' )
    miss.pipe(
      usingArguments( { domain: args.domain } ),
      existingService(),                          // { service_id?, active_version?, dictionary_id? }
      createAndConfigureService(),                // { service_id, active_version, dictionary_id }
      sink( function ( row ) {
        var nextArgs = Object.assign( {}, args, {
          service_id: row.service_id,
          dictionary_id: row.dictionary_id,
          active_version: row.active_version,
        } )
        next( null, nextArgs )
      } ),
      function onComplete ( error ) {
        if ( error ) return next( error )
      } )

  } )

  function usesFastly ( domain ) {
    return domain.endsWith( 'risd.edu' )
      || ( domain.startsWith( 'stage.' ) && domain.endsWith( 'risd.systems' ) )
      || ( domain.endsWith( 'risdweekend.com' ) )
  }

  function existingService () {
    return miss.through.obj( function ( args, enc, next ) {
      fastly.request( 'GET', '/service/search?name=' + args.domain, function ( error, service ) {
        if ( error ) {
          args.service_id = args.active_version = false;
          return next( null, args )
        }
        args.service_id = service.id;
        args.active_version = activeVersionIn( service.versions )

        var dictionaryApiUrl = [ '/service', args.service_id, 'version', args.active_version, 'dictionary', REDIRECT_ONE_TO_ONE_URLS ].join( '/' )
        fastly.request( 'GET', dictionaryApiUrl, function ( error, dictionary ) {
          if ( error ) return next( error )
          args.dictionary_id = dictionary.id;
          next( null, args )
        } )
      } )
    } )

    function activeVersionIn ( versions ) {
      var activeVersion = versions.filter( function isActive ( version ) { return version.active } )
      if ( activeVersion.length === 1 ) {
        return activeVersion[ 0 ].number;
      }
    }
  }

  function createAndConfigureService () {
    return miss.through.obj( function ( args, enc, next ) {

      if ( args.service_id !== false ) return next( null, args )

      miss.pipe(
        usingArguments( { domain: args.domain } ),
        createService(),
        configureGoogleBackend(),
        configureDomain(),
        configureTrailingSlashSnippet(),
        configureVclRecvRedirectSnippet(),
        configureVclErrorRedirectSnippet(),
        configureOneToOneRedirectDictionary(),
        activateServiceVersion( fastly ),
        sink( function ( row ) {
          var nextArgs = Object.assign( {}, args, {
            service_id: row.service_id,
            active_version: row.active_version,
            dictionary_id: row.dictionary_id,
          } )
          next( null, nextArgs )
        } ),
        function onComplete ( error ) {
          if ( error ) return next( error )
        } )

    } )

    function createService () {
      return miss.through.obj( function ( args, enc, next ) {
        fastly.request( 'POST', '/service', { name: args.domain }, function ( error, service ) {
          if ( error ) {
            console.log( 'create-service:error' )
            console.log( error )
            console.log( error.stack );
          }
          console.log( 'create-service' )
          console.log( service )
          args.service_id = service.id;
          args.active_version = 1;
          next( null, args )
        } )
      } )
    }

    function configureGoogleBackend () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'backend' ].join( '/' );
        var apiParams = {
          hostname: 'storage.googleapis.com',
          address: 'storage.googleapis.com',
          name: 'addr storage.googleapis.com',
          port: 80,
        };
        fastly.request( 'POST', apiUrl, apiParams, function ( error, backend ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
    }

    function configureDomain () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'domain' ].join( '/' );
        var apiParams = {
          name: args.domain
        };
        fastly.request( 'POST', apiUrl, apiParams, function ( error, domain ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
    }

    function configureTrailingSlashSnippet () {
      return miss.through.obj( function ( args, enc, next) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'snippet' ].join( '/' )
        var apiParams = {
          name: SNIPPET_RECV_TRAILING_SLASH,
          dynamic: 1,
          type: 'recv',
          priority: 99,
          content: 'if ( req.url !~ {"(?x)\n (?:/$) # last character isn\'t a slash\n | # or \n (?:/\\?) # query string isn\'t immediately preceded by a slash\n "} &&\n req.url ~ {"(?x)\n (?:/[^./]+$) # last path segment doesn\'t contain a . no query string\n | # or\n (?:/[^.?]+\\?) # last path segment doesn\'t contain a . with a query string\n "} ) {\n  set req.url = req.url + "/";\n}',
        }
        fastly.request( 'POST', apiUrl, apiParams, function ( error, snippet ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
    }

    function configureVclRecvRedirectSnippet () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'snippet' ].join( '/' )
        var apiParams = {
          name: SNIPPET_RECV_REDIRECT,
          dynamic: 1,
          type: 'recv',
          priority: 100,
          content: 'if ( table.lookup( redirect_one_to_one_urls, req.url.path ) ) {\n  if ( table.lookup( redirect_one_to_one_urls, req.url.path ) ~ "^(http)?"  ) {\n    set req.http.x-redirect-location = table.lookup( redirect_one_to_one_urls, req.url.path );\n  } else {\n    set req.http.x-redirect-location = "http://" req.http.host table.lookup( redirect_one_to_one_urls, req.url.path );  \n  }\n  \n  error 301;\n}',
        }
        fastly.request( 'POST', apiUrl, apiParams, function ( error, snippet ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
    }

    function configureVclErrorRedirectSnippet () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'snippet' ].join( '/' )
        var apiParams = {
          name: SNIPPET_ERROR_REDIRECT,
          dynamic: 1,
          type: 'error',
          priority: 100,
          content: 'if (obj.status == 301 && req.http.x-redirect-location) {\n  set obj.http.Location = req.http.x-redirect-location;\n  set obj.response = "Found";\n  synthetic {""};\n  return(deliver);\n}',
        }
        fastly.request( 'POST', apiUrl, apiParams, function ( error, snippet ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
    }

    function configureOneToOneRedirectDictionary () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'dictionary' ].join( '/' )
        var apiParams = { name: REDIRECT_ONE_TO_ONE_URLS }
        fastly.request( 'POST', apiUrl, apiParams, function ( error, dictionary ) {
          if ( error ) return next( error )
          args.dictionary_id = dictionary.id;
          next( null, args )
        } )
      } )
    }
  }
}

function activateServiceVersion ( fastly ) {
  return miss.through.obj( function ( args, enc, next ) {
    if ( typeof args.active_version !== 'number' ) return next( null, args )

    var validateApiUrl = [ '/service', args.service_id, 'version', args.active_version, 'validate' ].join( '/' )
    var activateApiUrl = [ '/service', args.service_id, 'version', args.active_version, 'activate' ].join( '/' )

    fastly.request( 'GET', validateApiUrl, function ( error, result ) {
      if ( error ) {
        error.atStep = 'activateNewServiceVersion:validate';
        return next( error )
      }
      if ( result.status === 'error' ) {
        next( result )
      } else if ( result.status === 'ok' ) {
        fastly.request( 'PUT', activateApiUrl, function ( error, service ) {
          if ( error ) {
            error.atStep = 'activateNewServiceVersion:activate';
            return next( error )
          }
          next( null, args )
        } )    
      }
    } )
  } )
}
