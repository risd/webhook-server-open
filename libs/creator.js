'use strict';

/**
* The create worker is the worker that handles initializing a site for the first time when someone runs
* wh create. It creates the initial bucket used to store the sites eventual html, and handles correctly
* setting the permissions on the bucket. It also generates the access key that is used to read/write from
* the bucket in firebase.
*/

// Requires
var Firebase = require('./firebase/index.js');
var Cloudflare = require('./cloudflare/index.js');
var colors = require('colors');
var _ = require('lodash');
var uuid = require('node-uuid');
var JobQueue = require('./jobQueue.js');
var request = require('request');
var miss = require('mississippi');
var minimatch = require( 'minimatch' );

var utils = require( './utils.js' );
var usingArguments = utils.usingArguments;
var sink = utils.sink;
var cloudStorage = require('./cloudStorage.js');

var escapeUserId = function(userId) {
  return userId.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

const DEFAULT_CNAME_RECORD = { content: 'c.storage.googleapis.com', }

module.exports.setupBucket = setupBucket;
module.exports.createCnameRecord = createCnameRecord;
module.exports.cnameForDomain = cnameForDomain;
module.exports.DEFAULT_CNAME_RECORD = DEFAULT_CNAME_RECORD;

/**
 * @param  {Object}   config     Configuration options from .firebase.conf
 * @param  {Object}   logger     Object to use for logging, defaults to no-ops (deprecated)
 */
module.exports.start = function (config, logger) {
  
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  var jobQueue = JobQueue.init(config);
  var self = this;

  var firebaseOptions = Object.assign(
    { initializationName: 'create-worker' },
    config().firebase )

  // project::firebase::initialize::done
  var firebase = Firebase( firebaseOptions )
  this.root = firebase.database()

  const fastly = require( './fastly' )(config.get( 'fastly' ))
  const cloudflareConfig = config.get('cloudflare')

  console.log('Waiting for commands'.red);

  // Wait for create commands from firebase
  jobQueue.reserveJob('create', 'create', createSite);

  return createSite;

  async function createSite ({ userId, siteName }, callback) {
    console.log('Processing Command For '.green + site.red);

    try {
      const siteManagementSnapshot = await firebase.siteManagement({ siteName })
      const siteManagement = siteManagementSnapshot.val()

      if (siteManagement.key) {
        // site already exists
        const error = new Error('site-exists')
        throw error
      }
      else if (_(siteManagement.owners).has(escapeUserId(userId))) {
        // site owner is requesting we setup the site
        await siteManagementError({ siteName }, false)
        try {
          await setupSite({ userId, siteName })
          await firebase.userManagementSetSiteOwner({ userEmail: userId, siteName })
          console.log(`create-site:${siteName}:success`)
        }
        catch (error) {
          console.log(`create-site:${siteName}:setup-site:error`)
          console.log(error)
          await siteManagementError({ siteName }, true)
          throw error
        }
      }  
      else {
        // Someone is trying to do something they shouldn't
        throw new Error('Site does not exist or no permissions')
      }
      callback()
    }
    catch (error) {
      console.log(`create-site:${siteName}:error`)
      console.log(error)
      // project::async
      // throw error
      return callback(error)
    }
  }


  /*
  * Sets up the necessary components of a webhook site
  */
  async function setupSite ({ siteName, userId }) {
    const siteKey = uuid.v4()
    const siteBucket = unescapeSite(siteName)

    await setupBucket({
      siteBucket,
      cloudflare: config.get( 'cloudflare' ),
      fastly: config.get( 'fastly' ),
      cloudStorage: config.get('cloudStorage'),
    })
    await firebase.siteKey({ siteName }, siteKey)
    await firebase.siteBillingCreate({ siteName, userEmail: userId })

    await firebase.siteDevData([ siteName, siteKey ], {
      data: {},
      contentType: {},
      settings: {},
    })
  }
}

/**
 * @param  {object}   options
 * @param  {string}   options.siteBucket
 * @param  {boolean}  options.ensureCname
 * @param  {object}   options.cloudStorage
 * @param  {string}   options.cloudStorage.projectId
 * @param  {string}   options.cloudStorage.serviceAccount
 * @param  {object}   options.cloudflare
 * @param  {object}   options.cloudflare.client
 * @param  {string}   options.cloudflare.client.key
 * @param  {string}   options.cloudflare.client.email
 * @param  {object}   options.fastly
 * @param  {string}   options.fastly.token
 * @param  {string}   options.fastly.service_id
 * @param  {string}   options.fastly.ignoreDomain
 */
async function setupBucket (options) {
  const { siteBucket } = options
  const fastly = require('./fastly')(options.fastly)
  const cnameOptions = {
    ...options.cloudflare,
    siteBucket,
  }
  cloudStorage.configure(options.cloudStorage)

  try {
    console.log('setup-bucket:get-bucket')
    await cloudStorage.bucketsPromises.get(siteBucket)
  }
  catch (error) {
    try {
      // make the bucket
      console.log('setup-bucket:create-bucket')
      await cloudStorage.bucketsPromises.create(siteBucket)
    }
    catch (error) {
      console.log('setup-bucket:create-bucket:error')
      console.log(error)
      throw error
    }
  }

  console.log('setup-bucket:update-bucket-acls')
  await cloudStorage.bucketsPromises.updateAcls(siteBucket)
  console.log('setup-bucket:update-bucket-index')
  await cloudStorage.bucketsPromises.updateIndex(siteBucket, 'index.html', '404.html')

  console.log('setup-bucket:fastly-setup')
  const service = await fastly.domain(siteBucket)
  if (typeof service === 'object' && service.hasOwnProperty('service_id')) {
    console.log('setup-bucket:fastly-setup:has-service')
  }
  else {
    console.log('setup-bucket:fastly-setup:no-service')
  }

  const cname = await createCnameRecord(cnameOptions)
}

/**
 * Create a CNAME record in CloudFlare for the given `row.siteBucket`.
 * The a site on the `developmentDomain` uses the default CNAME value
 * of Google Storage CNAME. Other domains can be configured via the
 * `domains` key.
 * 
 * @param  {object} options
 * @param  {string} options.siteBucket
 * @param  {object} options.client
 * @param  {string} options.client.email
 * @param  {string} options.client.key
 * @param  {Array} options.domains
 * @param  {string} options.domains[].domain   Minimatch compatabile domain string
 * @param  {string} options.domains[].cname    CNAME content value to use for matching domain
 * @param  {string} options.developmentDomain  Domain to use for 
 */
function createCnameRecord (options) {
  console.log( 'create-cname-record:start' )

  var cloudflare = Cloudflare( options.client )

  var siteBucket = options.siteBucket;
  var usesFastly = options.usesFastly;

  var baseRecordOptions = { type: 'CNAME', proxied: true }
  var googleRecordContent =  { content: 'c.storage.googleapis.com', };
  var fastlyRecordContent =  { content: 'nonssl.global.fastly.net', };

  var recordValues = Object.assign( {
        name: siteBucket,
      },
      baseRecordOptions,
      usesFastly ? fastlyRecordContent : googleRecordContent )

  return cloudflare.getZone( siteBucket )
    .then(handleZone)
    .then(handleCname)

  function handleZone ( zone ) {
    Object.assign( recordValues, { zone_id: zone.id } )
    return cloudflare.getCnameForSiteName( siteBucket, zone )
  }

  function handleCname ( existingRecord ) {
    if ( existingRecord && existingRecord.content !== recordValues.content ) {
      existingRecord.content = recordValues.content
      return updateRecord( existingRecord )
    }
    else if ( ! existingRecord ) {
      return createRecord( recordValues )
    }
    else if ( existingRecord ) {
      return Promise.resolve( existingRecord )
    }
  }

  function createRecord ( recordValues ) {
    return new Promise( function ( resolve, reject ) {
      cloudflare.createCname( recordValues )
        .then( resolve )
        .catch( function ( error ) {
          error.step = 'createCnameRecord:createRecord';
          reject( error )
        } )
    } )
  }

  function updateRecord ( record ) {
    return new Promise( function ( resolve, reject ) {
      cloudflare.updateCname( record )
        .then( resolve )
        .catch( function ( error ) {
          error.step = 'createCnameRecord:updateRecord';
          reject( error )
        } )
    } )
  }
}

function cnameForDomain ( domainConfiguration, siteBucket ) {
  // defaults to google cname record content
  var cnameRecord =  Object.assign( {}, DEFAULT_CNAME_RECORD )
  for ( var i = 0; i < domainConfiguration.length; i++ ) {
    if ( minimatch( siteBucket, domainConfiguration[ i ].domain ) ) {
      cnameRecord.content = domainConfiguration[ i ].cname;
      break;
    }
  }
  return cnameRecord;
}

