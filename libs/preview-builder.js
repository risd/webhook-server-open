// preview template build
// accepts contentType & itemKey
// pushes these through a build process that anticipates
// the repo to exist, 

var winSpawn = require( 'win-spawn' )
var cloudStorage = require( './cloudStorage.js' )
var crypto = require( 'crypto' )
var JobQueue = require( './jobQueue.js' )
var miss = require( 'mississippi' )
var Deploys = require( 'webhook-deploy-configuration' )
var utils = require( './utils.js' )
var path = require( 'path' )

// Util streams
var usingArguments = utils.usingArguments;
var sink = utils.sink;
var uploadIfDifferent = utils.uploadIfDifferent;
var redirectTemplateForDestination = utils.redirectTemplateForDestination;

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
    var deploys = data.deploys;
    var contentType = data.contentType;
    var itemKey = data.itemKey;

    /*
    
    Using args
    { site: '', deploys: [], contentType: '', itemKey }
    Feed Builds
    { buildFolder, contentType, itemKey, branch  }
    Run Build Emitter ( streamtoCommandArgs )
    { builtFile, builtFilePath, branch }
    Feed Buckets For Branch
    { builtFile, builtFilePath, bucket }
    Upload if different(  )

    */
    
    var previewBuildArgs = {
      siteName: site,
      deploys: deploys,
      contentType: contentType,
      itemKey: itemKey,
      buildFolderRoot: buildFolderRoot,
    }

    var buildOptions = {
      branches: deploys.map( function ( deploy ) { return deploy.branch } )
    }

    var runBuildEmitterOptions = {
      maxParallel: 2,
    }

    var feedBucketOptions = {
      bucketsForBranch: function ( branch ) {
        return deploys
          .filter( function ( deploy ) { return deploy.branch === branch } )
          .map( function ( deploy ) { return deploy.bucket } )
      }
    }

    return miss.pipe(
      usingArguments( previewBuildArgs ),
      feedBranchBuilds( buildOptions ),
      runBuildEmitter( runBuildEmitterOptions ),
      feedBuckets( feedBucketOptions ),
      uploadIfDifferent(),
      sink(),
      function onComplete ( error ) {
        if ( error ) return jobCallback( error )
        jobCallback()
      } )

    function feedBranchBuilds ( options ) {
      var branches = options.branches;
      
      return miss.through.obj( function ( args, enc, next ) {
        var stream = this;

        console.log( 'feed-branch-builds:start' )

        branches.forEach( function ( branch ) {

          var branchFileName = Deploys.utilities.fileForSiteBranch( args.siteName, branch )
          var branchFileFolder = branchFileName.slice( 0, ( branchFileName.length - '.zip'.length ) )
          var buildEmitterArgs = {
            buildFolder: path.join( args.buildFolderRoot, branchFileFolder ),
            contentType: args.contentType,
            itemKey: args.itemKey,
            branch: branch,
          }

          stream.push( buildEmitterArgs )

        } )

        console.log( 'feed-branch-builds:end' )

        next()

      } )
    }

    function runBuildEmitter ( options ) {
      var maxParallel = options.maxParallel;

      // grunt build-template --inFile=templates/{content-type}/individual.html --itemKey={itemKey}
      
      return miss.parallel( maxParallel, function ( args, next ) {

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
              stream.push( { builtFile: builtFile, builtFilePath: builtFilePath, branch: args.branch } )
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
          [ 'build-template', '--inFile=' + individualTemplate, '--itemKey=' + streamArgs.itemKey, '--emitter' ],
          {
            stdio: 'pipe',
            cwd: streamArgs.buildFolder
          }
        ]
      }

    }

    function feedBuckets ( options ) {
      var bucketsForBranch = options.bucketsForBranch;
      return miss.through.obj( function ( args, enc, next ) {
        
        console.log( 'feed-buckets:start' )

        var buckets = bucketsForBranch( args.branch )

        var stream = this;

        buckets.forEach( function ( bucket ) {
          
          var uploadArgs = {
            bucket: bucket,
            builtFile: args.builtFile,
            builtFilePath: args.builtFilePath,
          }

          stream.push( uploadArgs )

        } )

        console.log( 'feed-buckets:end' )

        next()

      } )
    }

  }
}
