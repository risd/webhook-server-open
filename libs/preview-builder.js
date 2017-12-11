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
var utils = require( './utils.js' )
var path = require( 'path' )
var fs = require( 'fs' )

// Util streams
var usingArguments = utils.usingArguments;
var sink = utils.sink;
var uploadIfDifferent = utils.uploadIfDifferent;
var redirectTemplateForDestination = utils.redirectTemplateForDestination;
var protocolForDomain = utils.protocolForDomain;

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

module.exports.start = function ( config, logger ) {
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);

  var self = this;

  var buildFolderRoot = path.join( '..', '/build-folders' )

  console.log('Waiting for commands'.red);

  // Wait for a build job, extract info from payload
  jobQueue.reserveJob('previewBuild', 'previewBuild', previewBuildJob);

  return previewBuildJob;

  function previewBuildJob ( payload, identifier, data, client, jobCallback ) {
    console.log( 'triggered:preview-build-job' )

    var userid = data.userid;
    var site = data.sitename;
    var siteBucket = data.siteBucket;
    var contentType = data.contentType;
    var itemKey = data.itemKey;

    /*
    Outline of the process & args at each stage of the stream
    
    Using args
    { site: '', contentType: '', itemKey, siteBucket  }
    Run Build Emitter ( streamtoCommandArgs )
    { builtFile, builtFilePath, bucket }
    Upload if different(  )

    */
   
    var buildFolderName = Deploys.utilities.nameForSiteBranch( site, siteBucket )
    var buildFolder = path.join( buildFolderRoot, buildFolderName )

    var previewBuildArgs = {
      siteName: site,
      siteBucket: siteBucket,
      contentType: contentType,
      itemKey: itemKey,
      buildFolder: buildFolder,
    }

    var runBuildEmitterOptions = {
      maxParallel: 2,
    }

    return miss.pipe(
      usingArguments( previewBuildArgs ),
      oneOffTransform(),
      runBuildEmitter( runBuildEmitterOptions ),
      uploadIfDifferent(),
      sink(),
      function onComplete ( error ) {
        if ( error ) return jobCallback( error )
        jobCallback()
      } )

    function oneOffTransform () {
      return miss.through.obj( function ( row, enc, next ) {
        miss.pipe(
          usingArguments( row ),
          oneOffPath(),   // adds { oneOffPath? } custom URL if one exists
          sink( function ( subrow ) {
            row = Object.assign( {}, subrow ) 
          } ),
          function ( error ) {
            if ( error ) return next( error )
            next( null, row )
          } )
      } )

      function oneOffPath () {
        return miss.through.obj( function ( row, enc, next ) {
          if ( row.contentType !== row.itemKey ) return next( null, row )
          try {
            fs.readFile( path.join( row.buildFolder, '.build', 'data.json' ), function ( error, dataBuffer ) {
              if ( error ) return next( error )
              var data = JSON.parse( dataBuffer.toString() )
              
              if ( isOneOff() && customUrl() ) {
                return next( null, Object.assign( { oneOffPath: customUrl() }, row ) )
              } else {
                return next( null, Object.assign( { oneOffPath: false }, row ) )
              }

              function isOneOff () { return data.typeInfo[ row.contentType ].oneOff; }
              function customUrl () {
                try {
                  return data.typeInfo[ row.contentType ].customUrls.listUrl  
                } catch ( error ) {
                  return false;
                }
              }

            } )  
          } catch( error ) {
            next( error )
          }
        } )
      }
    }

    function runBuildEmitter ( options ) {
      var maxParallel = options.maxParallel;

      // multiple - grunt build-template --inFile=templates/{content-type}/individual.html --itemKey={itemKey}
      // one off  - grunt build-page --inFile=pages/{one-off-path}
      
      return throughConcurrent.obj( { maxConcurrency: maxParallel }, function ( args, enc, next ) {

        var stream = this;

        console.log( 'run-build-emitter:start' )

        var cmdArgs = streamToCommandArgs( args )

        var builtFolder = path.join( cmdArgs[2].cwd, '.build' )

        var errored = false;
        var builder = winSpawn.apply( null, cmdArgs )

        builder.stdout.on( 'data', function readOutput ( buf ) {
          var strs = buf.toString().split( '\n' )

          var buildEvent = 'build:document-written:./.build/';

          strs.filter( function filterWriteEvent ( str ) { return str.indexOf( buildEvent ) === 0 } )
            .forEach( function ( str ) {
              var builtFile = str.trim().slice( buildEvent.length )
              var builtFilePath = path.join( builtFolder, builtFile )
              console.log( 'build-event:' + builtFile )
              stream.push( { builtFile: builtFile, builtFilePath: builtFilePath, bucket: args.siteBucket } )
            } )

          var endEvent = ':end:';

          strs.filter( function filterEndEvent ( str ) { return str.indexOf( endEvent ) !== -1 } )
            .forEach( function ( str ) {
              builder.kill()
            } )

        } )

        builder.on( 'error', function ( error ) {
          console.log( 'builder-error' )
          console.log( error )
          errored = true;
          next()
        } )

        builder.on( 'exit', function () {
          if ( errored === true ) return;
          console.log( 'run-build-emitter:end' )
          next()
        } )        

      } )

      function streamToCommandArgs ( streamArgs ) {

        var cmdArgs = streamArgs.oneOffPath
          ? [ 'build-page', '--inFile=' + path.join( 'pages', streamArgs.oneOffPath ) ]
          : [ 'build-template', '--inFile=' + path.join( 'templates', streamArgs.contentType, 'individual.html' ), '--itemKey=' + streamArgs.itemKey, ]

        var commonArgs = [
          '--settings={"site_url":"'+ protocolForDomain( streamArgs.siteBucket ) +'"}',
          '--data=.build/data.json',
          '--production=true',
          '--emitter'
        ]

        cmdArgs = cmdArgs.concat( commonArgs )

        return [ 'grunt', cmdArgs, { stdio: 'pipe', cwd: streamArgs.buildFolder, } ]
      }

    }

  }
}
