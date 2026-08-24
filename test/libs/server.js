const debug = require('debug')('server')
const config = require('../config')
const grunt = require('grunt')
const test = require('tape')
const { Blob } = require('node:buffer')
const { readFileSync } = require('node:fs')
const path = require('node:path')

require('../../Gruntfile.js')(grunt)

const Server = require('../../libs/server')
const Firebase = require('../../libs/firebase/index.js')


let server
const firebase = new Firebase(grunt.config.get('firebase'))

const serverUrl = (path) => {
  return `http://localhost:${server.app.server.address().port}${path}`
}

const formSiteNameAndKey = (form) => {
  form.append('site', config.server.siteName)
  form.append('token', config.server.siteKey)
}
const searchSiteNameandKey = (searchParams) => {
  searchParams.set('site', config.server.siteName)
  searchParams.set('token', config.server.siteKey)
}

const { uploadDeploySiteSpec } = config.server

test('server:start', async (t) => {
  server = await Server.start(grunt.config)
  const rootRes = await fetch(serverUrl('/'))
  t.ok(rootRes.ok, 'Got root request')

  t.end()
})

test('/upload-url/', async (t) => {
  const form = new FormData()
  formSiteNameAndKey(form)
  form.append('resize_url', 'true')
  form.append('url', 'http://rubenrodriguez.me/favicon.png')
  const res = await fetch(serverUrl('/upload-url/'), {
    method: 'POST',
    body: form,
  })
  t.ok(res.ok, 'Uploaded file via url')

  const data = await res.json()

  t.ok(
    data.message
    && data.url
    && data.size
    && data.mimeType
    && data.resize_url, 'Uploaded file response contains all properties')

  t.end()
})

test('/upload-file/', async (t) => {
  const form = new FormData()
  formSiteNameAndKey(form)
  form.append('resize_url', 'true')
  const fileBlob = new Blob([
    readFileSync(path.join( __dirname, '..', 'files', 'img.png' ))
  ])
  form.append('payload', fileBlob, 'img.png')
  const res = await fetch(serverUrl('/upload-file/'), {
    method: 'POST',
    body: form,
  })

  t.ok(res.ok, '200 upload url response')

  const data = await res.json()

  t.ok(
    data.message
    && data.url
    && data.size
    && data.mimeType
    && data.resize_url,
    'Got upload file response data in correct shape')

  t.end()
})


test('/search/*', async (t) => {
  const formSearchDocument = (form) => {
    form.append('data', JSON.stringify({ name: 'test-title' }))
    form.append('id', 'one-off-page')
    form.append('typeName', 'pages')
    form.append('oneOff', 'true')
  }

  try {
    const form = new FormData()
    formSiteNameAndKey(form)
    formSearchDocument(form)
    const res = await fetch(serverUrl('/search/index/'), {
      method: 'POST',
      body: form,
    })
    t.assert(res.ok, '200 search index response')

    const data = await res.json()

    t.assert(
      data.message,
      'Got search index response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/index/')
  }

  try {
    const form = new FormData()
    formSiteNameAndKey(form)
    formSearchDocument(form)
    form.append('query', 'test')
    const res = await fetch(serverUrl('/search/'), {
      method: 'POST',
      body: form,
    })
    t.assert(res.ok, '200 search response')

    const data = await res.json()

    t.assert(Array.isArray(data?.hits), 'search response includes hits')
  }
  catch (error) {
    t.fail(error, 'Error in /search/')
  }

  try {
    const form = new FormData()
    formSiteNameAndKey(form)
    formSearchDocument(form)
    const res = await fetch(serverUrl('/search/delete/'), {
      method: 'POST',
      body: form,
    })
    t.assert(res.ok, '200 search delete response')

    const data = await res.json()

    t.assert(
      data.message,
      'Got search delete response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/delete/')
  }

  try {
    const form = new FormData()
    formSiteNameAndKey(form)
    formSearchDocument(form)
    const res = await fetch(serverUrl('/search/delete/type/'), {
      method: 'POST',
      body: form,
    })
    t.assert(res.ok, '200 search delete type response')

    const data = await res.json()

    t.assert(
      data.message,
      'Got search delete type response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/delete/type/')
  }

  try {
    const form = new FormData()
    formSiteNameAndKey(form)
    formSearchDocument(form)
    const res = await fetch(serverUrl('/search/delete/index/'), {
      method: 'POST',
      body: form,
    })
    t.assert(res.ok, '200 search delete index response')

    const data = await res.json()

    t.assert(
      data.message,
      'Got search delete index response data in correct shape')
  }
  catch (error) {
    t.fail(error, 'Error in /search/delete/index/')
  }
  finally {
    t.end()
  }
})

test('/backup-snapshot/', async (t) => {
  const backupsSnapshot = await firebase.backups()
  const backups = backupsSnapshot.val()
  const timestamp = backups[Object.keys(backups)[Object.keys(backups).length - 1]]
  const searchParams = new URLSearchParams()
  searchSiteNameandKey(searchParams)
  searchParams.set('timestamp', timestamp)
  const res = await fetch(serverUrl(`/backup-snapshot/?${searchParams.toString()}`))

  t.ok(res.ok, '200 backup snapshot')

  t.end()
})

test('/upload/', async (t) => {
  const {
    branch,
    payload,
  } = uploadDeploySiteSpec

  // TODO
  // - use this fetch based upload in the webhook cli
  // - import it for use here
  const form = new FormData()
  formSiteNameAndKey(form)

  form.append("payload", new Blob([readFileSync(payload.content)]), {
    filename: payload.fileName,
    contentType: payload.contentType,
  })
  form.append("branch", branch)

  try {
    const res = await fetch(serverUrl('/upload/'), {
      method: 'POST',
      body: form,
    })
    t.assert(res.ok, '200 deployed site templates via /upload/ route')
  }
  catch (error) {
    t.fail(error, 'Error in deploying site templates via /upload/ route')
  }

  try {
    await firebase.signalBuild({ siteName: form.get('site') }, null)
    // if we are running with build workers running in the background
    // then perhaps they caught this build signal, otherwise we force
    // a removal here.
    t.ok(true, 'Deleted the orphaned site build command arguments')
  }
  catch (error) {
    t.fail(error, 'Could not remove the build signal command arguments')
  }
  
  t.end()
})

test.onFinish(() => {
  process.exit()
})