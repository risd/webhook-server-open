/*

Redirects management via Fastly.

*/

var _ = require( 'lodash' )
var async = require( 'async' )
var url = require( 'url' )
var crypto = require( 'crypto' )
var request = require( 'request' )
var FastlyWebhook = require( './fastly/index' )
var Firebase = require( './firebase/index' )
var JobQueue = require('./jobQueue.js')
var Deploys = require( 'webhook-deploy-configuration' )
var miss = require( 'mississippi' )
var throughConcurrent = require( 'through2-concurrent' )
var utils = require( './utils.js' )
var isAscii = require( 'is-ascii' );

// todo
// update the `isNotDevelopmentDomain` to use the Fastly domains
// configuration. If fastly.addressForDomain is not false, create
// the redirect

// Util streams
var usingArguments = utils.usingArguments;
var sink = utils.sink;

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

module.exports.start = function ( config, logger ) {
  var self = this;

  // redirects are not established for development domains
  var developmentDomain = config.get( 'mailgunDomain' )

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init( config );

  var fastly = FastlyWebhook( config.get( 'fastly' ) )

  var firebaseOptions = Object.assign(
    { initializationName: 'redirects-worker' },
    config().firebase )

  // project::firebase::initialize::done
  var firebase = Firebase( firebaseOptions )
  this.root = firebase.database()

  var deploys = Deploys( this.root )

  var reportStatus = function(site, message, status) {
    // project::firebase::ref::done
    var messagesRef = self.root.ref('/management/sites/' + site + '/messages/');
    // project::firebase::push::done
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: 'REDIRECTS' }, function() {
      // project::firebase::once--value::done
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limit(1).once('child_added', function(snap) {
            messagesRef.child(snap.key).remove();
          });
        }
      });
    });
  }

  console.log( 'Waiting for commands'.red )

  // Wait for create commands from firebase
  jobQueue.reserveJob( 'redirects', 'redirects', redirects )

  return redirects;

  function redirects ( payload, identifier, data, client, callback ) {
    var site = data.sitename;
    var siteName = unescapeSite( site )

    /*
    
    domainsToConfingure : siteName => [ domains ]
      addDomains : [ domains ] => [ { status } ]
      addRedirects : [ domains ] => [ { domain, redirects } ] => [ { status } ]
      activate : () => [ service_id, version ]

    */

    return domainsToConfingure( siteName, callbackDebug( 'domains-to-configure', withDomains ) )

    function withDomains ( error, domains ) {
      if ( error ) return callback( error )

      var tasks =  [
        addDomains( domains ),
        addRedirects( domains ),
        activateTask,
      ]

      async.series( tasks, callback )
    }

    function domainsToConfingure ( siteName, callback ) {

      // { bucket, branch } => bucket
      var domainForDeploy = function ( deploy ) {
        return deploy.bucket;
      }

      // domain => boolean
      var isFastlyDomain = function ( domain ) {
        return fastly.isFastlyDomain( domain )
      }

      // siteName, taskComplete => taskComplete( error | null, domains : string[] | undefined )
      var getDeployBuckets = function ( siteName, taskComplete ) {
        deploys.get( { siteName: siteName }, function ( error, configuration ) {
          if ( error ) {
            console.log( error )
            return taskComplete( error );
          }
          var domains = configuration.deploys.map( domainForDeploy )
          taskComplete( null, domains )
        } )
      }

      var replaceMaskDomains = function ( taskComplete ) {
        return function replace ( error, domains ) {
          if ( error ) return taskComplete( error )

          var replaceTasks = domains.map( toReplaceTask )

          return async.parallel( replaceTasks, function ( error, updatedDomains ) {
            if ( error ) return taskComplete( error )
            taskComplete( null, updatedDomains.filter( isFastlyDomain ) )
          } )

          function toReplaceTask ( domain ) {
            return function replaceTask ( replaceComplete ) {
              fastly.maskForContentDomain( domain, function ( error, maskDomain ) {
                if ( error ) return replaceComplete( error )
                if ( typeof maskDomain === 'string' ) return replaceComplete( null, maskDomain )
                else return replaceComplete( null, domain )
              } )
            }
          }
        }
      }

      return getDeployBuckets( siteName, replaceMaskDomains( callback ) )
    }

    function addDomains ( domains ) {
      return function addDomainsTask ( taskComplete ) {
        fastly.domain( domains, callbackDebug( 'add-domains', taskComplete ) )
      }
    }

    function addRedirects ( domains ) {
      return function addRedirectsTask ( taskComplete ) {

        redirectsForDomainTask( function ( error, redirects ) {
          if ( error ) return taskComplete( error )

          var tasks = domains.map( setRedirectsForDomain( redirects ) )

          return async.series( tasks, taskComplete )
        } )
      }

      function setRedirectsForDomain ( redirects ) {
        return function perDomain ( domain ) {
          return function setRedirectsTask ( taskComplete ) {
            fastly.redirects( { host: domain, redirects: redirects }, taskComplete )
          }
        }
      }

      function redirectsForDomainTask ( taskComplete ) {
        var tasks = [ getSiteKey, getRedirects ]
        return async.waterfall( tasks, function ( error, results ) {
          if ( error ) return taskComplete( error )
          var redirects = results;
          taskComplete( null, redirects )
        } )
      }

      function getSiteKey ( taskComplete ) {
        console.log( 'get-site-key' )
        // project::firebase::ref::done
        // project::firebase::once--value::done
        self.root.ref( 'management/sites/' + site ).once( 'value', onSiteData, onSiteError )

        function onSiteData ( siteData ) {
          var siteValues = siteData.val()
          console.log( 'get-site-key:success' )
          console.log( siteValues.key )
          taskComplete( null, siteValues.key )
        }

        function onSiteError ( error ) {
          console.log( 'get-site-key:error' )
          console.log( error )
          taskComplete( error )
        }
      }

      function getRedirects ( siteKey, taskComplete ) {
        // project::firebase::ref::done
        // project::firebase::child::done
        // project::firebase::once--value::done
        self.root.ref( 'buckets' ).child( site ).child( siteKey ).child( 'dev/settings/redirect' )
          .once( 'value', onRedirects, onRedirectsError )

        function onRedirects ( redirectsData ) {
          var redirects = redirectsData.val()
          var cmsRedirects = []
          if ( typeof redirects === 'object' && redirects !== null ) {
            Object.keys( redirects ).forEach( function ( redirectKey ) {
              cmsRedirects.push( redirects[ redirectKey ] )
            } )
          }
          cmsRedirects = _.uniqWith( cmsRedirects, function ( a, b ) { return a.pattern === b.pattern } )
          cmsRedirects = cmsRedirects.filter( function ( redirect ) {
            return isAscii( redirect.pattern ) && isAscii( redirect.destination )
          } )
          taskComplete( null, cmsRedirects )
        }

        function onRedirectsError ( error ) {
          return taskComplete( error )
        }
      }
    }

    function activateTask ( taskComplete ) {
      fastly.activate( callbackDebug( 'activate-task', taskComplete ) )
    }
  }
}

function callbackDebug ( name, callback ) {
  if ( typeof name === 'function' ) callback = name;

  return function wrapsCallback ( error, result ) {
    if ( error ) {
      console.log( name + ':error' )
      console.log( error )
    }
    else {
      console.log( name + ':success' )
      console.log( result )
    }
    callback( error, result )
  }
}
