var _ = require( 'lodash' )
var async = require( 'async' )
var Firebase = require( './firebase/index.js' )
var FastlyWebhook = require( './fastly/index' )
var JobQueue = require( './jobQueue.js' )

module.exports.start = function ( config, logger ) {
  var self = this;

  var jobQueue = JobQueue.init( config )
  var cdn = FastlyWebhook( config.get( 'fastly' ) )

  // project::firebase::initialize::done
  var firebase = Firebase( config().firebase )
  this.root = firebase.database()

  var reportStatus = function(site, message, status, code) {
    if ( ! code ) code = 'DOMAINS'
    // project::firebase::ref::done
    var messagesRef = self.root.ref('/management/sites/' + site + '/messages/');
    // project::firebase::push::done
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: code }, function() {
      // project::firebase::ref::done
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          // project::firebase::startAt::done
          // project::firebase::limiteToFirst::done
          // project::firebase::once--child_added::done
          // project::firebase::child::done
          // project::firebase::remove::done
          messagesRef.startAt().limitToFirst(1).once('child_added', function(snap) {
            messagesRef.child(snap.key).remove();
          });
        }
      });
    });
  }

  console.log( 'Waiting for commands' )

  jobQueue.reserveJob( 'domainMap', 'domainMap', domainMapper )

  return domainMapper;

  function domainMapper ( payload, identifier, data, client, callback ) {
    var site = data.sitename;

    var domainMappingArguments = {
      maskDomain: data.maskDomain,
      contentDomain: data.contentDomain,
    }

    if ( data.contentDomain ) {
      var domainFn = addDomains;
      var domainMappingFn = 'mapDomain';
    } 
    else {
      var domainFn = removeDomains;
      var domainMappingFn = 'removeMapDomain';
    }

    var tasks = [
      domainFn( domainMappingArguments.maskDomain ),
      domainMappingTaskFor( domainMappingFn, domainMappingArguments ),
      activateVersion,
    ]

    return async.series( tasks, function ( error, results ) {
      if ( error ) {
        reportStatus( site, `Failed Domain mapping attempt for ${ domainMappingArguments.maskDomain }.`, 1 )
        return callback( error )
      }
      if ( domainMappingArguments.contentDomain ) {
        reportStatus( site, `Succeeded mapping domain ${ domainMappingArguments.maskDomain} to ${ domainMappingArguments.contentDomain }.`, 0 )
      }
      else {
        reportStatus( site, `Succeeded removing domain mapping for ${ domainMappingArguments.maskDomain}.`, 0 )
      }
      callback( null, results )
    } )

    function addDomains ( domains ) {
      return function addDomainsTask ( taskComplete ) {
        cdn.domain( domains, callbackDebug( 'add-domains', taskComplete ) )
      }
    }

    function removeDomains ( domains ) {
      return function removeDomainsTask( taskComplete ) {
        cdn.removeDomain( domains, callbackDebug( 'remove-domains', taskComplete ) )
      }
    }

    function domainMappingTaskFor ( domainMappingFn, domainMappingArguments ) {
      return function domainMappingTask ( taskComplete ) {
        cdn[ domainMappingFn ]( domainMappingArguments, callbackDebug( 'domain-mapping', taskComplete ) )
      }
    }

    function activateVersion ( taskComplete ) {
      cdn.activate( callbackDebug( 'activate-task', taskComplete ) )
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
