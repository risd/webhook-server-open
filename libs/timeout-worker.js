var JobQueue = require('./jobQueue.js');

module.exports.start = function ( config, logger ) {
  var jobQueue = JobQueue.init( config )
  jobQueue( 'timeout', 'timeout', timeoutJob )
}

function timeoutJob ( payload, identifier, data, client, callback ) {
  console.log( 'timeout-job' )
  console.log( payload )
  console.log( identifier )
  console.log( data )
  setTimeout( callback, 5000 )
}