const debug = require('debug')('lifecycle')
const fs = require('node:fs')
const config = require('../config')
const grunt = require('grunt')
const test = require('tape')
const {spawn} = require('node:child_process')
const path = require('node:path')
const {lib} = require('@risd/wh')
const mkdirp = require('mkdirp')
const FormData = require('form-data')
const { setTimeout } = require('node:timers/promises')
const {MESSAGES} = require('../../libs/jobQueue.js')

require('../../Gruntfile.js')(grunt)

const Server = require('../../libs/server')
const Deletor = require('../../libs/delete')
const Firebase = require('../../libs/firebase/index.js')
const Backup = require('../../libs/backup.js')

const firebase = Firebase(grunt.config.get('firebase'))
const deletor = Deletor(grunt.config())

const whGlobalOpts = require(config.wh.config)
whGlobalOpts.firebaseName = whGlobalOpts.firebase

function noop () {}

const cmdStringForSpawn = (s) => {
  return [
    s.split(' ')[0],
    s.split(' ').slice(1),
  ]
}

// resolve a function to kill the subprocess, or listen for
// `done-job` message to kill the subprocess
const subprocess = (cmdString, { onDone=noop }={}) => {
  const cmd = cmdString.split(' ')[0]
  const args = cmdString.split(' ').slice(1)
  const p = spawn(cmd, args)
  p.on('exit', (code, signal) => {
    if (!done) onDone(code === 0 ? null : new Error(`cmd`))
  })
  kill.p = p
  let ready = false
  let done = false
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (data) => {
      if (done) return
      const str = data.toString()
      console.log(args[1], str)
      if (str && str.toLowerCase().indexOf(MESSAGES.WAITING) !== -1) {
        ready = true
        resolve(kill)
      }
      if (str && str.toLowerCase().indexOf(MESSAGES.JOB_DONE) !== -1) {
        kill()
      }
    })
  })
  function kill () {
    if (done) return
    done = true
    if (p.killed === false) p.kill()
    onDone()
  }
}

const subprocesses = {}

test('setup-supervisor', async (t) => {
  const cmdString = 'supervisord -n -c ./test/webhook.conf'
  const processes = ['beanstalk', 'caddy', 'memcached']
  
  const supervisorProcess = (cmdString, { processes, onDone=noop }={}) => {
    const [cmd, args] = cmdStringForSpawn(cmdString)

    let inRunningState = new Set()
    const hasSuccessString = (line) => {
      for (const p of processes) {
        if (line.includes(`${p} entered RUNNING state`)) {
          inRunningState.add(p)
        }
      }
      return inRunningState.size === processes.length
    }

    const p = spawn(cmd, args, { cwd: process.cwd() })
    let ready = false
    let killed = false

    const killedEarly = (code, signal) => {
      throw new Error(`Exited early: ${cmdString}. Code: ${code}. Signal: ${signal}`)
    }

    p.on('close', killedEarly)
    p.on('error', (b) => console.error(b.toString()))

    const kill = () => new Promise((resolve, reject) => {
      killed = true
      p.off(close, killedEarly)
      p.on('close', (code, signal) => {
        return resolve()
      })
      p.kill()
    })

    return new Promise((resolve, reject) => {
      p.stdout.on('data', (data) => {
        if (killed) return
        const str = data.toString()
        if (!ready && hasSuccessString(str)) {
          ready = true
          return resolve(() => kill())
        }
      })
    })
  }

  const subprocessKill = await supervisorProcess(cmdString, { processes })
  
  subprocesses['supervisor'] = subprocessKill

  t.ok(true, 'supervisor processes ready')
  t.end()
})

test('setup-delegator', async (t) => {
  try {
    subprocesses.commandDelegator = await subprocess('npm run command-delegator')
    t.ok(true, 'Setup command delegator')
  }
  catch (error) {
    t.fail(error, 'Could not set up command delegator')
  }
  finally {
    t.end()
  }
})

/// spawn npm run command-delegator
/// spawn npm run create-worker
/// {siteDir} = wh.create({siteName})

test('setup-creator', async (t) => {
  // 1 for the creator, 1 for the create subprocess, we aren't sure which finishes
  // first, but its likely the create-worker.
  t.plan(2)
  try {
    subprocesses.creator = await subprocess('npm run create-worker', {
      onDone: (error) => {
        t.ok(!error, 'Finished create cycle without error')
      },
    })
    mkdirp.sync(config.creator.cwd)
    await lib.create({
      ...whGlobalOpts,
      ...config.wh.opts,
      siteName: config.creator.siteName,
      cwd: config.creator.cwd,
    })
    t.ok(true, 'Site created')
  }
  catch (error) {
    t.fail(error, 'Could not signal creator')
    t.end()
  }
})

/// spawn npm start (server)
/// spawn npm run build-worker
/// wh.deploy() {cwd:siteDir}
/// kill build-worker

async function ensureServer () {
  debug('setup-server')
  if (!subprocesses.server) {
    debug('setup-server:start')
    subprocesses.server = async () => {
      const server = await Server.start(grunt.config)
      return () => delete server 
    }
    return subprocesses.server()
  }
  else {
    debug('setup-server:pass')
  }
}


test('server-deploy-cycle', async (t) => {
  try {
    await ensureServer()
    let deployCount = -1
    subprocesses.builder = await subprocess('npm run build-worker', {
      onDone: (error) => {
        t.ok(!error, `Finished deploy build cycle without error. Deploy count: ${deployCount}. buildHasStarted: ${buildHasStarted}`)
        // the build process will finish after the upload is complete
        // so we can end the test here
        t.end()
      },
    })
    const siteKeySnapshot = await firebase.siteKey({ siteName: config.creator.siteName })
    const siteKey = siteKeySnapshot.val()
    const cwd = path.join(config.creator.cwd, config.creator.siteName)

    const deploy = () => {
      return lib.push({
        ...whGlobalOpts,
        cwd,
        siteName: config.creator.siteName,
        siteKey,
        branch: 'master',
        http: true,
        skipBuild: true,
      })
    }
    
    let buildHasStarted = false

    subprocesses.builder.p.on('data', () => {
      buildHasStarted = true
    })

    while (buildHasStarted === false && deployCount < 10) {
      deployCount++
      await deploy()
      await setTimeout(2000, noop)
    }

    t.ok(true, `Pushed without error. Deploy count: ${deployCount}. buildHasStarted: ${buildHasStarted}`)
  }
  catch (error) {
    t.fail(error, 'Could not signal deploy cycle build')
    t.end()
  }
})

/// run backup so that we have a snapshot to check for in our
/// subsequent server requests
test('backup', async (t) => {
  try {
    const { file, timestamp } = await Backup.start(grunt.config)
    t.ok(true, 'successfully ran firebase backup')
  }
  catch (error) {
    console.log(error)
    t.fail(error, 'failed to backup')
  }
  finally {
    t.end()
  }
})

/// spawn npm run invite-worker
/// fb.signal('invite-worker')

test('invite', async (t) => {
  try {
    subprocesses.invite = await subprocess('npm run invite-worker', {
      onDone: (error) => {
        t.ok(!error, 'Finished invite cycle without error')
        t.end()
      },
    })
    await firebase.signalInvite({ siteName: config.creator.siteName }, {
      ...config.invite,
      siteName: config.creator.siteName,
    })
    t.ok(true, 'Successfully signal invite')
  }
  catch (error) {
    t.fail(error, 'Could not signal invite')
    t.end()
  }
})

/// spawn npm run domain-mapper
/// fb.signal('domain-mapper')

test('domain-mapper', async (t) => {
  try {
    subprocesses.domainMapper = await subprocess('npm run domain-mapper', {
      onDone: (error) => {
        t.ok(!error, 'Finished domain mapper cycle without error')
        t.end()
      },
    })
    await firebase.signalDomainMapper(
      { siteName: config.creator.siteName },
      config.domainMapper)
    t.ok(true, 'Successfully signaled domain mapper')
  }
  catch (error) {
    t.fail(error, 'Could not signal domain mapper')
    t.end()
  }
})

/// spawn npm run site-index-worker
/// fb.signal('site-index-worker')

test('site-index-worker', async (t) => {
  try {
    subprocesses.siteIndex = await subprocess('npm run site-index-worker', {
      onDone: (error) => {
        t.ok(!error, 'Finished site index worker cycle without error')
        t.end()
      },
    })
    await firebase.signalSearchIndex(
      { siteName: config.creator.siteName },
      config.searchIndex)
    t.ok(true, 'Successfully signaled site search indexer')
  }
  catch (error) {
    t.fail(error, 'Could not signal site search indexer')
    t.end()
  }
})

/// spawn npm run redirects-worker
/// wh.deploys:set()
/// fb.signal('redirects-worker')

test('redirects', async (t) => {
  try {
    const redirects = {
      'hash-to-off-site-hash': {
        pattern: '/teas/african-honey-bush/#tasting-notes',
        destination: '/teas/honey-bush/#tasting-notes',
      },
      'query-string-to-off-site-hash': {
        pattern: '/teas/?tea=honey-bush&section=tasting-notes',
        destination: '/teas/honey-bush/#tasting-notes'
      },
      'query-string-longer-to-off-site-hash': {
        pattern: '/teas/?tea=honey-bush&section=tasting-notes&extra=test',
        destination: '/teas/honey-bush/',
      },
      'url-to-off-site-url': {
        pattern: '/teas/african-honey-bush/',
        destination: '/teas/honey-bush/',
      },
      'url-to-off-site-hash': {
        pattern: '/teas/honey-bush/tasting-notes/',
        destination: 'test-sink.risd.systems/teas/honey-bush/#tasting-notes',
      },
    }
    const siteKeySnapshot = await firebase.siteKey({ siteName: config.creator.siteName })
    const siteKey = siteKeySnapshot.val()
    await lib.deploys({
      ...whGlobalOpts,
      ...config.wh.opts,
      ...config.deploySet,
      siteName: config.creator.siteName,
      siteKey,
    })
    await firebase.siteRedirects({
      siteName: config.creator.siteName,
      siteKey,
    }, redirects)
    subprocesses.redirects = await subprocess('npm run redirects-worker', {
      onDone: (error) => {
        t.ok(!error, 'Finished redirects worker cycle without error')
        t.end()
      },
    })
    await firebase.signalRedirects({ siteName: config.creator.siteName }, {
      siteName: config.creator.siteName,
    })
    t.ok(true, 'Successfully signaled redirects worker.')
  }
  catch (error) {
    t.fail(error, 'Could not signal redirects')
    t.end()
  }
})

test('delete', async (t) => {
  try {
    await deletor.delete(config.creator.siteName)
    t.ok(true, 'Successfully deleted the site created for the lifecycle test')
  }
  catch (error) {
    t.fail(error, 'Error in deletor')
  }
  finally {
    t.end()
  }
})

test.onFinish(() => {
  // kill all subprocesses
  for (const key in subprocesses) {
    subprocesses[key]()
  }
  process.exit()
})