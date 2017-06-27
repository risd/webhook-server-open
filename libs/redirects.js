/*

list deploys:
- filter: `stage.*.risd.systems`, `*.risd.edu`

for each:

get the service
list the current rules
if there are new rules, clone the active version
add the rules to the new version
set the new version as the active one


steps to get the service
GET /service/search?name={domain}
if error return create a service
otherwise, return service { id, active_version, ... }

steps to create a service
POST /service
- name: domain
returns { id, ... }
do basic configuration for the service
  POST /service/{id}/version/1/backend
  - {
      hostname: 'storage.googleapis.com',
      address: 'storage.googleapis.com',
      name: 'addr storage.googleapis.com',
      port: 80,
    }
  POST /service/{id}/version/1/domain
  - {
      name: domain
    }
  POST /service/{id}/version/1/dictionary
  - { name: 'redirect_one_to_one_urls' }
  POST /service/{id}/version/1/snippet
  - { name: 'recv_redirect_urls',
      dynamic: 1,
      type: 'recv',
      priority: 100,
      content: 'if ( table.lookup( redirect_one_to_one_urls, req.url.path ) ) {\n  if ( table.lookup( redirect_one_to_one_urls, req.url.path ) ~ "^(http)?"  ) {\n    set req.http.x-redirect-location = table.lookup( redirect_one_to_one_urls, req.url.path );\n  } else {\n    set req.http.x-redirect-location = "http://" req.http.host table.lookup( redirect_one_to_one_urls, req.url.path );  \n  }\n  \n  error 301;\n}',
    }
  POST /service/{id}/version/1/snippet
  - { name: 'error_redirect_synthetic',
      dynamic: 1,
      type: 'recv',
      priority: 100,
      content: 'if (obj.status == 301 && req.http.x-redirect-location) {\n  set obj.http.Location = req.http.x-redirect-location;\n  set obj.response = "Found";\n  synthetic {""};\n  return(deliver);\n}',
    }
  POST /service/{id}/version/1/dictionary
  - { name: 'redirect_one_to_one_urls' }

return service { id, ... }


steps to list the current rules
firebase.site.settings.urls
GET /service/{id}/version/{active_version}/dictionary/{dictionary_id_one_to_one_redirect_urls}

if no header for redirect.pattern
POST /service/{id}/version/{active_version}/header
- {
    name: 'response-redirect-' + nameFor( redirect )
    type: 'response'
    action: 'set'
    dst: 'http.Location'
    src: redirect.destination
    ignore_if_set: 0
    priority: redirect.priority
  }

if there is a header for redirect.pattern
check to see that `priority` & `src` value match
if they do not match, update the record
PUT /service/{id}/version/{active_version}/header/{header-name}

for every header value, ensure there is a matching nameFor( redirect.pattern )
if there is not one,
DELETE /service/{id}/version/{active_version}/header/{header-name}

*/

var _ = require( 'lodash' )
var url = require( 'url' )
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

  // name of the dictionary on fastly that contains redirects
  var REDIRECT_ONE_TO_ONE_URLS = 'redirect_one_to_one_urls';

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
      serviceForDomain(),              // { domain, service_id, dictionary_id }
      redirectsForDomain( site ),      // { domain, service_id, dictionary_id, cms_redirects, cdn_items }
      itemsForService(),               // { domain, service_id, dictionary_id, item_actions }
      applyItemsForService(),          // { domain, service_id, dictionary_id, item_actions }
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
        .filter( function ( domain ) { return domain === 'stage.edu.risd.systems' } )
        // .filter( function ( domain ) { return domain === 'www.risd.edu' } )
        .forEach( function ( domain ) { emitter.push( { domain: domain } ) } )
      emitter.push( null )
    } )

    return emitter;
  }

  function domainsToConfigureFn ( siteName, callback ) {

    var domainForDeploy = function ( deploy ) {
      return deploy.bucket;
    }

    var usesFastly = function ( domain ) {
      return domain.startsWith( 'stage.' ) || domain.endsWith( 'risd.edu' )
    }

    deploys.get( { siteName: siteName }, function ( error, configuration ) {
      if ( error ) {
        console.log( error )
        return;
      }
      var fastlyDomains = configuration.deploys.map( domainForDeploy ).filter( usesFastly )
      callback( null, fastlyDomains )
    } )
  }

  function serviceForDomain () {
    return miss.through.obj( function ( args, enc, next ) {

      miss.pipe(
        usingArguments( { domain: args.domain } ),
        existingService(),                          // { service_id?, active_version?, dictionary_id? }
        createAndConfigureService(),                // { service_id, active_version, dictionary_id }
        sink( function ( row ) {
          var nextArgs = Object.assign( {}, args, {
            service_id: row.service_id,
            dictionary_id: row.dictionary_id,
          } )
          next( null, nextArgs )
        } ),
        function onComplete ( error ) {
          if ( error ) return next( error )
        } )

    } )

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
      return miss.through.obj( function (args, enc, next ) {

        if ( args.service_id !== false ) return next( null, args )

        miss.pipe(
          usingArguments( { domain: args.domain } ),
          createService(),
          configureGoogleBackend(),
          configureDomain(),
          configureVclRecvRedirectSnippet(),
          configureVclErrorRedirectSnippet(),
          configureOneToOneRedirectDictionary(),
          activateNewServiceVersion(),
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

      function configureVclRecvRedirectSnippet () {
        return miss.through.obj( function ( args, enc, next ) {
          var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'snippet' ].join( '/' )
          var apiParams = {
            name: 'recv_redirect_urls',
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
            name: 'error_redirect_synthetic',
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

      function activateNewServiceVersion () {
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
    }
  }

  function redirectsForDomain ( site ) {
    var cms_redirects = undefined;

    return miss.through.obj( function ( args, enc, next ) {

      miss.pipe(
        usingArguments( Object.assign( {}, args ) ),  // { domain, service_id, dictionary_id }
        getCmsRedirects( site ),                      // sets cms_redirects
        getCdnItems(),                                // { domain, service_id, dictionary_id, cdn_items }
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
          getSiteKey(),                      // { service_id, dictionary_id, site, siteKey }
          getRedirects(),                    // { service_id, dictionary_id, site, siteKey } sets cms_redirects
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
          console.log( 'cdn_items:' + items.length )
          next( null, args )
        } )
      } )
    }
  }

  function itemsForService () {

    return miss.through.obj( function ( args, enc, next ) {
      var item_actions = [];
      item_actions = item_actions.concat( args.cms_redirects.map( createOrUpdateActions ).filter( isNotFalse ) )
      item_actions = item_actions.concat( args.cdn_items.map( deleteActions ).filter( isNotFalse ) )

      next( null, { item_actions: item_actions, domain: args.domain, service_id: args.service_id, dictionary_id: args.dictionary_id } )
    
      function actionFor ( operation, redirect ) {
        return {
          op: operation,
          item_key: redirect.pattern,
          item_value: redirect.destination,
        }
      }

      function createOrUpdateActions ( cms_redirect ) {
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
      }

      function deleteActions ( cdn_item ) {
        for (var i = args.cms_redirects.length - 1; i >= 0; i--) {
          if ( args.cms_redirects[i].pattern === cdn_item.item_key ) return false;
        }

        return {
          op: "delete",
          item_key: cdn_item.item_key,
        }
      }

      function isNotFalse ( value ) { return value !== false; }
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
          var nextArgs = {
            domain: args.domain,
            service_id: args.service_id,
            dictionary_id: args.dictionary_id,
          }
          next( null, nextArgs )
        } )
    } )

    function feedActions ( args ) {
      var emitter = miss.through.obj()
      var maxActions = 200;
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
        console.log( 'items:' + args.item_actions.length )
        fastly.jsonRequest( 'PATCH', apiUrl, { items: args.item_actions }, function ( error, result ) {
          if ( error ) return next( error )
          next( null, args )
        } )
      } )
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
