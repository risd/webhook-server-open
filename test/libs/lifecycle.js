const config = require('../config')
const test = require('tape')
const grunt = require('grunt')
const test = require('tape')
const {spawn} = require('node:child_process')
const path = require('node:path')
const {lib} = require('@risd/wh')
const mkdirp = require('mkdirp')
const Server = require('../libs/server')
const axios = require('axios')
const FormData = require('form-data')

require('../../Gruntfile.js')(grunt)

const creator = require( '../../libs/creator.js' )
const Firebase = require( '../../libs/firebase/index.js' )
const firebaseEscape = require( '../../libs/utils/firebase-escape.js' )

const firebase = Firebase(grunt.config.get('firebase'))

const whGlobalOpts = require(config.wh)
whGlobalOpts.firebaseName = whGlobalOpts.firebase

function noop () {}

// resolve a function to kill the subprocess, or listen for
// `done-job` message to kill the subprocess
const subprocess = (cmdString, { onDone=noop }={}) => {
  const cmd = cmdString.split(' ')[0]
  const args = cmdString.split(' ').slice(1)
  const p = spawn(cmd, args)
  p.on('exit', (code, signal) => {
    onDone(code === 0 ? null : new Error(`cmd`))
  })
  let ready = false
  let done = false
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (data) => {
      if (done) return
      if (ready) return
      const str = data.toString()
      if (str && str.toLowerCase().indexOf('waiting') !== -1) {
        ready = true
        resolve(() => kill())
      }
      if (str && str.toLowerCase().indexOf('job-queue:done-job') !== -1) {
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

const subprocesses = {
  commandDelegator: await subprocess('npm run command-delegator'),
}

// spawn npm run command-delegator
// spawn npm run create-worker
// {siteDir} = wh.create({siteName})

test('setup-creator', async (t) => {
  try {
    subprocesses.creator = await subprocess('npm run create-worker', {
      onDone: (error) => {
        t.ok(!error, 'Finished create cycle without error')
        t.end()
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

// spawn npm start (server)
// spawn npm run build-worker
// wh.deploy() {cwd:siteDir}
// kill build-worker

test('server-deploy-cycle', async (t) => {
  try {
    if (!subprocesses.server) subprocesses.server = await Server(grunt.config)
    subprocesses.builder = await subprocess('npm run build-worker', {
      onDone: (error) => {
        t.ok(!error, 'Finished deploy build cycle without error')
        t.end()
      },
    })
    const siteKeySnapshot = await firebase.siteKey({ siteName: config.creator.siteName })
    const siteKey = siteKeySnapshot.val()
    const cwd = path.join(config.creator.cwd, config.creator.siteName)
    await lib.push({
      ...whGlobalOpts,
      cwd,
      siteName: config.creator.siteName,
      siteKey,
      branch: 'master',
      http: true,
    })
    t.ok(true, 'Pushed without error')
  }
  catch (error) {
    t.fail(error, 'Could not signal deploy cycle build')
    t.end()
  }
})

// axios requests against server

test('server-cms-requests', async (t) => {
  if (!subprocesses.server) subprocesses.server = await Server(grunt.config)
  const urlForServer = (frag) => `http://localhost:${subprocesses.server.port}${frag}`
  const siteKeySnapshot = await firebase.siteKey({ siteName: config.creator.siteName })
  const siteKey = siteKeySnapshot.val()

  const siteNameAndKey = (form) => {
    form.append('site', config.creator.siteName)
    form.append('token', siteKey)
  }
  
  try {
    const rootResponse = await axios.get(urlForServer('/'))
    t.assert(rootResponse.status === 200, '200 root response')  
  }
  catch (error) {
    t.fail(error, 'Error in / request')
  }
  
  try {
    const backupsSnapshot = await firebase.backups()
    const backups = backupsSnapshot.val()
    const timestamp = backups[Object.keys(backups)[Object.keys(backups).length - 1]]  
    const form = new FormData()
    siteNameAndKey(form)
    form.append('timestamp', timestamp)
    const backupResponse = await axios.post(
      urlForServer('/backup-snapshot/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(backupResponse.status === 200, '200 backup response')
    t.assert(
      backupResponse.data.contentType &&
      backupResponse.data.data &&
      backupResponse.data.settings,
      'Got backup response data in correct shape.')
  }
  catch (error) {
    t.fail(error, 'Error in /backup-snapshot/')
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    form.append('resize_url', true)
    form.append('url', 'https://lh3.googleusercontent.com/G6Tkw7hXhmR34zpkXA3nBHZ05tgAb2OewVO5NOrv5LUovd-UIqtaZ3rOoNemzXosxFt4HrQXshJ3UIbDuwQOf2sIjQJcuuGeSalc4QG1E1s=s760')
    const uploadUrlResponse = await axios.post(
      urlForServer('/upload-url/')
      form,
      { headers: form.getHeaders() }
    )
    t.assert(uploadUrlResponse.status === 200, '200 upload url response')
    t.assert(
      uploadUrlResponse.data.message &&
      uploadUrlResponse.data.url &&
      uploadUrlResponse.data.size &&
      uploadUrlResponse.data.mimeType &&
      uploadUrlResponse.data.resize_url,
      'Got upload url response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /upload-url/')
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    form.append('resize_url', true)
    form.append(
      'payload',
      fs.readFileSync(path.join( __dirname, '..', 'files', 'img.png' )),
      {
        filename: 'img.png',
        contentType: 'image/png',
      })
    const uploadFileResponse = await axios.post(
      urlForServer('/upload-file/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(uploadFileResponse.status === 200, '200 upload url response')
    t.assert(
      uploadFileResponse.data.message &&
      uploadFileResponse.data.url &&
      uploadFileResponse.data.size &&
      uploadFileResponse.data.mimeType &&
      uploadFileResponse.data.resize_url,
      'Got upload file response data in correct shape')

  }
  catch (error) {
    t.fail(error, 'Error in /upload-file/')
  }

  const searchDocument = (form) => {
    form.append('data', JSON.stringify({ name: 'test-title' }))
    form.append('id', 'one-off-page')
    form.append('typeName', 'pages')
    form.append('oneOff', true)
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    searchDocument(form)
    const searchIndexResponse = await axios.post(
      urlForServer('/search/index/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(searchIndexResponse.status === 200, '200 search index response')
    t.assert(
      searchIndexResponse.data.message,
      'Got search idnex response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/index/')
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    searchDocument(form)
    form.append('query', 'test')
    const searchResponse = await axios.post(
      urlForServer('/search/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(searchResponse.status === 200, '200 search response')
    t.assert(
      searchResponse.data.message &&
      searchResponse.data.hits,
      'Got search response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/')
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    searchDocument(form)
    const searchDeleteResponse = await axios.post(
      urlForServer('/search/delete/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(searchDeleteResponse.status === 200, '200 search delete response')
    t.assert(
      searchDeleteResponse.data.message,
      'Got search delete response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/delete/')
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    searchDocument(form)
    const searchDeleteTypeResponse = await axios.post(
      urlForServer('/search/delete/type/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(searchDeleteTypeResponse.status === 200, '200 search delete type response')
    t.assert(
      searchDeleteTypeResponse.data.message,
      'Got search delete type response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/delete/type/')
  }

  try {
    const form = new FormData()
    siteNameAndKey(form)
    searchDocument(form)
    const searchDeleteIndexResponse = await axios.post(
      urlForServer('/search/delete/index/'),
      form,
      { headers: form.getHeaders() }
    )
    t.assert(searchDeleteIndexResponse.status === 200, '200 search delete index response')
    t.assert(
      searchDeleteIndexResponse.data.message,
      'Got search delete index response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/delete/index/')
  }
})

// spawn npm run invite-worker
// fb.signal('invite-worker')

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
      siteref: config.creator.siteName,
    })
    t.ok(true, 'Successfully signal invite')
  }
  catch (error) {
    t.fail(error, 'Could not signal invite')
    t.end()
  }
})

// spawn npm run domain-mapper
// fb.signal('domain-mapper')

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

// spawn npm run site-index-worker
// fb.signal('site-index-worker')

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

// spawn npm run redirects-worker
// wh.deploys:set()
// fb.signal('redirects-worker')

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
