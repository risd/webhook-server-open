var async = require( 'async' )
var exec = require( 'child_process' ).exec
var spawn = require( 'child_process' ).spawn
var jobQueue = require( './jobQueue.js' )

module.exports.start = function ( config, logger, callback ) {
  jobQueue.init( config )

  var tasks = [ supervisorTask( 'stop', 'build_worker:*' ) ]
    .concat( destroyTubeTasks( [ 'build' ] ) )
    .concat( flushMemcacheTask( config.get( 'memcachedServers' ) ) )
    .concat( [ supervisorTask( 'start', 'build_worker:*' ) ] )

  async.series( tasks, function ( error ) {
    if ( error ) console.log( error )
    console.log( 'done' )
    callback( error )
  } )

  function destroyTubeTasks ( tubes ) {

    return tubes.map( destroyTasksForTube )

    function destroyTasksForTube ( tube ) {
      return function task ( complete ) {
        jobQueue.destroyJobs( { tube: tube }, complete )
      }
    }
  }

  function supervisorTask ( cmd, scope ) {
    return function task ( complete ) {
      console.log( `supervisor ${ cmd } ${ scope }` )
      exec( `sudo supervisorctl ${ cmd } ${ scope }`, function ( error, stdout, stderr ) {
        if ( error ) console.log( error )
        complete()
      } )
    }
  }

  // "echo 'flush_all' | netcat 127.0.0.1 11211"
  function flushMemcacheTask ( addresses ) {

    return addresses.map( flushTasksForAddress )

    function flushTasksForAddress ( address ) { 
      return function task ( complete ) {
        console.log( 'flush-task-for-address' )
        console.log( address )

        var host = address.split( ':' )[ 0 ]
        var port = address.split( ':' )[ 1 ]

        var flushAll = spawn( 'sh', [ '-c', `echo 'flush_all' | netcat ${ host } ${ port }` ] )

        flushAll.stdout.on( 'data', function ( data ) {
          console.log( 'flush:data' )
          console.log( data )

          var str = data.toString()
          
          console.log( 'flush:data-str' )
          console.log( str )
          
          if ( str.indexOf( 'OK' ) > -1 ) {
            console.log( 'flush:kill' )
            flushAll.stdin.pause()
            flushAll.kill( 'SIGKILL' )
          }
        } )

        flushAll.stderr.on( 'data', function ( data ) {
          console.log( `echo error: ${ data }` )
        } )

        flushAll.on( 'exit', function ( code ) {
          if ( code !== 0 ) console.log( `netcat process exited with code: ${ code }` )
          else console.log( 'flush:exit' )
          complete()
        } )
      } 
    }
  }
}
