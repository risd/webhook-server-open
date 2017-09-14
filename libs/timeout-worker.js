var JobQueue = require('./jobQueue.js');

module.exports.start = function ( config, logger ) {
  var jobQueue = JobQueue.init( config )
  jobQueue.reserveJob( 'build', 'build', timeoutJob )
}

function timeoutJob ( payload, identifier, data, client, callback ) {
  console.log( 'timeout-job:' + data.instance )
  var jobLifetime = JobQueue.jobLifetime * 2;
  console.log( jobLifetime )
  setTimeout( callback, jobLifetime )
}