var testOptions = require( '../env-options.js' )()
var webhookTasks = require( '../../Gruntfile.js' )
var grunt = require( 'grunt' )
var test = require( 'tape' )

webhookTasks( grunt )

var cloudStorage = require( '../../libs/cloudStorage.js' )

var deleteBucket = testOptions.buildBucketName;

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

// // this is commented out to enable the delete function at the end of
// // the lib/ tests to complete. 
// test( 'delete-bucket', function ( t ) {
//   t.plan( 1 )
//   cloudStorage.objects.deleteAll( deleteBucket, function ( error ) {
//     if ( error ) {
//       return t.fail( 'Could not delete bucket items.') 
//     }

//     cloudStorage.buckets.del( deleteBucket, function ( error ) {
//       t.assert( error === 204, 'Deleted bucket successfully' )
//     } )
//   } )
// } )
