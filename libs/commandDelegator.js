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

  // Where in firebase we look for commands, plus the name of the locks we use in memcached
  var commandUrls = [
    { commands: 'management/commands/build/', lock: 'build', tube: 'build' },
    { commands: 'management/commands/create/', lock: 'create', tube: 'create' },
    { commands: 'management/commands/verification/', lock: 'verification', tube: 'verification' },
    { commands: 'management/commands/invite/', lock: 'invite', tube: 'invite' },
    { commands: 'management/commands/dns/', lock: 'dns', tube: 'dns' },
  ];

  // var build_queue = BuildQueue()

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
  * @param identifier Unique identifer for the command
  * @param lockId     Lock to use
  * @param payload    Payload of the command to queue up
  * @param callback   Called when finished
  */
  function queueCommand(client, item, identifier, lockId, payload, callback) {
    console.log('Queueing Command for ' + item.tube);

    // Identifier is a uuid for the given command, so we lock it and just let it expire in an hour
    var memcaheLockId = item.lock + '_' + lockId + '_queued';
    console.log('memcaheLockId');
    console.log(memcaheLockId);

    var LOCKED = 'locked'

    try {
      memcached.get(memcaheLockId, function (err, lock_value) {
        console.log('current lock value for ' + memcaheLockId)
        console.log('is: ' + lock_value)
        if (lock_value === LOCKED) return;
      });
    } catch (e) {
      console.log('could not get memcaheLockId')
      console.log(e)
    }

    memcached.add(memcaheLockId, LOCKED, 60 * 60, function(err) {
      if(err) {
        return;
      } else {
        // We give it a TTL of 3 minutes
        console.log('client.put')
        console.log(JSON.stringify(identifier))
        console.log('payload')
        console.log(JSON.stringify(payload))
        client.put(1, 0, (60 * 3), JSON.stringify({ identifier: identifier, payload: payload }), function() { callback(); });
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

      var retries = 0;

      // We remove the data immediately to avoid duplicates
      commandData.ref().remove();

      console.log('handlingCommand')
      console.log(identifier)
      console.log(lockId)
      console.log(JSON.stringify(payload))

      // if we are building, lets make sure we aren't
      // already building the same site
      var queue_task = true
      if ( item.tube === 'build' )
        lockId = payload.sitename
        // queue_task = build_queue.add( identifier )

      if ( queue_task ) {
        console.log('queueing task');
        handlingCommand = handlingCommand + 1;
        queueCommand(client, item, identifier, lockId, payload, onQueueComplete);
      } else {
        console.log('task is already queued');
        maybeDie()
      }

      function onQueueComplete ( error ) {
        // build only throws error when templates don't compile correctly
        // which, they always should. so lets restart that task
        if ( item.tube === 'build') {
          if ( error ) retries += 1

          if ( error && retries < 5 ) {
            console.log( 'build:retrying:' + identifier )
            queueCommand(client, item, identifier, lockId, payload, onQueueComplete)
            return;
          }
        }

        // build_queue.remove( identifier )

        handlingCommand = handlingCommand - 1;
        maybeDie()
      }

      function maybeDie () {
        // If we had a sigterm and no one is handling commands, die
        if(dieSoon && (handlingCommand === 0)) {
          process.exit(0);
        }
      }

    }, function(err) {
      console.log(err);
    });
  }

  return this;
};

function BuildQueue () {
  // the number of identifiers we want in our build queue
  var instances_allowed = 1

  // list of identifiers ( siteName ) being built
  var building = []

  var instances = function countOfSiteInBuildQueue ( siteName ) {
    return building
      .filter(function ( identifier ) {
        return ( identifier === siteName )
      })
      .length
  }

  // returns true if we should build
  // returns false if we are already building
  var add = function addSiteToBuildQueue ( siteName ) {
    console.log( 'addSiteToBuildQueue' )
    console.log( siteName )
    var current_instances = instances( siteName )
    console.log( current_instances )
    console.log( instances_allowed )

    if ( current_instances >= instances_allowed ) return false
    
    building = building.concat( [ siteName ] )
    console.log( building )

    return true
  }

  // returns true if we removed the siteName from the build queue
  // returns false if there was no instance of the siteName
  var remove = function removeSiteFromBuildQueue ( siteName ) {
    console.log( 'removeSiteFromBuildQueue' )
    console.log( siteName )

    var siteNameIndex = building.indexOf( siteName )
    if ( siteNameIndex === -1 ) return false
    
    building = building.slice(0, siteNameIndex).concat(
        building.slice(siteNameIndex + 1))
    
    return true
  }

  return {
    add: add,
    remove: remove,
  }
}