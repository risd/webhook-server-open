const test = require('tape')
const Memcached = require('memcached')
const grunt = require('grunt')
const webhookTasks = require('../../Gruntfile.js')

webhookTasks(grunt)

const memcached = new Memcached(grunt.config('memcachedServers'))

const add = (key, value, lifetime) => {
  return new Promise((resolve, reject) => {
    memcached.add(key, value, lifetime, function (err) {
      if (err) reject(err)
      else resolve()
    })
  })
}

const del = (key) => {
  return new Promise((resolve, reject) => {
    memcached.del(key, function (err) {
      if (err) reject(err)
      else resolve()
    })
  })
}

test('memcached', async function (t) {
  const key = 'key'
  const value = 'value'
  const lifetime = 10
  try {
    await add(key, value, lifetime)
    t.ok('Added to memcached')
    await del(key)
    t.ok('Deleted from memcached')
  }
  catch (error) {
    console.log(error)
    t.fail(error, 'failed to .add and/or .del from memcached')
  }
  finally {
    t.end()
  }
})

test.onFinish( process.exit )
