

/**
* The command delegator is a program that moves jobs queued up in firebase into beanstalk. We move
* them to beanstalk because beanstalk is better at handling delayed jobs and making sure only one
* worker is executing a specific job. The delegator uses memcached to make sure it does not accidentally
* queue up multiple copies of the same job.
*/

var {EventEmitter} = require('events');
var util = require('util');
var Firebase = require('./firebase/index.js');
var colors = require('colors');
var _ = require('lodash');
var async = require('async');
var beanstalkd = require('./node-beanstalkd.js');
var Memcached = require('memcached');
var Deploys = require( 'webhook-deploy-configuration' )
var jobLifetime = require('./jobQueue.js').jobLifetime;

var escapeUserId = require('./utils/firebase-escape')

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
 */
module.exports.start = CommandDelegator;

function CommandDelegator (config) {
  if ( ! ( this instanceof CommandDelegator ) ) return new CommandDelegator(config)
  EventEmitter.call( this )

  const firebase = Firebase(config.get('firebase'))

  // Memcached is used for locks, to avoid setting the same job
  var memcached = new Memcached(config.get('memcachedServers'));
  var self = this;

  this.root = firebase.database()

  var deploys = Deploys(firebase.database().ref())

  // Where in firebase we look for commands, plus the name of the locks we use in memcached
  var commandUrls = [
    { command: 'management/commands/build/', lock: 'build', tube: 'build' },
    { command: 'management/commands/create/', lock: 'create', tube: 'create' },
    { command: 'management/commands/invite/', lock: 'invite', tube: 'invite' },
    { command: 'management/commands/dns/', lock: 'dns', tube: 'dns' },
    { command: 'management/commands/siteSearchReindex/', lock: 'siteSearchReindex', tube: 'siteSearchReindex' },
    { command: 'management/commands/previewBuild/', lock: 'previewBuild', tube: 'previewBuild' },
    { command: 'management/commands/redirects/', lock: 'redirects', tube: 'redirects' },
    { command: 'management/commands/domainMap/', lock: 'domainMap', tube: 'domainMap' },
  ];

  var commandHandlersStore = commandHandlersInterface();

  // For each command we listen on a seperate tube and firebase url
  console.log('Starting clients'.red);

  var commandTasks = commandUrls.map( connectionForCommandTasks );

  async.parallel( commandTasks, onCommandHandlers )

  return this;

  function onCommandHandlers ( error, commandHandlers ) {
    if ( error ) {
      return self.emit( 'error', error )
    }
    commandHandlers.forEach( commandHandlersStore.add )

    self.emit( 'ready', commandHandlersStore.external() )
  }

  function connectionForCommandTasks ( item ) {
    return function task ( onConnectionMade ) {
      // Seperate client per command
      var client = new beanstalkd.Client();
      client.connect(config.get('beanstalkServer'), function(err, conn) {
        if(err) {
          console.log(err);
          return onConnectionMade( err )
        }
        conn.use(item.tube, function(err, tubename) {
          if(err) {
            console.log(err);
            return onConnectionMade( err )
          }
          var memcachedCommandHandler = handleCommands(conn, item);
          onConnectionMade( null,  Object.assign( { memcachedCommandHandler: memcachedCommandHandler }, item ) )
        });
      });
      
      client.on('close', function(err) {
        console.log('Closed connection');
        return onConnectionMade( err )
      });
    }
  }

  function commandHandlersInterface () {
    var handlers = {};
    
    var add = function ( command ) {
      handlers[ command.tube ] = command;
    }

    var queueMemcached = function ( toQueue ) {
      try {
        handlers[ toQueue.tube ].memcachedCommandHandler( toQueue.data )
      } catch ( error ) {
        throw error;
      }
    }

    var queueFirebase = function ( toQueue, callback ) {
      if ( typeof callback !== 'function' ) callback = function noop () {}

      self.root.ref( handlers[ toQueue.tube ].command ).push().set( toQueue.data, callback )
    }

    var external = function () {
      return {
        queueMemcached: queueMemcached,
        queueFirebase: queueFirebase,
      }
    }

    return {
      add: add,
      external: external,
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

    // project::firebase::ref::done
    // project::firebase::on--child_added::done
    self.root.ref(item.command).on('child_added', onCommandSnapshot, onCommandSnapshotError);

    return handleCommandData;

    function onCommandSnapshot ( snapshot ) {

      var payload = snapshot.val();
      var identifier = snapshot.key;
      
      // We remove the data immediately to avoid duplicates
      // project::firebase::ref::done
      // project::firebase::child::done
      // project::firebase::remove::done
      self.root.ref(item.command).child(snapshot.key).remove()

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
        // TODO: update deploys to use promise interface
        deploys.get( { siteName: payload.sitename }, function ( error, configuration ) {
          if ( error ) {
            console.log( error )
            return;
          }

          if ( payload.siteBucket ) {
            var siteBuckets = [ payload.siteBucket ]
          }
          else if ( payload.branch ) {
            var siteBuckets = configuration.deploys
              .filter( function ( deploy ) { return deploy.branch === payload.branch } )
              .map( function ( deploy ) { return deploy.bucket } )
          }
          else {
            var siteBuckets = configuration.deploys.map( function ( deploy ) { return deploy.bucket } )
          }

          siteBuckets = _.uniq( siteBuckets )

          return siteBuckets.map( toBuildCommandArgs ).forEach( queueCommandForArgs )

          function toBuildCommandArgs ( siteBucket ) {
            var identifier = Deploys.utilities.nameForSiteBranch( payload.sitename, siteBucket )
            var memcacheLockId = [ item.lock, identifier, 'queued' ].join( '_' )
            var deploysForBuild = configuration.deploys.filter( function ( deploy ) { return deploy.bucket === siteBucket } )
            var payloadArgs = {
              siteBucket: siteBucket,
              branch: deploysForBuild[ 0 ].branch,
            }
            return {
              identifier: identifier,
              memcacheLockId: memcacheLockId,
              payload: Object.assign( {}, payload, payloadArgs ),
            }
          }
        } )

      } else if ( item.tube ==='previewBuild' ) {

        // preview builds piggy back on regular build signals
        if ( payload.contentType && payload.itemKey ) {
          // TODO: update deploys to use promise interface
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
            console.log( error )
            console.log('command not queued');
          } else {
            console.log('command queued')
          }

          console.log( 'identifier: ', identifier )
          console.log( 'lockId: ', lockId )
          console.log( 'memcacheLockId: ', memcacheLockId )

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

util.inherits( CommandDelegator, EventEmitter )
