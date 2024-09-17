const config = require('../config.js')
var webhookTasks = require( '../../Gruntfile.js' )
var crypto = require( 'crypto' )
var grunt = require( 'grunt' )
var zlib = require( 'zlib' )
var test = require( 'tape' )
const miss = require('mississippi')

webhookTasks(grunt)

var cloudStorage = require('../../libs/cloudStorage.js')

test('bucket-list-files-stream', async (t) => {
  let count = 0
  miss.pipe(
    cloudStorage.objects.listStream({
      bucket: config.cloudStorage.bucket,
    }),
    miss.through.obj((file, _, next) => {
      count += 1
      next()
    }),
    (error) => {
      if (error) t.fail(error)
      else t.ok(true, `completed stream: ${count}`)
      t.end()
    }
  )
})
