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

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

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

  console.log('Waiting for commands'.red);

  // Wait for create commands from firebase
  jobQueue.reserveJob('create', 'create', createSite);

  return createSite;

  function createSite (payload, identifier, data, client, callback) {
    var userid = data.userid;
    var site = data.sitename;

    console.log('Processing Command For '.green + site.red);

    // project::firebase::ref::done
    self.root.ref('management/sites/' + site).once('value', function(siteData) {
      var siteValues = siteData.val();

      // IF site already has a key, we alraedy created it, duplicate job
      if(siteValues.key)
      {
        console.log('Site already has key');

        callback( new Error( 'site-exists' ) );
      }
      // Else if the site owner is requesting, we need to make it
      else if(_(siteValues.owners).has(escapeUserId(userid)))
      {
        // project::firebase::ref::done
        self.root.ref('management/sites/' + site + '/error/').set(false, function(err) {
          // We setup the site, add the user as an owner (if not one) and finish up
          setupSite(site, siteValues, siteData, siteData.ref, userid, function(err) {
            if(err) {
              var errorMessage = 'Error Creating Site For '.green + site.red;
              // project::firebase::ref::done
              self.root.ref('management/sites/' + site + '/error/').set(true, function(err) {
                if ( err ) return callback( err )
                return callback( new Error( errorMessage.stripColors ) );  
              });
            } else {
              // project::firebase::ref::done
              self.root.ref('management/users/' + escapeUserId(userid) + '/sites/owners/' + site).set(true, function(err) {
                console.log('Done Creating Site For '.green + site.red);
                if (err) return callback( err )
                callback();
              });
            }
          });
        });
      } else {
        // Someone is trying to do something they shouldn't
        var errorMessage = 'Site does not exist or no permissions'
        console.log( errorMessage );
        callback( new Error( 'Site does not exist or no permissions' ) );
      }
    }, function(err) {
      callback( err );
    });
  }


  /*
  * Sets up the necessary components of a webhook site
  *
  * @param siteValue The values of the site in firebase
  * @param siteData  The actual data of the site in firebase
  * @param siteRef   Firebase reference to the site node
  * @param userid    The userid creatign the site
  * @param callback  Called when done
  */
  function setupSite(site, siteValue, siteData, siteRef, userid, callback) {

    var key = uuid.v4();

    var siteBucket = unescapeSite(site);

    var generateKey = function () {
      return miss.through.obj(function (row, enc, next) {
        if ( row.bucketExists === true && row.siteKey.length > 0 ) {
          console.log( 'site-setup:generate-key:', row.siteBucket )

          // project::firebase::ref::done
          // project::firebase::set::done
          siteRef.child('key').set(row.siteKey, function(err) {
            console.log('site-setup:generate-key:setting-billing:')
            console.log(err)
            if ( err ) return next( err )

            // Set some billing info, not used by self-hosting, but required to run
            // project::firebase::child::done
            // project::firebase::set::done
            self.root.ref('billing/sites/' + row.siteName).set({
              'plan-id': 'mainplan',
              'email': userid,
              'status': 'paid',
              'active': true,
              'endTrial' : Date.now()
            }, function(err) {
              console.log( 'site-setup:generate-key:error' )
              console.log( err )
              if ( err ) return next( err )
              next( null, row );
            });
          });
        }
        else {
          next( null, row );
        }
      });
    }

    miss.pipe(
        setupSiteWith([{
          siteBucket:   siteBucket,
          bucketExists: false,
          cloudStorage: cloudStorage,
          // specifically for generating the key
          siteKey:      key,
          siteName:     site,
          ensureCname:  true,
        }]),
        getBucket(),
        createBucket(),
        updateAcls(),
        updateIndex(),
        ensureCdn( config.get( 'fastly' ) ),
        ensureCname( config.get( 'cloudflare' ) ),
        generateKey(),
        createData(),
        sink(),
        function onEnd ( error ) {
          if ( error ) return callback( error )
          else return callback();
        }
      )
  }

  return createSite;

  function createData() {
    return miss.through.obj( function ( row, enc, next ) {
      console.log( 'create-data:start' )
      var devData = {
        data: {},
        contentType: {},
        settings: {},
      }
      console.log( row.siteName )
      console.log( row.siteKey )
      console.log( devData )
      // project::firebase::ref::done
      // project::firebase::set::done
      self.root.ref( `buckets/${ row.siteName }/${ row.siteKey }/dev` )
        .set( devData, function onComplete ( error ) {
          console.log( 'create-data:end:error' )
          console.log( error )
          if ( error ) return next( error )
          next( null, row )
        } )
    } )
  }
};

var DEFAULT_CNAME_RECORD = { content: 'c.storage.googleapis.com', }

module.exports.setupBucket = setupBucket;
module.exports.createCnameRecord = createCnameRecord;
module.exports.cnameForDomain = cnameForDomain;
module.exports.DEFAULT_CNAME_RECORD = DEFAULT_CNAME_RECORD;



/**
 * @param  {object}   options
 * @param  {string}   options.siteBucket
 * @param  {boolean}  options.ensureCname
 * @param  {object}   options.cloudStorage
 * @param  {object}   options.cloudflare
 * @param  {object}   options.cloudflare.client
 * @param  {string}   options.cloudflare.client.key
 * @param  {string}   options.cloudflare.client.email
 * @param  {object}   options.fastly
 * @param  {string}   options.fastly.token
 * @param  {string}   options.fastly.service_id
 * @param  {string}   options.fastly.ignoreDomain
 * @param  {Function} callback
 * @return {Function}
 */
function setupBucket ( options, callback ) {

  var bucketToSetup = {
    siteBucket:   options.siteBucket,
    ensureCname:  options.ensureCname || true,
    bucketExists: false,
    createdBucket: false,
    cloudStorage: options.cloudStorage,
  }

  var pipeline = [
    setupSiteWith([ bucketToSetup ]),
    getBucket(),
    createBucket(),
    updateAcls(),
    updateIndex(),
    ensureCdn( options.fastly ),
    ensureCname( options.cloudflare ),
    sink(),
    handlePipeline,
  ]

  miss.pipe.apply( null, pipeline )

  function handlePipeline ( error ) {
    if ( error ) return callback( error )
    else return callback( null, bucketToSetup )
  }
}


function setupSiteWith (input) {
  var readIndex = 0;
  var emitter = miss.through.obj();

  process.nextTick(function () {
    if ( !Array.isArray( input ) )
      return emitter.push( null )

    if ( input[ input.length - 1 ] !== null )
      input = input.concat( [ null ] )
    
    input.forEach( function ( item ) {
      process.nextTick( function () {
        emitter.push( item )
      } )
    } )
  })

  return emitter;
}

// Does the bucket exist? Useful for setting up buckets
// against domains that are verified, but cause issues
// creating through this interface
function getBucket () {
  return miss.through.obj(function (row, enc, next) {
    console.log( 'site-setup:get-bucket:', row.siteBucket )
    row.cloudStorage.buckets.get(row.siteBucket, function (err, body) {
      if ( err ) {
        console.log( 'site-setup:get-bucket:error' )
        console.log( err )
      }
      else row.bucketExists = true;

      return next( null, row );
    })
  })
}

function createBucket () {
  return miss.through.obj(function (row, enc, next) {
    if ( row.bucketExists === false ) {
      console.log( 'site-setup:create-bucket:', row.siteBucket )
      row.cloudStorage.buckets.create(row.siteBucket, function (err, body) {
        if ( err ) {
          console.log( 'site-setup:create-bucket:error' )
          console.log( err )
        }
        else {
          row.bucketExists = true;
          row.createdBucket = true;
        }
        
        next( null, row );
      })
    }
    else {
      next( null, row )
    }
  });
}

function updateAcls () {
  return miss.through.obj(function (row, enc, next) {
    if ( row.bucketExists === false ) return next( null, row )
    
    console.log( 'site-setup:update-acls:', row.siteBucket )
    row.cloudStorage.buckets.updateAcls( row.siteBucket, function (err, body) {
      console.log( err )
      console.log( body )
      if ( err && typeof err === 'object' ) {
        error.step = 'update-acls'
        return next( error )
      }
      else if ( err && typeof err === 'number' ) {
        var error = new Error( err )
        error.step = 'update-acls'
        return next( error )
      }
      else if ( err ) {
        return next( err )
      }
      next( null, row )
    } )

  });
}

function updateIndex () {
  return miss.through.obj(function (row, enc, next) {
    if ( row.bucketExists === false ) return next( null, row )

    console.log( 'site-setup:update-index:', row.siteBucket )
    row.cloudStorage.buckets.updateIndex(
      row.siteBucket,
      'index.html', '404.html',
      function ( err, body ) {
        if ( err && typeof err === 'object' ) {
          error.step = 'update-acls'
          return next( error )
        }
        else if ( err && typeof err === 'number' ) {
          var error = new Error( err )
          error.step = 'update-acls'
          return next( error )
        }
        else if ( err ) {
          return next( err )
        }
        next( null, row )
      } )
  });
}

/**
 * @param  {object}    options
 * @param  {object}    options.client
 * @param  {string}    options.client.key
 * @param  {string}    options.client.email
 * @param  {string}    options.domains
 * @return {Function}  transform stream
 */
function ensureCname ( options ) {

  return miss.through.obj( function ( row, enc, next ) {

    if ( row.ensureCname ) {
      console.log( 'site-setup:ensure-cname:' + row.siteBucket )

      var cnameOptions = Object.assign( {
        siteBucket: row.siteBucket,
      }, options )

      createCnameRecord( cnameOptions, function ( error, cname ) {
        console.log( 'site-setup:ensure-cname:done' )
        if ( error ) {
          console.log( error )
          row.cname = null
        }
        else {
          row.cname = cname;
        }
        next( null, row );
      } )
    } else {
      console.log( 'site-setup:ensure-cname:skipping' )
      next( null, row ) 
    }
  } )
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
 * @param  {Function} onComplete ( Error|null, Boolean|CnameRecord )
 */
function createCnameRecord ( options, callback ) {
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

  cloudflare.getZone( siteBucket )
    .then( handleZone )
    .then( handleCname )
    .then( returnCname )
    .catch( handleCnameError )

  function returnCname ( cname ) {
    callback( null, cname ) 
  }

  function handleCnameError ( error ) {
     callback( error )
  }

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

  function createRecord ( recordValues, withRecord ) {
    return new Promise( function ( resolve, reject ) {
      cloudflare.createCname( recordValues )
        .then( resolve )
        .catch( function ( error ) {
          error.step = 'createCnameRecord:createRecord';
          reject( error )
        } )
    } )
  }

  function updateRecord ( record, withRecord ) {
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

function ensureCdn ( fastlyOptions ) {
  var cdn = require( './fastly' )( fastlyOptions )

  return miss.through.obj( function ( row, enc, next ) {
    console.log( 'ensure-cdn:' + row.siteBucket );

    cdn.domain( row.siteBucket, function ( error, service ) {
      if ( error ) { error.step = 'ensureCdn'; return next( error ) }
      else if ( typeof service === 'object' && service.hasOwnProperty( 'service_id' ) ) {
        row.cdn = service;  
      }
      else {
        row.cdn = false;
      }
      console.log( 'ensure-cdn:done' );
      return next( null, row )
    } )
  } )
}
