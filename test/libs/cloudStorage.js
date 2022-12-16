const config = require('../config.js')
var webhookTasks = require( '../../Gruntfile.js' )
var crypto = require( 'crypto' )
var grunt = require( 'grunt' )
var zlib = require( 'zlib' )
var test = require( 'tape' )

webhookTasks(grunt)

var cloudStorage = require('../../libs/cloudStorage.js')

var uploadOptions = {
  bucket: config.cloudStorage.bucket,
  local: 'Simple text file',
  remote: 'test/cloud-strorage-upload.txt',
  overrideMimeType: 'text/plain'
}

var compressedUploadOptions = Object.assign(
  {},
  uploadOptions,
  { remote: 'test/cloud-strorage-upload-compressed.txt' }
)

test('create-bucket', async (t) => {
  try {
    await cloudStorage.buckets.create(uploadOptions.bucket)
    t.ok(true, 'created bucket')
  }
  catch (error) {
    t.fail(error, 'failed to create bucket')
  }
  finally {
    t.end()
  }
})

test( 'upload-object', function ( t ) {
  t.plan( 1 )

  cloudStorage.objects.upload(uploadOptions, function ( error, results ) {
    t.assert( ! error, 'uploaded file content without error.' )
  } )
} )

test( 'upload-compressed-object', function ( t ) {
  t.plan( 1 )

  cloudStorage.objects.uploadCompressed( compressedUploadOptions, function ( error, results ) {
    t.assert( ! error, 'uploaded file content without error.' )
  } )
} )

test( 'matching-metadata', function ( t ) {
  t.plan( 2 )

  cloudStorage.objects.getMeta({
    bucket: uploadOptions.bucket,
    file: uploadOptions.remote,
  }, function ( error, remoteFileMeta ) {
    t.assert( ! error, 'uploaded file content without error.' )

    var localFileMd5 = crypto
      .createHash( 'md5' )
      .update( uploadOptions.local )
      .digest( 'base64' )

    t.assert( remoteFileMeta.md5Hash === localFileMd5, 'Matching md5 hash' )
  } )
} )

test('buckets', async (t) => {
  try {
    const existingBucket = await cloudStorage.buckets.get(uploadOptions.bucket)
    t.ok('got bucket')
    try {
      const nonExistentBucket = await cloudStorage.buckets.get(`non-existing-bucket-${new Date().toISOString()}`)  
    }
    catch (error) {
      t.ok('non existent bucket errors')
    }
  }
  catch (error) {
    t.fail(error)
  }
  finally {
    t.end()
  }
})

test( 'delete-bucket', async function ( t ) {
  t.plan( 2 )
  
  await cloudStorage.objects.deleteAll(uploadOptions.bucket)
  t.ok(true, 'Deleted all files')
  
  cloudStorage.buckets.del(uploadOptions.bucket, function (error, result) {
    t.assert(error === null, 'Deleted bucket successfully' )
  } )
} )
