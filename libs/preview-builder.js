// preview template build
// accepts contentType & itemKey
// pushes these through a build process that anticipates
// the repo to exist, 

var winSpawn = require( 'win-spawn' )
var cloudStorage = require( './cloudStorage.js' )
var crypto = require( 'crypto' )
var JobQueue = require( './jobQueue.js' )
var miss = require( 'mississippi' )
var utils = require('./utils.js');

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

  var buildFolderRoot = '../build-folders';

  console.log('Waiting for commands'.red);

  // Wait for a build job, extract info from payload
  jobQueue.reserveJob('previewBuild', 'previewBuild', previewBuildJob);

  return previewBuildJob;

  function previewBuildJob ( payload, identifier, data, client, jobCallback ) {
    var userid = data.userid;
    var site = data.sitename;
    var deploys = data.deploys;

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
      feedBuilds( buildOptions ),
      runBuildEmitter( runBuildEmitterOptions ),
      feedBuckets( feedBucketOptions ),
      uploadIfDifferent(),
      sink(),
      function onComplete ( error ) {
        if ( error ) return jobCallback( error )
        jobCallback()
      } )

    function feedBuilds ( options ) {}
    function runBuildEmitter ( options ) {}
    function feedBuckets ( options ) {}

  }
}
