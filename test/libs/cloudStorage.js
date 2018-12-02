var testOptions = require( '../env-options.js' )()
var webhookTasks = require( '../../Gruntfile.js' )
var grunt = require( 'grunt' )
var test = require( 'tape' )

webhookTasks( grunt )

var cloudStorage = require( '../../libs/cloudStorage.js' )

test( 'upload-compressed-object', function ( t ) {
  t.plan( 3 )

  var uploadOptions = {
    bucket: grunt.config.get( 'uploadsBucket' ),
    local: 'file content',
    remote: 'test/cloud-strorage-upload.txt',
    overrideMimeType: 'text/plain'
  }
  cloudStorage.objects.uploadCompressed( uploadOptions, function ( error, results ) {
    t.assert( ! error, 'uploaded file content without error.' )
    t.assert( uploadOptions.bucket === results.bucket, 'uploaded file to the correct bucket.' )
    t.assert( uploadOptions.remote === results.name, 'uploaded file to the correct path.' )
  } )
} )
