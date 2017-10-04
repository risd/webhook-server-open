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
var timeoutWorker = require('./libs/timeout-worker.js');

require('dotenv').config({ silent: true });

module.exports = function(grunt) {
  // Project configuration.
  grunt.initConfig({
    firebase: process.env.FIREBASE,                                             // The name of your firebase
    firebaseSecret: process.env.FIREBASE_KEY,                                    // Your firebase's API key
    mailgunKey: process.env.MAILGUN_SECRET_KEY,                                           // The API key from mailgun
    mailgunDomain: process.env.MAILGUN_DOMAIN,                                           // The domain that uses mailgun
    fromEmail: process.env.FROM_EMAIL,                               // Mailgun will send ALL emails for ALL sites from this email address.
    elasticServer: process.env.ELASTIC_SEARCH_SERVER,                               // The address of your elastic server
    elasticUser: process.env.ELASTIC_SEARCH_USER,                                       // The read/write user on your elastic server
    elasticPassword: process.env.ELASTIC_SEARCH_PASSWORD,                           // The password for your elastic user
    //elasticOptions: {                                                 // This block is completely optional but useful if you need to specify
    //  port: 9200,                                                     // more elasticsearch options. Possible keys are :
    //  secure: false,                                                  // port, secure, defaultMethod, params, path, timeout, keepAlive and agent
    //  defaultMethod: 'GET'                                            // Uncomment this block and fill in your required values if needed
    //},
    googleProjectId: process.env.GOOGLE_PROJECT_ID,                                 // Your google project ID. Usually something like whatever-123
    sitesBucket: process.env.SITES_BUCKET,                             // The name of the build bucket on Google Cloud Storage
    backupBucket: process.env.BACKUPS_BUCKET,                          // The name of the backup bucket on Google Cloud Storage
    uploadsBucket: process.env.UPLOADS_BUCKET,                         // The name of the bucket to push all file uploads to
    googleServiceAccount: process.env.GOOGLE_SERVICE_ACCOUNT,  // The email of your projects Service Acccount
    newrelicEnabled: false,                                             // Set to true to enable NewRelic monitoring (also make sure that a newrelic.js file exists)
    memcachedServers: [
      'localhost:11211'
    ],
    beanstalkServer: 'localhost:11300',
    cloudflare: {
      client: {
        email: process.env.CLOUDFLARE_EMAIL,
        key: process.env.CLOUDFLARE_KEY,
      },
    },
    builder: {
      forceWrite: process.env.BUILDER_FORCE_WRITE || false,
      maxParallel: concurrencyOption( process.env.BUILDER_MAX_PARALLEL ),
    },
    fastly: {
      token: process.env.FASTLY_TOKEN,
      ip: process.env.FASTLY_IP,
      service_id: process.env.FASTLY_SERVICE_ID,
    }
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
    server.start(grunt.config, grunt.log);
  });

  grunt.registerTask('backupCron', 'Job to run for backup cron', function() {
    var done = this.async();
    backup.start(grunt.config, grunt.log);
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
