'use strict';

// Requires
var fs = require('fs');
const fsp = require('fs/promises');
var url = require( 'url' )
var assert = require( 'assert' )
const tar = require('tar')
var Firebase = require('./firebase/index.js');
var colors = require('colors');
var _ = require('lodash');
var async = require('async');
var mkdirp = require('mkdirp');
var cloudStorage = require('./cloudStorage.js');
var JobQueue = require('./jobQueue.js');
var touch = require('touch');
var Deploys = require( 'webhook-deploy-configuration' );
var miss = require( 'mississippi' );
var throughConcurrent = require( 'through2-concurrent' )
var path = require( 'path' )
var glob = require( 'glob' )
const { fork } = require('child_process')
var { setupBucket } = require('./creator.js');
var Fastly = require( './fastly/index.js' )
const {
  protocolForDomain,
  usingArguments,
  sink,
  uploadIfDifferent,
  cachePurge,
} = require('./utils.js');
const runInDir = require('./utils/run-in-dir.js')
const runBuildEmitter = require('./utils/run-build-emitter')
var firebaseEscape = require( './utils/firebase-escape.js' )
var firebaseUnescape = require( './utils/firebase-unescape.js' )

module.exports.configure = configure
function configure (config) {

  cloudStorage.configure(config.get('cloudStorage'))
  const firebase = Firebase(config.get('firebase'))
  const fastly = Fastly(config.get( 'fastly' ))

  const buildFolderRoot = config.get('builder').buildFolderRoot

  return async function buildSite ({ siteName, userId, bucket, branch }) {
    const siteManagementSnapshot = await firebase.siteManagement({ siteName })
    const siteManagement = siteManagementSnapshot.val()
    if (!siteManagement) return

    try {
      if(!(
        _(siteManagement.owners).has(firebaseEscape(userId)) ||
        _(siteManagement.users).has(firebaseEscape(userId)) ||
        userId === 'admin'
      )) return

      await firebase.siteMessageAdd({ siteName }, {
        message: `Build started for ${bucket}`,
        timestamp: Date.now(),
        status: 0,
        code: 'BUILDING',
      })

      // Create build-folders if it isnt there
      mkdirp.sync(buildFolderRoot)

      const buildFolderName =Deploys.utilities.nameForSiteBranch(siteName, bucket)
      const buildFolder = path.join(buildFolderRoot, buildFolderName)
      // site version is updated on server site deploy upload
      const buildFolderVersion = path.join(buildFolder, `.fb_version${siteManagement.version}`)

      if (fs.existsSync(buildFolder) && !fs.existsSync(buildFolderVersion)) {
        await runInDir('rm', ['-rf', buildFolderName], { cwd: buildFolderRoot })
      }
      if(!fs.existsSync(buildFolderVersion)) {
        // download-site-zip:start
        const branchFileName = Deploys.utilities.fileForSiteBranch(firebaseEscape(siteName), branch)
        const buildSiteZip = path.join(buildFolderRoot, branchFileName)
        if (fs.existsSync(buildSiteZip)) {
          fs.unlinkSync(buildSiteZip)
        }
        await cloudStorage.objects.get({
          bucket: config.get('sitesBucket'),
          remote: branchFileName,
          local: buildSiteZip,
        })
        // download-site-zip:end
        
        mkdirp.sync(buildFolder)

        await tar.x({ file: buildSiteZip, cwd: buildFolder })
        fs.unlinkSync(buildSiteZip)
        touch.sync(buildFolderVersion)
      }

      try {
        console.log('npm-install')
        await runInDir('npm', ['install'], { cwd: buildFolder })  
      }
      catch (error) {
        console.log(error)
        error.message = `Failed to build, errors in installation of site dependencies for ${bucket}`
        throw error
      }
      
      try {
        console.log('setup-bucket')
        await setupBucket({
          cloudStorage: config.get('cloudStorage'),
          cloudflare: config.get('cloudflare'),
          fastly: config.get('fastly'),
          siteBucket: bucket,
        })
      }
      catch (error) {
        console.log(error)
        error.message = `Failed to build site, error in setting up bucket ${bucket}`
        throw error
      }

      const maskDomain = await fastly.maskForContentDomain(bucket)
      const purgeProxy = maskDomain
        ? fastly.addressForDomain(maskDomain)
        : fastly.addressForDomain(bucket)

      // build : start
      console.log('grunt-clean')
      await runInDir('grunt', ['clean'], { cwd: buildFolder })
      const cacheData = path.join('.build', 'data.json')
      console.log('grunt-download-data')
      await runInDir('grunt', ['download-data', `--toFile=${cacheData}`], { cwd: buildFolder })
      console.log('grunt-build-order')
      await runInDir('grunt', ['build-order'], { cwd: buildFolder })
      const buildOrderFiles = ['ordered', 'default']
      // build : pages+templates : start
      let buildOrder = []
      for (const buildOrderFile of buildOrderFiles) {
        const file = path.join(buildFolder, '.build-order', buildOrderFile)
        let string = ''
        try {
          const buffer = await fsp.readFile(file)
          string = buffer.toString()
        }
        catch (error) {
          console.log('build-order:error:', file)
          console.log(error)
          // continue
        }
        const buildFiles = string.split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 0)
        buildOrder = _.union(buildOrder, buildFiles)
      }

      const builtFolder = path.join(buildFolder, '.build')

      console.log('build-and-upload')
      await buildAndUpload({
        buildOrder,
        buildFolder,
        builtFolder,
        bucket,
        maskDomain,
        purgeProxy,
        cacheData,
      })
      // build : end
      
      // TODO: run a build with a file, 
      // another without and see if its deleted
      await deleteRemoteFilesNotInBuild({
        bucketSpecs: [{
          contentDomain: bucket,
          maskDomain,
        }],
        builtFolder,
        purgeProxy,
      })

      await firebase.siteMessageAdd({ siteName }, {
        message: `Built and uploaded to ${bucket}`,
        timestamp: Date.now(),
        status: 0,
        code: 'BUILT',
      })

    }
    catch (error) {
      await firebase.siteMessageAdd({ siteName }, {
        message: error.message,
        timestamp: Date.now(),
        status: 1,
      })
      throw error
    }
  }

  function buildAndUpload ({
    buildOrder,
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

    const buildProcessOpts = buildOrder.map((buildFile) => {
      const subCmd = buildFile.startsWith('pages')
        ? 'build-page'
        : 'build-template'

      return [
        gruntBin,
        [
          subCmd,
          `--inFile=${buildFile}`,
          `--data=${cacheData}`,
          `--production=true`,
          '--settings={"site_url":"'+ protocolForDomain(maskDomain || bucket) +'"}',
        ],
        {
          cwd: buildFolder,
        }
      ]
    }).concat([[gruntBin, ['build-static', '--production=true'], { cwd: buildFolder }]])

    return new Promise((resolve, reject) => {
      const buildEventSource = miss.through.obj()

      miss.pipe(
        buildEventSource,
        runBuildEmitter({ builtFolder, bucketSpec }),  // pushes { builtFile, builtFilePath, bucket }
        buildSitemap({ builtFolder, bucketSpecs }), // pushes { builtFile, builtFilePath, bucket }
        buildRobotsTxt({ buildFolder, builtFolder, bucketSpecs }), // pushes { builtFile, builtFilePath, bucket }
        uploadIfDifferent({ maxParallel: 10, purgeProxy }),  // pushes { builtFile, builtFilePath, bucket }
        sink(),
        (error) => {
          if (error) return reject(error)
          resolve()
        }        
      )

      buildProcessOpts.forEach((cmd) => {
        buildEventSource.push(cmd)
      })

      buildEventSource.push(null)
    })
  }

  /**
   * Collects all { builtFile } values that pass through, and pushes
   * the same object that comes in.
   *
   * On end, a site map XML file is written and a { builtFile, builtFilePath }
   * object is pushed to present the new file.
   *
   * Site maps are written at {bucket}-sitemap.xml
   *
   * @param  {object} options
   * @param  {string[]} options.buckets[]
   * @param  {string} options.buckets[].contentDomain  The domains to write the urls for.
   * @param  {string} options.buckets[].maskDomain?    The domains to write the urls for if exists
   * @param  {string} options.builtFolder     The folder to write site maps to.
   * @return {[type]} [description]
   */
  function buildSitemap ( options ) {
    var urls = [];
    var buckets = options.bucketSpecs || [];
    var builtFolder = options.builtFolder;

    function includeInSiteMap( file ) {
      return file.endsWith( 'index.html' ) && ( !file.startsWith( '_wh_previews' ) ) && ( !file.startsWith( 'cms/index.html' ) )
    }

    function normalizeForSiteMap( file ) {
      if ( file === 'index.html' ) return '/'
      return file.replace( 'index.html', '' )
    }

    return miss.through.obj( collect, writeOnEnd )

    function collect ( args, enc, next ) {
      if ( includeInSiteMap( args.builtFile ) ) urls.push( normalizeForSiteMap( args.builtFile ) )
      next( null, args )
    }

    function writeOnEnd () {
      var stream = this;
      var siteMapTasks = buckets.map( createSiteMapTask )
      async.parallel( siteMapTasks, function ( error, siteMaps ) {
        if ( error ) return stream.emit( 'error', error );
        console.log( 'site-maps' )
        console.log( siteMaps )
        siteMaps.forEach( function ( siteMap ) { stream.push( siteMap ) } )
        stream.push( null )
      } )
    }

    function createSiteMapTask ( bucket ) {
      return function siteMapTask ( taskComplete ) {
        var siteMapDomain = bucket.maskDomain ? bucket.maskDomain : bucket.contentDomain;

        var siteMapFile = siteMapName( siteMapDomain );
        var siteMapPath = path.join( builtFolder, siteMapFile )
        var siteMapContent = siteMapFor( siteMapDomain, urls )
        fs.writeFile( siteMapPath, siteMapContent, function ( error ) {
          if ( error ) {
            console.log( 'site-map:error' )
            console.log( error )
            return taskComplete()
          }
          var uploadArgs = {
            builtFile: siteMapFile,
            builtFilePath: siteMapPath,
            bucket: bucket,
          }
          taskComplete( null, uploadArgs )
        } )
      }
    }

    function siteMapFor ( host, urls ) {
      var protocolHost = hostWithProtocol( host )
      var openingTag =
        [ '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' ].join( '\n' )
      var urlItems = urls.map( function ( urlLoc ) {
        return [
          '\t<url>',
            '\t\t<loc>' + url.resolve( protocolHost, urlLoc ) + '</loc>',
          '\t</url>\n',
        ].join( '\n' )
      } ).join( '' )
      var closingTag = '</urlset>\n'
      return [ openingTag, urlItems, closingTag ].join( '' )
    }
  }

  function siteMapName( host ) {
    return host.replace( /\./g, '-' ) + '-sitemap.xml';
  }

  function hostWithProtocol( host ) {
    var isSecure = fastly.isSecureDomain( host );
    var protocol = isSecure ? 'https' : 'http';
    return [ protocol, host ].join( '://' )
  }

  function buildRobotsTxt ( options ) {
    var buckets = options.bucketSepcs || [];
    var buildFolder = options.buildFolder;
    var builtFolder = options.builtFolder;
    var shouldBuild = false;
    var builtFile = 'robots.txt';

    return miss.through.obj( filterRobotsTxt, writeRobotsTxt )

    function filterRobotsTxt ( args, enc, next ) {
      if ( args.builtFile.endsWith( builtFile ) ) {
        shouldBuild = true;
        return next()
      }
      next( null, args )
    }

    function writeRobotsTxt () {
      var stream = this;
      if ( shouldBuild === false ) return stream.push( null )
      miss.pipe(
        feedBuckets(),
        buildAndRead(),
        sink( function ( args ) {
          stream.push( args )
        } ),
        function onComplete ( error ) {
          if ( error ) return stream.emit( 'error', error )
          stream.push( null )
        } )
    }

    function feedBuckets () {
      return miss.from.obj( buckets.map( function ( bucket ) { return { bucket: bucket } } ).concat( [ null ] ) )
    }

    function buildAndRead () {
      return miss.through.obj( function ( args, enc, next ) {
        var robotsDataContent = buildDataForBucket( args.bucket )
        var robotsDataPath = path.join( builtFolder, 'robots-data.json' )

        var buildParams = [
          'build-page',
          '--inFile=pages/robots.txt',
          '--production=true',
          '--data=.build/robots-data.json',
          '--emitter=true'
        ]

        var builtRobotsPath = path.join( builtFolder, builtFile )


        fs.writeFile( robotsDataPath, robotsDataContent, function ( error ) {
          if ( error ) return next( error )

          runInDir( 'grunt', buildFolder, buildParams, function ( error ) {
            if ( error ) return next( error )

            fs.readFile( builtRobotsPath, function ( error, contents ) {
              if ( error ) return next( error )

              var uploadArgs = {
                builtFile: builtFile,
                builtFilePath: contents.toString(),
                bucket: args.bucket,
                overrideMimeType: 'text/plain',
              }

              next( null, uploadArgs )
            } )
          } )
        } )
      } )
    }

    function buildDataForBucket ( bucket ) {
      var siteMapDomain = bucket.maskDomain ? bucket.maskDomain : bucket.contentDomain
      var buildData = {
        contentType: {},
        data: {},
        settings: {
          general: {
            site_url: siteMapDomain,
            site_map: url.resolve( hostWithProtocol( siteMapDomain ), siteMapName( siteMapDomain ) )
          }
        }
      }
      return JSON.stringify( buildData )
    }
  }

  /**
   * deleteRemoteFilesNotInBuild is a transform stream. First it reads all
   * objects from the bucket. Then compares them to local files.
   *
   * If it exists as a local file, it nothing is done.
   * If it does not exist as a local file, it is deleted.
   *
   * Local file comparisons include:
   * - Same name
   * - Same name - '/index.html'
   *
   * @param  {object} options
   * @param  {number} options.maxParallel?  Max number of build workers to spawn.
   * @return {object} stream  Transform stream that will handle the work.
   */
  function deleteRemoteFilesNotInBuild ({
    bucketSpecs,
    builtFolder,
    maxParallel=1,
    purgeProxy,
  }) {
    return new Promise((resolve, reject) => {

      console.log( 'delete-remote-files-not-in-build:start' )

      miss.pipe(
        usingArguments( { builtFolder } ),
        feedCloudFiles( { buckets: bucketSpecs } ),            // adds { bucket, builtFile }
        feedNotLocalFiles( { maxParallel: maxParallel } ), // pushes previous if conditions are met
        deleteFromBucket( { maxParallel: maxParallel } ),  // adds { remoteDeleted }
        cachePurge( { purgeProxy } ),
        sink(),
        function onComplete ( error ) {
          console.log( 'delete-remote-files-not-in-build:end' )
          if ( error ) return reject( error )
          resolve()
        } )
    } )

    // list and feed all files in the buckets
    function feedCloudFiles ( options ) {
      var buckets = options.buckets;
      return miss.through.obj( function ( args, enc, next ) {
        var stream = this;

        var listTasks = buckets.map( pushListTask )

        async.parallel( listTasks, function onDone () { next() } )

        function pushListTask ( bucket ) {
          return function ( taskComplete ) {

            pushList()

            function pushList ( pageToken ) {
              var listOpts = {}
              if ( pageToken ) listOpts.pageToken = pageToken;
              cloudStorage.objects.list({
                bucket: bucket.contentDomain,
                options: listOpts,
              }, function ( error, listResult ) {
                if ( error ) return taskComplete( error )
                if ( !listResult.items ) return taskComplete( error )

                listResult.items.filter( nonStatic ).forEach( function ( remoteFile ) {
                  stream.push( Object.assign( {}, args, {
                    builtFile: remoteFile.name,
                    bucket: bucket,
                  } ) )
                } )

                if ( listResult.nextPageToken ) return pushList( listResult.nextPageToken )

                taskComplete()
              } )
            }
          }
        }
      } )

      function nonStatic ( remoteFile ) {
        return ( ! remoteFile.name.startsWith( 'static/' ) )
      }
    }

    // compare remote files to local files. if the local file does not exist, push it for deletion.
    function feedNotLocalFiles ( options ) {
      if ( !options ) options = {};
      var maxParallel = options.maxParallel || 1;

      return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {
        var localFile = localForRemote( args.builtFile )
        var localFilePath = path.join( args.builtFolder, localFile )
        fs.open( localFilePath, 'r', function ( error, fd ) {
          // file does not exist, lets see if it exists as named html file
          // rather than a named directory with an index.html
          if ( error ) {
            return fs.open( localNonIndex( localFilePath ), 'r', function ( error, fd ) {
              // file does not exist, lets push its args and delete it
              if ( error ) return next( null, args )

              // file exists locally, lets keep it in the bucket
              fs.close( fd, function () { next() } )
            } )

          }

          // file exists locally, lets keep it in the bucket
          fs.close( fd, function () { next() } )
        } )
      } )

      function localForRemote ( file ) {
        // if no extension, this is a redirect template. lets see if we
        // have the base file that it is redirecting to.
        if ( path.extname( file ) === '' ) return file + '/index.html';
        return file;
      }

      function localNonIndex ( file ) {
        return file.slice( 0, ( -1 * '/index.html'.length ) ) + '.html';
      }
    }

    // deletes the { bucket, builtFile }
    function deleteFromBucket ( options ) {
      if ( !options ) options = {};
      var maxParallel = options.maxParallel || 1;

      return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {
        console.log( 'deleting:' + [args.bucket.contentDomain, args.builtFile].join('/') )
        cloudStorage.objects.del({
          bucket: args.bucket.contentDomain,
          file: args.builtFile,
        }, function ( error ) {
          args.remoteDeleted = true;
          next( null, args );
        } )
      } )
    }
  }
}

/**
 * The main build worker. The way this works is that it first checks to
 * see if it has a local up-to-date copy of the site, if it doesn't then it
 * downloads them from the cloud storage archive. After downloading it simply
 * runs `grunt build` in the sites directory, then uploads the result to cloud storage.
 *
 * @param  {Object}   config     Configuration options from Grunt
 * @param  {Object}   logger     Object to use for logging, deprecated, not used
 */
module.exports.start = function (config) {
  const job = configure(config)

  var jobQueue = JobQueue.init(config);

  const wrapJob = ({ siteName, userId, bucket, branch }, callback) => {
    job({ siteName, userId, bucket, branch })
      .then(() => {
        console.log('builder:job:complete')
        callback()
      })
      .catch((error) => {
        console.log('builder:job:error')
        console.log(error)
        callback(error)
      })

  console.log('Waiting for commands'.red);

  jobQueue.reserveJob('build', 'build', wrapJob)
}
