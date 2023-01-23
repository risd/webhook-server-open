const config = require('../config')
const test = require('tape')
const {pipeline} = require('stream')
const miss = require('mississippi')
const grunt = require('grunt')
const webhookTasks = require( '../../Gruntfile.js' )
const cloudStorage = require('../../libs/cloudStorage')

webhookTasks(grunt)

const {fileNameForTimestamp} = require( '../../libs/backup.js' )
const backupExtractor = require( '../../libs/backup-extractor.js' )

test('backup-extractor', async function (t) {
  t.plan(1)
  const { keyPath, timestamp } = config.backupExtractor
  try {
    const readStream = await cloudStorage.objects.createReadStream({
      bucket: grunt.config.get('backupBucket'),
      file: fileNameForTimestamp(timestamp),
    })
    pipeline(
      readStream,
      backupExtractor.getParser(keyPath),
      miss.concat((jsonBuffer) => {
        const json = JSON.parse(jsonBuffer.toString())
        t.ok(json, 'got json just fine')
      }),
      (error) => {
        if (error) t.fail(error, 'did not finish')
      }
    )
  }
  catch (error) {
    console.log(error)
    t.fail(error, 'failed to backup')
  }
})

test.onFinish(process.exit)
