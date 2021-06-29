var testOptions = require( '../env-options.js' )()
var webhookTasks = require( '../../Gruntfile.js' )
var crypto = require( 'crypto' )
var grunt = require( 'grunt' )
var zlib = require( 'zlib' )
var test = require( 'tape' )

webhookTasks( grunt )

var cloudStorage = require( '../../libs/cloudStorage.js' )

var deleteBucket = testOptions.buildBucketName;

var uploadOptions = {
  bucket: grunt.config.get( 'uploadsBucket' ),
  local: 'Simple text file',
  remote: 'test/cloud-strorage-upload.txt',
  overrideMimeType: 'text/plain'
}

var compressedUploadOptions = Object.assign(
  {},
  uploadOptions,
  { remote: 'test/cloud-strorage-upload-compressed.txt' }
)

test( 'upload-object', function ( t ) {
  t.plan( 3 )

  cloudStorage.objects.upload( uploadOptions.bucket, uploadOptions.local, uploadOptions.remote, function ( error, results ) {
    t.assert( ! error, 'uploaded file content without error.' )
    t.assert( uploadOptions.bucket === results.bucket, 'uploaded file to the correct bucket.' )
    t.assert( uploadOptions.remote === results.name, 'uploaded file to the correct path.' )
  } )
} )

test( 'upload-compressed-object', function ( t ) {
  t.plan( 3 )

  cloudStorage.objects.uploadCompressed( compressedUploadOptions, function ( error, results ) {
    t.assert( ! error, 'uploaded file content without error.' )
    t.assert( compressedUploadOptions.bucket === results.bucket, 'uploaded file to the correct bucket.' )
    t.assert( compressedUploadOptions.remote === results.name, 'uploaded file to the correct path.' )
  } )
} )

test( 'matching-metadata', function ( t ) {
  t.plan( 2 )

  cloudStorage.objects.getMeta( uploadOptions.bucket, uploadOptions.remote, function ( error, remoteFileMeta ) {
    t.assert( ! error, 'uploaded file content without error.' )

    var localFileMd5 = crypto
      .createHash( 'md5' )
      .update( uploadOptions.local )
      .digest( 'base64' )

    t.assert( remoteFileMeta.md5Hash === localFileMd5, 'Matching md5 hash' )
  } )
} )

test( 'matching-compression-metadata', function ( t ) {
  t.plan( 2 )

  cloudStorage.objects.getMeta( compressedUploadOptions.bucket, compressedUploadOptions.remote, function ( error, remoteFileMeta ) {

    zlib.gzip( compressedUploadOptions.local, function ( error, compressedLocal ) {
      t.assert( error === null, 'Successfully gzip local file content' )

      var localFileMd5 = crypto
        .createHash( 'md5' )
        .update( compressedLocal, 'utf8' )
        .digest( 'base64' )

      t.assert( remoteFileMeta.md5Hash === localFileMd5, 'Matching md5 hash' )
    } )
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
