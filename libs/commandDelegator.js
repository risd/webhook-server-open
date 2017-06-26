'use strict';

/**
* The command delegator is a program that moves jobs queued up in firebase into beanstalk. We move
* them to beanstalk because beanstalk is better at handling delayed jobs and making sure only one
* worker is executing a specific job. The delegator uses memcached to make sure it does not accidentally
* queue up multiple copies of the same job.
*/

var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var async = require('async');
var beanstalkd = require('./node-beanstalkd.js');
var cloudStorage = require('./cloudStorage.js');
var Memcached = require('memcached');
var Deploys = require( 'webhook-deploy-configuration' )
var miss = require( 'mississippi' )

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var handlingCommand = 0;
var dieSoon = false;

// Handle SIGTERM gracefully exit when command done processing
// useful for easy supervisor restart without losing data
process.on('SIGTERM', function() {

  if(handlingCommand === 0) {
    process.exit(0);
  } else {
    dieSoon = true;
  }

});

/**
 * @param  {Object}   config     Configuration options from .firebase.conf
 * @param  {Object}   logger     Object to use for logging, defaults to no-ops (DEPRECATED)
 */
module.exports.start = function (config, logger) {
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  // Memcached is used for locks, to avoid setting the same job
  var memcached = new Memcached(config.get('memcachedServers'));
  var self = this;
  var firebaseUrl = config.get('firebase') || '';
  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com/');

  var deploys = Deploys( this.root.child( 'buckets' ) )

  // Where in firebase we look for commands, plus the name of the locks we use in memcached
  var commandUrls = [
    { commands: 'management/commands/build/', lock: 'build', tube: 'build' },
    { commands: 'management/commands/create/', lock: 'create', tube: 'create' },
    { commands: 'management/commands/verification/', lock: 'verification', tube: 'verification' },
    { commands: 'management/commands/invite/', lock: 'invite', tube: 'invite' },
    { commands: 'management/commands/dns/', lock: 'dns', tube: 'dns' },
    { commands: 'management/commands/siteSearchReindex/', lock: 'siteSearchReindex', tube: 'siteSearchReindex' },
    { commands: 'management/commands/previewBuild/', lock: 'previewBuild', tube: 'previewBuild' },
    { commands: 'management/commands/redirects/', lock: 'redirects', tube: 'redirects' },
  ];

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    // For each command we listen on a seperate tube and firebase url
    console.log('Starting clients'.red);
    commandUrls.forEach(function(item) {

      // Seperate client per command
      var client = new beanstalkd.Client();
      client.connect(config.get('beanstalkServer'), function(err, conn) {
        if(err) {
          console.log(err);
          process.exit(1);
        }
        conn.use(item.tube, function(err, tubename) {
          if(err) {
            console.log(err);
            process.exit(1);
          }
          handleCommands(conn, item);
        });
      });
      
      client.on('close', function(err) {
        console.log('Closed connection');
        process.exit(1);
      });
    });
  });

  /*
  * Queues the command in beanstalk/firebase
  *
  * @param client     The beanstalk client
  * @param item       The item containing tube/lock information
  * @param identifier Unique identifier for the command
  * @param lockId     Lock to use
  * @param payload    Payload of the command to queue up
  * @param callback   Called when finished
  */
  function queueCommand(client, item, identifier, lockId, payload, callback) {
    console.log('Queueing Command for ' + item.tube);

    // Identifier is a uuid for the given command, so we lock it and just let it expire in an hour

    var LOCKED = 'locked'

    memcached.add(lockId, LOCKED, 60 * 3, function(err) {
      console.log( 'memcached:add:args' )
      console.log( arguments )
      if(err) {
        console.log('memcached:add:err')
        callback(err)
        return;
      } else {
        console.log('memcached:add')
        // We give it a TTL of 3 minutes
        console.log('client-put:start')
        console.log(JSON.stringify(identifier))
        console.log(JSON.stringify(payload))
        client.put(1, 0, (60 * 3),
          JSON.stringify({ identifier: identifier, payload: payload }),
          function(err) { console.log('client-put:end'); callback(err); });
      }
    });
  };

  // After creating a client we listen in firebase for jobs,
  // as jobs are added we queue them up ten listen again.
  function handleCommands(client, item) { 
    console.log('Waiting on commands for ' + item.tube);
    self.root.child(item.commands).on('child_added', function(commandData) {

      var payload = commandData.val();
      var identifier = commandData.name();
      var lockId = payload.id || 'noneya';
      var memcaheLockId = item.lock + '_' + lockId + '_queued';

      // We remove the data immediately to avoid duplicates
      commandData.ref().remove();
      
      if ( item.tube === 'build' ) {
      	console.log( 'building' )
      	// lock id should be site name and site branch
      	// since the branch is linked to the zip file that
      	// gets used to build the site
      	// if no branch is defined, then queue a command for
      	// each of the branches
      	deploys.get( { siteName: payload.sitename }, function ( error, configuration ) {
					if ( error ) {
						console.log( error )
						return;
					}

					if ( payload.branch ) {
						var branches = [ payload.branch ]
					} else {
						var branches = configuration.deploys.map( function ( deploy ) { return deploy.branch; } )
					}

					branches = _.uniq( branches );

					var buildCommandsArgs = branches.map( function ( branch ) {
						var identifier = Deploys.utilities.nameForSiteBranch( payload.sitename, branch )
						payload.branch = branch;
            payload.deploys = configuration.deploys;
						return {
							identifier: identifier,
							memcaheLockId: [ item.lock, identifier, 'queued' ].join( '_' ),
							payload: Object.assign( {}, payload ),
						}
					} )

					buildCommandsArgs.forEach( queueCommandForArgs )					

	    	} )

      } else if ( item.tube ==='previewBuild' ) {

        deploys.get( { siteName: payload.sitename }, function ( error, configuration ) {
          if ( error ) {
            console.log( error )
            return;
          }

          // preview builds piggy back on regular build signals
          if ( payload.contentType && payload.itemKey ) {
            var previewIdentifier = [ payload.sitename, payload.contentType, payload.itemKey ].join( '_' )
            var previewBuildCommandArgs = {
              identifier: previewIdentifier,
              memcaheLockId: [ 'previewBuild', identifier, 'queued' ].join( '_' ),
              payload: Object.assign( { deploys: configuration.deploys }, payload ),
            }
            queueCommandForArgs( previewBuildCommandArgs )
          }
        } )

      } else {
        var queueCommandArgs = { identifier: identifier, memcaheLockId: memcaheLockId, payload: payload }
        queueCommandForArgs( queueCommandArgs )
      }

    	function queueCommandForArgs ( args ) {
      	var identifier = args.identifier;
      	var memcaheLockId = args.memcaheLockId;
      	var payload = args.payload;

      	console.log('memcaheLockId');
	      console.log(memcaheLockId);

	      console.log('handlingCommand')
	      console.log(identifier)
	      console.log(lockId)
	      console.log(memcaheLockId)
	      console.log(JSON.stringify(payload))

	      console.log('queueing task');

	      handlingCommand = handlingCommand + 1;

	      queueCommand(client, item, identifier, memcaheLockId, payload, onQueueComplete);

	      function onQueueComplete (error) {
	        if (error) {
	          console.log('command not queued');
	        }

	        memcached.del(memcaheLockId, function () {
	          console.log('memcached:del:', memcaheLockId)
	          handlingCommand = handlingCommand - 1;
	          maybeDie()
	        })
	      }

	      function maybeDie () {
	        // If we had a sigterm and no one is handling commands, die
	        if(dieSoon && (handlingCommand === 0)) {
	          process.exit(0);
	        }
	      }

      }

    }, function(err) {
      console.log(err);
    });
  }

  return this;

};
