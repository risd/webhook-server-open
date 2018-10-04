var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt )

var backup = require( '../libs/backup.js' )

test( 'backup', function ( t ) {
  t.plan( 1 )
  
  backup.start( grunt.config, console.log, function ( error ) {
    t.assert( ! error, 'Backup completed without error.' )
  } )
} )
