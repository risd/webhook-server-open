'use strict';

/**
* The command delegator is a program that moves jobs queued up in firebase into beanstalk. We move
* them to beanstalk because beanstalk is better at handling delayed jobs and making sure only one
* worker is executing a specific job. The delegator uses memcached to make sure it does not accidentally
* queue up multiple copies of the same job.
*/

var events = require('events');
var util = require('util');
var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var async = require('async');
var beanstalkd = require('./node-beanstalkd.js');
var cloudStorage = require('./cloudStorage.js');
var Memcached = require('memcached');
var Deploys = require( 'webhook-deploy-configuration' )
var miss = require( 'mississippi' )
var jobLifetime = require('./jobQueue.js').jobLifetime;

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
module.exports.start = CommandDelegator;

function CommandDelegator (config, logger) {
  if ( ! ( this instanceof CommandDelegator ) ) return new CommandDelegator( config, logger )
  events.EventEmitter.call( this )

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

  var commandHandlersStore = commandHandlersInterface();

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    // For each command we listen on a seperate tube and firebase url
    console.log('Starting clients'.red);

    var commandTasks = commandUrls.map( connectionForCommandTasks );

    return async.parallel( commandTasks, onCommandHandlers )
  });

  return this;

  function onCommandHandlers ( error, commandHandlers ) {
    commandHandlers.forEach( function ( handler ) {
      commandHandlersStore.add(  handler.tube, handler.commandHandler )
    } )

    self.emit( 'ready', commandHandlersStore.queue )
  }

  function connectionForCommandTasks ( item ) {
    return function task ( onConnectionMade ) {
      // Seperate client per command
      var client = new beanstalkd.Client();
      client.connect(config.get('beanstalkServer'), function(err, conn) {
        if(err) {
          console.log(err);
          return process.exit(1);
        }
        conn.use(item.tube, function(err, tubename) {
          if(err) {
            console.log(err);
            return process.exit(1);
          }
          var commandHandler = handleCommands(conn, item);
          onConnectionMade( null, { tube: item.tube, commandHandler: commandHandler })
        });
      });
      
      client.on('close', function(err) {
        console.log('Closed connection');
        return process.exit(1);
      });
    }
  }

  function commandHandlersInterface () {
    var handlers = {};
    
    var add = function ( tube, handler ) {
      handlers[ tube ] = handler;
    }

    var queue = function ( tube, commandData ) {
      try {
        handlers[ tube ]( commandData )
      } catch ( error ) {
        throw error;
      }
    }

    return {
      add: add,
      queue: queue,
    }
  }

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

    console.log( 'lock-job' )
    console.log( lockId )

    memcached.add(lockId, LOCKED, jobLifetime, function(err) {
      if (err) {
        // job is already in the queue
        console.log('memcached:add:err')
        return callback(err);
      } else {
        console.log('memcached:add')
        // priority, delay, time to run
        client.put(1, 0, jobLifetime,
          JSON.stringify({ identifier: identifier, payload: payload }),
          function(err) { callback(err); });
      }
    });
  };

  // After creating a client we listen in firebase for jobs,
  // as jobs are added we queue them up ten listen again.
  function handleCommands(client, item) { 
    console.log('Waiting on commands for ' + item.tube);
    self.root.child(item.commands).on('child_added', onCommandSnapshot, onCommandSnapshotError);

    return handleCommandData;

    function onCommandSnapshot ( snapshot ) {

      var payload = snapshot.val();
      var identifier = snapshot.name();
      
      // We remove the data immediately to avoid duplicates
      snapshot.ref().remove();

      var commandData = {
        payload: payload,
        identifier: identifier,
      }

      return handleCommandData( commandData );

    }

    function onCommandSnapshotError (err) {
      console.log(err);
    }

    function handleCommandData ( commandData ) {
      console.log( 'commandData:start' )
      console.log( commandData )
      console.log( 'commandData:end' )

      var payload = commandData.payload;
      var identifier = commandData.identifier;

      var lockId = payload.id || 'noneya';
      var memcacheLockId = item.lock + '_' + lockId + '_queued';

      if ( item.tube === 'build' ) {
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

          if ( payload.siteBucket ) {
            var siteBuckets = [ payload.siteBucket ]
          }
          else {
            var siteBuckets = configuration.deploys.map( function ( deploy ) { return deploy.bucket } )
          }
          siteBuckets = _.uniq( siteBuckets )

          return siteBuckets.map( toBuildCommandArgs ).forEach( queueCommandForArgs )

          function toBuildCommandArgs ( siteBucket ) {
            var identifier = Deploys.utilities.nameForSiteBranch( payload.sitename, siteBucket )
            var memcacheLockId = [ item.lock, identifier, 'queued' ].join( '_' )
            var deploys = configuration.deploys.filter( function ( deploy ) { return deploy.bucket === siteBucket } )
            var branches = deploys.map( function ( deploy ) { return deploy.branch } )
            var payloadBase = {
              deploys: deploys,
              siteBucket: siteBucket,
              branch: branches[ 0 ],
            }
            return {
              identifier: identifier,
              memcacheLockId: memcacheLockId,
              payload: Object.assign( {}, payloadBase, payload ),
            }
          }
        } )

      } else if ( item.tube ==='previewBuild' ) {

        // preview builds piggy back on regular build signals
        if ( payload.contentType && payload.itemKey ) {
          deploys.get( { siteName: payload.sitename }, function ( error, configuration ) {
            if ( error ) {
              console.log( error )
              return;
            }

            var siteBuckets = configuration.deploys.map( function ( deploy ) { return deploy.bucket } )
            siteBuckets = _.uniq( siteBuckets )
            
            return siteBuckets.map( toPreviewBuildArgs ).forEach( queueCommandForArgs )

            function toPreviewBuildArgs ( siteBucket ) {
              var previewIdentifier = [ payload.sitename, siteBucket, payload.contentType, payload.itemKey ].join( '_' )
              var memcacheLockId = [ 'previewBuild', previewIdentifier, 'queued' ].join( '_' )
              return {
                identifier: previewIdentifier,
                memcacheLockId: memcacheLockId,
                payload: Object.assign( { siteBucket: siteBucket }, payload )
              }
            }

          } )
        }
      } else {
        var queueCommandArgs = { identifier: identifier, memcacheLockId: memcacheLockId, payload: payload }
        return queueCommandForArgs( queueCommandArgs )
      }

      function queueCommandForArgs ( args ) {
        var identifier = args.identifier;
        var memcacheLockId = args.memcacheLockId;
        var payload = args.payload;

        console.log('memcacheLockId');
        console.log(memcacheLockId);

        console.log('handlingCommand')
        console.log(identifier)
        console.log(lockId)
        console.log(memcacheLockId)
        console.log(JSON.stringify(payload))

        console.log('queueing task');

        handlingCommand = handlingCommand + 1;

        queueCommand(client, item, identifier, memcacheLockId, payload, onQueueComplete);

        function onQueueComplete (error) {
          if (error) {
            console.log('command not queued');
          } else {
            console.log('command queued')
          }

          memcached.del(memcacheLockId, function () {
            console.log('memcached:del:', memcacheLockId)
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

    }

  }

}

util.inherits( CommandDelegator, events.EventEmitter )

function isNotFalse ( datum ) { return datum !== false }
