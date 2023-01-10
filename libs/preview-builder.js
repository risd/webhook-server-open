// preview template build
// accepts contentType & itemKey
// pushes these through a build process that anticipates
// the repo to exist, 

var cloudStorage = require( './cloudStorage.js' )
var JobQueue = require( './jobQueue.js' )
var miss = require( 'mississippi' )
var Deploys = require( 'webhook-deploy-configuration' )
var Firebase = require('./firebase/index.js');
var {
  usingArguments,
  sink,
  uploadIfDifferent,
  protocolForDomain,
} = require( './utils.js' )
const runBuildEmitter = require('./utils/run-build-emitter')
var path = require( 'path' )
var fs = require( 'fs' )
const fsp = require('fs/promises')
const Fastly = require( './fastly/index.js' )


module.exports.configure = configure
function configure (config) {
  cloudStorage.configure(config.get('cloudStorage'))
  const firebase = Firebase({
    initializationName: 'preview-builder',
    ...config.get('firebase'),
  })
  const fastly = Fastly(config.get( 'fastly' ))
  const buildFolderRoot = config.get('builder').buildFolderRoot

  return async function previewBuilder ({
    userId,
    siteName,
    siteBucket,
    contentType,
    itemKey,
  }) {

    const buildFolderName = Deploys.utilities.nameForSiteBranch(siteName, siteBucket)
    const buildFolder = path.join(buildFolderRoot, buildFolderName)
    const builtFolder = path.join(buildFolder, '.build')
    const cacheData = path.join(builtFolder, 'data.json')

    try {

      const siteData = JSON.parse((await fsp.readFile(cacheData)).toString())
      let oneOffPath = false
      if (siteData.typeInfo[contentType]?.oneOff && siteData.typeInfo[contentType]?.customUrls?.listUrl) {
        oneOffPath = siteData.typeInfo[contentType]?.customUrls?.listUrl
      }
      const maskDomain = await fastly.maskForContentDomain(siteBucket)
      const purgeProxy = maskDomain
        ? fastly.addressForDomain(maskDomain)
        : fastly.addressForDomain(siteBucket)

      await buildAndUpload({
        contentType,
        itemKey,
        oneOffPath,
        buildFolder,
        builtFolder,
        siteBucket,
        maskDomain,
        purgeProxy,
        cacheData,
      })
      await firebase.siteMessageAdd({ siteName }, {
        message: `Priority build complete for ${ contentType } on ${ siteBucket }`,
        timestamp: Date.now(),
        status: 0,
        code: 'PRIORITY',
      })
    }
    catch (error) {
      console.log(error)
    }
  }

  function buildAndUpload ({
    contentType,
    itemKey,
    oneOffPath,
    buildFolder,
    builtFolder,
    siteBucket,
    maskDomain,
    purgeProxy,
    cacheData,
  }) {
    const bucketSpec = {
      contentDomain: siteBucket,
      maskDomain,
    }
    const bucketSpecs = [bucketSpec]

    const gruntBin = path.join(buildFolder, 'node_modules', '.bin', 'grunt')

    const subCmd = typeof oneOffPath === 'string'
      ? oneOffPath.startsWith('pages')
        ? ['build-page', `--inFile=${oneOffPath}`]
        : ['build-template', `--inFile=${oneOffPath}`]
      : ['build-template', `--inFile=${path.join('templates', contentType, 'individual.html')}`, `--itemKey=${itemKey}`]
    
    const buildProcessOpts = [
      gruntBin,
      subCmd.concat([
        `--production=true`,
        '--settings={"site_url":"'+ protocolForDomain(maskDomain || siteBucket) +'"}',
      ]),
      { cwd: buildFolder }
    ]

    return new Promise((resolve, reject) => {
      const buildEventSource = miss.through.obj()

      miss.pipe(
        buildEventSource,
        runBuildEmitter({ builtFolder, bucketSpec }),  // pushes { builtFile, builtFilePath, bucket }
        uploadIfDifferent({ maxParallel: 10, purgeProxy }),  // pushes { builtFile, builtFilePath, bucket }
        sink(),
        (error) => {
          if (error) return reject(error)
          resolve()
        }        
      )

      buildEventSource.push(buildProcessOpts)
      buildEventSource.push(null)
    })
  }
}

/**
 * JobQueue wrapper used by the command delegator
 */
module.exports.start = function ( config, logger ) {
  const job = configure(config)

  const wrapJob = (payload, callback) => {
    job(payload)
      .then(() => {
        console.log('preview-builder:job:complete')
        callback()
      })
      .catch((error) => {
        console.log('preview-builder:job:error')
        console.log(error)
        callback(error)
      })
  }
  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);
  console.log('Waiting for commands'.red);

  // Wait for a build job, extract info from payload
  jobQueue.reserveJob('previewBuild', 'previewBuild', wrapJob)
}
