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
    await cloudStorage.buckets.create({ bucket: uploadOptions.bucket })
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
  cloudStorage.objects.upload(uploadOptions)
    .then((results) => {
      t.ok(true, 'succesfully upload file')
      t.assert(typeof results.bucket === 'string', 'results.bucket exists')
      t.assert(typeof results.name === 'string', 'results.name exists')
      t.assert(typeof results.size === 'string', 'results.size exists')
      t.assert(typeof results.contentType === 'string', 'results.contentType exists')
      t.end()
    })
    .catch((error) => {
      t.fail(error, 'Could not upload file')
      t.end()
    })
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
    const existingBucket = await cloudStorage.buckets.get({ bucket: uploadOptions.bucket })
    t.ok('got bucket')
    try {
      const nonExistentBucket = await cloudStorage.buckets.get({ bucket: `non-existing-bucket-${new Date().toISOString()}` })
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

test('bucket-list-objects', async (t) => {
  t.plan(1)
  cloudStorage.objects.list({ bucket: uploadOptions.bucket }, function (error, listResult) {
    t.assert(error === null, 'got list objects without error')
  })
})

test( 'delete-bucket', async function ( t ) {
  t.plan( 2 )
  
  await cloudStorage.objects.deleteAll(uploadOptions.bucket)
  t.ok(true, 'Deleted all files')
  
  cloudStorage.buckets.del(uploadOptions.bucket, function (error, result) {
    t.assert(error === null, 'Deleted bucket successfully' )
  } )
} )
