// preview template build
// accepts contentType & itemKey
// pushes these through a build process that anticipates
// the repo to exist, 

var winSpawn = require( 'win-spawn' )
var cloudStorage = require( './cloudStorage.js' )
var crypto = require( 'crypto' )
var JobQueue = require( './jobQueue.js' )
var miss = require( 'mississippi' )
var throughConcurrent = require( 'through2-concurrent' )
var Deploys = require( 'webhook-deploy-configuration' )
var Firebase = require('./firebase/index.js');
var utils = require( './utils.js' )
var path = require( 'path' )
var fs = require( 'fs' )
const fsp = require('fs/promises')

// Util streams
const runBuildEmitter = require('./utils/run-build-emitter')
var usingArguments = utils.usingArguments;
var sink = utils.sink;
var uploadIfDifferent = utils.uploadIfDifferent;
var redirectTemplateForDestination = utils.redirectTemplateForDestination;
var protocolForDomain = utils.protocolForDomain;
var addMaskDomain = utils.addMaskDomain;
var addPurgeProxy = utils.addPurgeProxy;

module.exports.configure = configure
function configure (config) {
  cloudStorage.configure(config.get('cloudStorage'))
  const firebase = Firebase({
    initializationName: 'preview-builder',
    ...config.get('firebase'),
  })
  const buildFolderRoot = config.get('builder').buildFolderRoot

  return async function previewBuilder ({
    userId,
    siteName,
    bucket,
    contentType,
    itemKey,
  }) {

    const buildFolderName = Deploys.utilities.nameForSiteBranch(siteName, bucket)
    const buildFolder = path.join(buildFolderRoot, buildFolderName)
    const builtFolder = path.join(buildFolder, '.build')
    const cacheData = path.join(buildFolder, 'data.json')

    try {

      const siteData = JSON.parse((await fsp.readFile(cacheData)).toString())
      let oneOffPath = false
      if (siteData.typeInfo[contentType]?.oneOff && siteData.typeInfo[contentType]?.customUrls?.listUrl) {
        oneOffPath = siteData.typeInfo[contentType]?.customUrls?.listUrl
      }
      const maskDomain = await fastly.maskForContentDomain(bucket)
      const purgeProxy = maskDomain
        ? fastly.addressForDomain(maskDomain)
        : fastly.addressForDomain(bucket)

      await buildAndUpload({
        contentType,
        itemKey,
        oneOffPath,
        buildFolder,
        builtFolder
        bucket,
        maskDomain,
        purgeProxy,
        cacheData,
      })
      await firebase.siteMessageAdd({ siteName }, {
        `Priority build complete for ${ contentType } on ${ bucket }`,
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
    bucket,
    maskDomain,
    purgeProxy,
    cacheData,
  }) {
    const bucketSpec = {
      contentDomain: bucket,
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
        '--settings={"site_url":"'+ protocolForDomain(maskDomain || bucket) +'"}',
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

module.exports.start = function ( config, logger ) {
  
  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);
  console.log('Waiting for commands'.red);

  // Wait for a build job, extract info from payload
  jobQueue.reserveJob('previewBuild', 'previewBuild', previewBuildJob)
}
