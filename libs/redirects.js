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
  POST /service/{id}/version/1/response_object
  - { status: '301' 
      response: 'Moved Permanently'
      name: '301-redirect' }
return service { id, ... }


steps to list the current rules
firebase.site.settings.urls
GET /service/{id}/version/{active_version}/header

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
var url = require( 'url' )
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
  var firebaseUrl = config.get( 'firebase' ) || '';
  this.root = new firebase( 'https://' + firebaseUrl +  '.firebaseio.com/' );

  var deploys = Deploys( this.root.child( 'buckets' ) )

  var reportStatus = function(site, message, status) {
    var messagesRef = self.root.root().child('/management/sites/' + site + '/messages/');
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: 'REDIRECTS_UPDATED' }, function() {
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
      serviceForDomain(),              // { domain, service_id, active_version }
      redirectsForDomain( site ),      // { domain, service_id, active_version, cms_redirects, cdn_headers }
      actionsForService(),             // { domain, service_id, active_version, actions: [ POST,PUT,DELETE ] }
      cloneServiceVersion(),           // actions.length > 0, clone. { domain, service_id, new_version, actions: [ POST,PUT,DELETE ] }
      applyActionsForService(),        // { domain, service_id, new_version?, actions: [ POST,PUT,DELETE ] }
      activateNewServiceVersion(),     // { domain, service_id, new_version? }
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
        .filter( function ( domain ) { return domain !== 'stage.edu.risd.systems' } )
        // .filter( function ( domain ) { return domain !== 'www.risd.edu' } )
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
        existingService(),                          // { service_id?, active_version? }
        createAndConfigureService(),                // { service_id, active_version }
        sink( function ( row ) {
          var nextArgs = Object.assign( {}, args, {
            service_id: row.service_id,
            active_version: row.active_version,
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
          if ( error ) args.service_id = args.active_version = false;
          else {
            args.service_id = service.id;
            args.active_version = activeVersionIn( service.versions )
          }
          next( null, args )
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
          sink( function ( row ) {
            var nextArgs = Object.assign( {}, args, {
              service_id: row.service_id,
              active_version: row.active_version,
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
    }
  }

  function redirectsForDomain ( site ) {
    var cms_redirects = undefined;

    return miss.through.obj( function ( args, enc, next ) {
      miss.pipe(
        usingArguments( Object.assign( {}, args ) ),  // { domain, service_id, active_version }
        getCmsRedirects( site ),                      // sets cms_redirects
        getCdnHeaders(),                              // { domain, service_id, active_version, cdn_headers }
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
          getSiteKey(),                      // { service_id, active_version, site, siteKey }
          getRedirects(),                    // { service_id, active_version, site, siteKey } sets cms_redirects
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
            next( null, args )
          }

          function onRedirectsError ( error ) {
            cms_redirects = [];
            next( null, args )
          }

         } ) 
      }
    }

    function getCdnHeaders () {
      return miss.through.obj( function ( args, enc, next ) {
        var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'header' ].join( '/' )
        fastly.request( 'GET', apiUrl, function ( error, headers ) {
          if ( error ) return next( error )
          args.cdn_headers = headers;
          next( null, args )
        } )
      } )
    }
  }

  function actionsForService () {

    return miss.through.obj( function ( args, enc, next ) {
      var actions = [];
      actions = actions.concat( args.cms_redirects.map( createOrUpdateActions ).filter( isNotFalse ) )
      actions = actions.concat( args.cdn_headers.map( deleteActions ).filter( isNotFalse ) )

      next( null, { actions: actions, domain: args.domain, service_id: args.service_id, active_version: args.active_version } )

      function headerSourceFor ( destination ) {
        return '\"' + url.resolve( 'http://' + args.domain, destination ) + '\"';
      }
    
      function actionFor ( requestMethod, redirect ) {
        var responseName = responseNameFor( redirect.pattern )
        var requestConditionName = requestConditionNameFor( redirect.pattern )
        var responseConditionName = responseConditionNameFor( redirect.pattern )
        var headerName = headerNameFor( redirect.pattern )

        if ( requestMethod === 'POST' ) {
          var responseApiUrl = function ( service_id, version ) {
            return [ '/service', service_id, 'version', version, 'response_object' ].join( '/' )
          }
          var requestConditionApiUrl = responseConditionApiUrl = function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'condition' ].join( '/' ) 
          }
          var headerApiUrl = function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'header' ].join( '/' )
          }
        } else if ( requestMethod === 'PUT' ) {
          var responseApiUrl = function ( service_id, version ) {
            return [ '/service', service_id, 'version', version, 'response_object', responseName ].join( '/' )
          }
          var requestConditionApiUrl = function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'condition', requestConditionName ].join( '/' ) 
          }
          var responseConditionApiUrl = function ( service_id, version ) {
            return [ '/service', service_id, 'version', version, 'condition', responseConditionName ].join( '/' )
          }
          var headerApiUrl = function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'header', headerName ].join( '/' )
          }
        }
        return [ {
          requestMethod: requestMethod,
          url: requestConditionApiUrl,
          params: {
            type: 'REQUEST',
            name: requestConditionName,
            statement: 'req.url ~ \"' + redirect.pattern + '\"',
            priority: redirect.priority ? redirect.priority + 10 : 10,
          },
        }, {
          requestMethod: requestMethod,
          url: responseConditionApiUrl,
          params: {
            type: 'RESPONSE',
            name: responseConditionName,
            statement: 'req.url ~ \"' + redirect.pattern + '\" && resp.status == 301',
            priority: redirect.priority ? redirect.priority + 10 : 10,
          },
        }, {
          requestMethod: requestMethod,
          url: responseApiUrl,
          params: {
            name: responseName,
            status: '301',
            response: 'Moved Permanently',
            request_condition: requestConditionName,
          },
        }, {
          requestMethod: requestMethod,
          url: headerApiUrl,
          params: {
            name: headerName,
            src: headerSourceFor( redirect.destination ),
            priority: redirect.priority ? redirect.priority + 10 : 10,
            response_condition: responseConditionName,
            type: 'response',
            action: 'set',
            dst: 'http.Location',
            ignore_if_set: 0,
          },
        } ]
      }

      function createOrUpdateActions ( cms_redirect ) {
        for (var i = args.cdn_headers.length - 1; i >= 0; i--) {
          if ( args.cdn_headers[i].name === headerNameFor( cms_redirect.pattern ) ) {
            if ( args.cdn_headers[i].src === headerSourceFor( cms_redirect.destination ) ) {
              // already exists, no updated needed
              return false;
            } else {
              // already exists, but updated
              return actionFor( 'PUT', cms_redirect )
            }
          }
        }

        // not found in cdn_headers, lets make it
        return actionFor( 'POST', cms_redirect )
      }

      function deleteActions ( cdn_header ) {
        for (var i = args.cms_redirects.length - 1; i >= 0; i--) {
          if ( headerNameFor( args.cms_redirects[i].name ) === cdn_header.name ) return false;
        }
        return [ {
          requestMethod: 'DELETE',
          url: function ( service_id, version ) {
            return [ '/service', service_id, 'version', version, 'header', cdn_header.name ].join( '/' )
          },
          params: {},
        }, {
          requestMethod: 'DELETE',
          url: function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'condition', cdn_header.response_condition ].join( '/' )
          },
          params: {},
        }, {
          requestMethod: 'DELETE',
          url: function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'condition', requestConditionNameFromResponseCondition( cdn_header.response_condition ) ].join( '/' )
          },
          params: {},
        }, {
          requestMethod: 'DELETE',
          url: function ( service_id, version) {
            return [ '/service', service_id, 'version', version, 'response_object', responseNameFromResponseCondition( cdn_header.response_condition ) ].join( '/' )
          },
          params: {},
        } ]
      }

      function isNotFalse ( value ) { return value !== false; }
    } )

    function headerNameFor ( pattern ) {
      return 'header-response-redirect-' + pattern;
    }

    function requestConditionNameFor( pattern ) {
      return 'request-condition-' + pattern;
    }

    function responseConditionPrefix () {
      return 'response-condition-';
    }
    function responseConditionNameFor ( pattern ) {
      return responseConditionPrefix() + pattern;
    }

    function responseNameFor ( pattern ) {
      return 'response-301-' + pattern;
    }

    function requestConditionNameFromResponseCondition( response_condition ) {
      return requestConditionNameFor( response_condition.split( responseConditionPrefix() )[ 1 ] )
    }

    function responseNameFromResponseCondition( response_condition ) {
      return responseNameFor( response_condition.split( responseConditionPrefix() )[ 1 ] )
    }
  }

  function cloneServiceVersion () {
    return miss.through.obj( function ( args, enc, next ) {
      if ( args.actions.length === 0 ) return next( null, args )

      var apiUrl = [ '/service', args.service_id, 'version', args.active_version, 'clone' ].join( '/' )
      fastly.request( 'PUT', apiUrl, function ( error, new_version ) {
        if ( error ) return next( error )
        console.log( 'cloned' )
        console.log( new_version )
        var nextArgs = {
          domain: args.domain,
          service_id: args.service_id,
          new_version: new_version.number,
          actions: args.actions,
        }
        next( null, nextArgs )
      } )
    } )
  }

  function applyActionsForService () {
    return miss.through.obj( function ( args, enc, next ) {
      if ( args.actions.length === 0 && typeof args.new_version !== 'number' ) return next( null, args )

      miss.pipe(
        feedActions( args ),
        applyActions(),
        sink(),
        function onComplete ( error ) {
          if ( error ) return next( error )
          var nextArgs = {
            domain: args.domain,
            service_id: args.service_id,
            new_version: args.new_version,
          }
          next( null, nextArgs )
        } )
    } )

    function feedActions ( args ) {
      var emitter = miss.through.obj()

      args.actions.forEach( function ( action ) {
        setTimeout( function () {
          emitter.push( { service_id: args.service_id, domain: args.domain, new_version: args.new_version, action: action } )
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

        var service_id = args.service_id;
        var version = args.new_version;
        var action = args.action;

        miss.pipe(
          miss.from.obj( action.concat( null ) ),
          miss.through.obj( execute ),
          sink(),
          function onComplete ( error ) {
            if ( error ) return next( error )
            next( null, args )
          } )

        function execute ( actionArgs, actionEnc, nextAction ) {
          requests = requests + 1;
          if ( ! ( actionArgs.params.name ? isAscii( actionArgs.params.name ) : true ) ) {
            console.log( 'not-ascii' )
            console.log( actionArgs )
            return nextAction( null, actionArgs )
          }

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

  function activateNewServiceVersion () {
    return miss.through.obj( function ( args, enc, next ) {
      if ( typeof args.new_version !== 'number' ) return next( null, args )

      var validateApiUrl = [ '/service', args.service_id, 'version', args.new_version, 'validate' ].join( '/' )
      var activateApiUrl = [ '/service', args.service_id, 'version', args.new_version, 'activate' ].join( '/' )

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
