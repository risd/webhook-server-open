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
      runBuildEmitter( runBuildEmitterOptions ),
      uploadIfDifferent(),
      sink(),
      function onComplete ( error ) {
        if ( error ) return jobCallback( error )
        jobCallback()
      } )

    function runBuildEmitter ( options ) {
      var maxParallel = options.maxParallel;

      // grunt build-template --inFile=templates/{content-type}/individual.html --itemKey={itemKey}
      
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
        var individualTemplate = path.join( 'templates', streamArgs.contentType, 'individual.html' )
        return [ 'grunt',
          [ 'build-template', '--inFile=' + individualTemplate, '--itemKey=' + streamArgs.itemKey, '--settings={"site_url":"'+ protocolForDomain( streamArgs.siteBucket ) +'"}', '--data=.build/data.json', '--production=true', '--emitter' ],
          {
            stdio: 'pipe',
            cwd: streamArgs.buildFolder
          }
        ]
      }

    }

  }
}
