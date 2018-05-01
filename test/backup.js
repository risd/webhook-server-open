var test = require( 'tape' )
var grunt = require( 'grunt' )
var backup = require( '../libs/backup.js' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt )

test( 'backup', function ( t ) {
  t.plan( 1 )
  
  backup.start( grunt.config, console.log, function ( error ) {
    t.assert( error === null, 'Backup completed without error.' )
  } )
} )
