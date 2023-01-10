'use strict';
/*
* This Gruntfile handles all the launching/running of the workers and servers that
* webhook needs to run. It also includes all the configuration options for webhook,
* which are detailed below.
*
* The gruntfile contains the following tasks:
*    commandDelegator - The command delegator, which queues commands from firebase into beanstalk
*    buildWorker      - The worker responsible for building sites
*    siteIndexWorker  - The worker responsible for updating a sites search index
*    inviteWorker     - The worker responsible for handling invite emails
*    createWorker     - The worker responsible for handling creating sites
*    startServer      - The main webhook server, handles file uploads and searches
*    backupCron       - The cron job that runs backups of the firebase data
*    extractKey       - A utility to extract the SSH key for a google service acccount
*/

require('dotenv').config({ silent: true });

var builder = require('./libs/builder.js');
var siteIndexer = require('./libs/siteIndex.js');
var redirects = require('./libs/redirects.js');
var inviter = require('./libs/invite.js');
var creator = require('./libs/creator.js');
var server = require('./libs/server.js');
var delegator = require('./libs/commandDelegator.js');
var backup = require('./libs/backup.js');
var extractKey = require('./libs/extractKey.js');
var previewBuilder = require('./libs/preview-builder.js');
var domainMapper = require('./libs/domain-mapper.js');
const path = require('path')

module.exports = function(grunt) {
  // Project configuration.
  grunt.initConfig({
    firebase: {
      name: process.env.FIREBASE,                                           // The name of your firebase
      serviceAccountKey: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,          // Your firebase's service account key
    },
    mailgun: {
      apiKey: process.env.MAILGUN_SECRET_KEY,
      domain: process.env.MAILGUN_DOMAIN,
      fromEmail: process.env.FROM_EMAIL,
    },
    elastic: {
      host: process.env.ELASTIC_SEARCH_SERVER,
      port: 9200,
      auth: {
        username: process.env.ELASTIC_SEARCH_USER,
        password: process.env.ELASTIC_SEARCH_PASSWORD,
      },
    },
    googleProjectId: process.env.GOOGLE_PROJECT_ID,                         // Your google project ID. Usually something like whatever-123
    sitesBucket: process.env.SITES_BUCKET,                                  // The name of the build bucket on Google Cloud Storage
    backupBucket: process.env.BACKUPS_BUCKET,                               // The name of the backup bucket on Google Cloud Storage
    uploadsBucket: process.env.UPLOADS_BUCKET,                              // The name of the bucket to push all file uploads to
    googleServiceAccount: process.env.GOOGLE_SERVICE_ACCOUNT,               // The email of your projects Service Acccount
    cloudStorage: {
      keyFilename: process.env.GOOGLE_KEY_JSON,
      defaultCors: parseJson(process.env.GOOGLE_BUCKET_DEFAULT_CORS),
    },
    googleCloudServiceAccountKeyJson: process.env.GOOGLE_KEY_JSON,
    memcachedServers: [
      'localhost:11211'
    ],
    beanstalkServer: 'localhost:11300',
    cloudflare: {
      client: {
        email: process.env.CLOUDFLARE_EMAIL,
        key: process.env.CLOUDFLARE_KEY,
      },
      domains: parseJson( process.env.CLOUDFLARE_DOMAINS, [] ),
    },
    builder: {
      forceWrite: process.env.BUILDER_FORCE_WRITE || false,
      maxParallel: concurrencyOption( process.env.BUILDER_MAX_PARALLEL ),
      buildFolderRoot: process.env.BUILD_FOLDER || path.join(process.cwd(), '..', 'build-folders')
    },
    fastly: {
      token: process.env.FASTLY_TOKEN,
      service_id: process.env.FASTLY_SERVICE_ID,
      domains: parseJson( process.env.FASTLY_DOMAINS, [] ),
    },
    developmentDomain: process.env.DEVELOPMENT_DOMAIN.split( ',' ),
  });

  grunt.registerTask('commandDelegator', 'Worker that handles creating new sites', function() {
    var done = this.async();
    var d = delegator.start(grunt.config, grunt.log);
    d.on('ready', console.log)
  });

  grunt.registerTask('buildWorker', 'Worker that handles building sites', function() {
    var done = this.async();
    builder.start(grunt.config, grunt.log);
  });

  grunt.registerTask('previewBuildWorker', 'Worker that builds an individual template for the given contentType & itemKey.', function () {
    var done = this.async();
    previewBuilder.start( grunt.config, grunt.log );
  });

  grunt.registerTask('domainMapper', 'Worker that updates domain mappings within fastly.', function () {
    var done = this.async();
    domainMapper.start( grunt.config, grunt.log );
  } )

  grunt.registerTask('siteIndexWorker', 'Worker that handles synchronizing a site Firebase data with its Elastic Search index.', function() {
    var done = this.async();
    siteIndexer.start(grunt.config, grunt.log);
  });

  grunt.registerTask('redirectsWorker', 'Worker that handles synchronizing a site Firebase redirect settings with its Fastly service.', function() {
    var done = this.async();
    redirects.start(grunt.config, grunt.log);
  });

  grunt.registerTask('inviteWorker', 'Worker that handles inviting team members', function() {
    var done = this.async();
    inviter.start(grunt.config, grunt.log);
  });

  grunt.registerTask('createWorker', 'Worker that handles creating new sites', function() {
    var done = this.async();
    creator.start(grunt.config, grunt.log);
  });

  grunt.registerTask('startServer', 'Starts node server', function() {
    var done = this.async();
    server.start(grunt.config);
  });

  grunt.registerTask('backupCron', 'Job to run for backup cron', async function() {
    let exitCode
    try {
      await backup.start(grunt.config)
      exitCode = 0
    }
    catch (error) {
      console.log(error)
      exitCode = 1
    }
    finally {
      process.exit(exitCode)
    }
  });

  grunt.registerTask('extractKey', 'Extract RSA key from JSON file', function() {
    var done = this.async();
    var file = grunt.option('file');
    extractKey.start(file, grunt.config, grunt.log);
  });

  grunt.registerTask('timeoutWorker', 'Timeout in order to test proper queue management.', function () {
    var done = this.async();
    timeoutWorker.start(grunt.config, grunt.log);
  })

  grunt.registerTask('flushBuildQueue', 'Stop build workers, flush build queue, and restart build workers.', function () {
    var done = this.async()
    var flusher = require('./libs/flush-queue.js')
    flusher.start(grunt.config, grunt.log, done)
  })

  grunt.registerTask('echoConfig', 'Logs out the current config object.', function () {
    console.log( grunt.config() )
  });

};

// concurrency option value defaults to half the available cpus
function concurrencyOption ( concurrencyOptionValue ) {
  if ( typeof concurrencyOptionValue === 'number' ) return Math.floor( concurrencyOptionValue )
  if ( concurrencyOptionValue === 'max' ) return require('os').cpus().length;
  return require('os').cpus().length / 2;
}

function parseJson ( value, defaultValue ) {
  try {
    return JSON.parse( value )
  } catch ( error ) {
    return defaultValue
  }
}
