'use strict';

/**
* The create worker is the worker that handles initializing a site for the first time when someone runs
* wh create. It creates the initial bucket used to store the sites eventual html, and handles correctly
* setting the permissions on the bucket. It also generates the access key that is used to read/write from
* the bucket in firebase.
*/

// Requires
var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var uuid = require('node-uuid');
var JobQueue = require('./jobQueue.js');
var request = require('request');
var miss = require('mississippi');

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
  var firebaseUrl = config.get('firebase') || '';

  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com');

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    console.log('Waiting for commands'.red);

    // Wait for create commands from firebase
    jobQueue.reserveJob('create', 'create', createSite);
  });

  function createSite (payload, identifier, data, client, callback) {
    var userid = data.userid;
    var site = data.sitename;

    console.log('Processing Command For '.green + site.red);
    self.root.child('management/sites/' + site).once('value', function(siteData) {
      var siteValues = siteData.val();

      // IF site already has a key, we alraedy created it, duplicate job
      if(siteValues.key)
      {
        console.log('Site already has key');
        callback();
      }
      // Else if the site owner is requesting, we need to make it
      else if(_(siteValues.owners).has(escapeUserId(userid)))
      {
        self.root.child('management/sites/' + site + '/error/').set(false, function(err) {
          // We setup the site, add the user as an owner (if not one) and finish up
          setupSite(site, siteValues, siteData, siteData.ref(), userid, function(err) {
            if(err) {
              self.root.child('management/sites/' + site + '/error/').set(true, function(err) {
                console.log('Error Creating Site For '.green + site.red);
                callback();
              });
            } else {
              self.root.child('management/users/' + escapeUserId(userid) + '/sites/owners/' + site).set(true, function(err) {
                console.log('Done Creating Site For '.green + site.red);
                callback();
              });
            }
          });
        });
      } else {
        // Someone is trying to do something they shouldn't
        console.log('Site does not exist or no permissions');
        callback();
      }
    }, function(err) {
      callback();
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

    console.log('setting up site')
    console.log(siteBucket)
    console.log(key)

    var generateKey = function () {
      return miss.through.obj(function (row, enc, next) {
        if ( row.bucketExists === true && row.siteKey.length > 0 ) {
          console.log( 'site-setup:generate-key:', row.siteBucket )

          siteRef.child('key').set(row.siteKey, function(err) {
            console.log('site-setup:generate-key:setting-billing:')
            console.log(err)

            // Set some billing info, not used by self-hosting, but required to run
            siteRef.root().child('billing/sites/' + row.siteName).set({
              'plan-id': 'mainplan',
              'email': userid,
              'status': 'paid',
              'active': true,
              'endTrial' : Date.now()
            }, function(err) {
              console.log( 'site-setup:generate-key:' )
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
        }]),
        getBucket(),
        createBucket(),
        updateAcls(),
        updateIndex(),
        ensureCname( config.get( 'cloudflare' ) ),
        ensureCdn( config.get( 'fastlyToken' ) ),
        generateKey(),
        sink(),
        function onEnd ( error ) {
          if ( error ) return callback( error )
          else return callback();
        }
      )
  }

  return createSite;
};

module.exports.setupBucket = setupBucket;
module.exports.createCnameRecord = createCnameRecord;


/**
 * @param  {object}   options
 * @param  {string}   options.siteBucket
 * @param  {boolean}  options.ensureCname
 * @param  {object}   options.cloudStorage
 * @param  {object}   options.cloudflare
 * @param  {object}   options.cloudflare.client
 * @param  {string}   options.cloudflare.client.key
 * @param  {string}   options.cloudflare.client.email
 * @param  {string}   options.cloudflare.zone_id
 * @param  {string}   options.fastlyToken
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
  return miss.pipe(
    setupSiteWith([ bucketToSetup ]),
    getBucket(),
    createBucket(),
    updateAcls(),
    updateIndex(),
    ensureCname( options.cloudflare ),
    ensureCdn( options.fastlyToken ),
    sink(),
    function ( error ) {
      if ( error ) return callback( error )
      else return callback( null, bucketToSetup )
    })
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
      function ( error, body ) {
        if ( error ) { error.step = 'updateIndex'; return next( error, null ) }
        else next( null, row )
      } )
  });
}

/**
 * @param  {object}    options
 * @param  {object}    options.client
 * @param  {string}    options.client.key
 * @param  {string}    options.client.email
 * @param  {string}    options.zone_id
 * @return {Function}  transform stream
 */
function ensureCname ( options ) {

  // should be part of options, and configuration based
  
  var cloudFlareManagedDomains = options.domains;

  var isManagedByCloudFlare = function ( domain ) {
    return cloudFlareManagedDomains.filter( function ( managedDomain ) {
      return domain.endsWith( managedDomain )
    } ).length === 1;
  }

  var fastlyCreateCnameRecordOptions = Object.assign( {}, options, {
    content: 'nonssl.global.fastly.net',
  } )

  var createCnameRecordOptions = function ( siteBucket ) {
    return Object.assign( {}, fastlyCreateCnameRecordOptions, { record: siteBucket } )
  }

  return miss.through.obj( function ( row, enc, next ) {

    if ( isManagedByCloudFlare( row.siteBucket ) && row.ensureCname ) {
      console.log( 'site-setup:ensure-cname:' + row.siteBucket )

      createCnameRecord( createCnameRecordOptions( row.siteBucket ), function ( error, cname ) {
        row.cname = cname;
        console.log( 'site-setup:ensure-cname:done' )
        console.log( row )
        next( null, row );
      } )
    } else {
      console.log( 'site-setup:ensure-cname:skipping' )
      next( null, row )
    }

  } )
}


/**
 * Create a CNAME record in CloudFlare for the given `row.siteBucket`
 * 
 * @param  {object} options
 * @param  {object} options.client
 * @param  {string} options.client.email
 * @param  {string} options.client.key
 * @param  {string} options.record
 * @param  {string} options.content
 * @param  {string} options.zone_id
 * @param  {Function} onComplete ( Error|null, Boolean|CnameRecord )
 */
function createCnameRecord ( options, onComplete ) {
  console.log( 'create-cname-record:start' )
  
  var Cloudflare = require('cloudflare');

  var client = new Cloudflare( options.client )
  var cnameRecord  = stripWww( options.record )
  var cnameContent = options.content
  var zone_id = options.zone_id

  var recordCreated = false;
  
  var createRecordOptions = { type: 'CNAME', zone_id: zone_id, proxied: true }

  function createRecord ( recordValues, withRecord ) {

    var dnsCnameRecord = Cloudflare.DNSRecord.create( Object.assign( {}, createRecordOptions, recordValues ) );

    client.addDNS( dnsCnameRecord )
      .then( function ( cname ) {
        return withRecord( null, cname )
      } )
      .catch( function ( error ) {
        error.step = 'createCnameRecord:createRecord';
        withRecord( error, recordCreated )
      } )
  }

  function updateRecord ( record, withRecord ) {
    client.editDNS( record )
      .then( function ( cname ) {
        return withRecord( null, cname )
      } )
      .catch( function ( error ) {
        error.step = 'createCnameRecord:updateRecord';
        withRecord( error, recordCreated )
      } )
  }

  return gatherCnames( zone_id, function ( error, cnames ) {
    if ( error ) { error.step = 'createCnameRecord:gatherCnames'; return onComplete( error, recordCreated ) }

    var recordValues = {
      name: cnameRecord,
      content: cnameContent,
    }

    var existingRecord = valueInArray( cnames, nameKey, cnameRecord )
    
    if ( !existingRecord ) {
      // does not exist, lets make it
      return createRecord( recordValues, onComplete )
    }
    else if ( existingRecord.content !== cnameContent ) {
      // exists, but has dated content, lets update it
      existingRecord.content = cnameContent;
      return updateRecord( existingRecord, onComplete )
    }
    else return onComplete( null, ( recordCreated = true ) )

    function valueInArray ( arr, keyFn, seekingValue ) {
      var index = arr.map( keyFn ).indexOf( seekingValue )
      if ( index === -1 ) return undefined;
      return arr[ index ]
    }

    function nameKey ( record ) {
      return record.name;
    }
  } )

  function gatherCnames ( zone_id, withCnames ) {

    var gatherOptions = { type: 'CNAME' }
    var cnameSources = [];

    function pluckCnamesFromRecords ( records ) {
      cnameSources = cnameSources.concat( records )
    }

    function getPageOfCnames ( pageOptions, withPage ) {
      if ( !pageOptions ) pageOptions = {};

      client.browseDNS( zone_id, Object.assign( gatherOptions, pageOptions ) )
        .then( function ( response ) {
          pluckCnamesFromRecords( response.result )
          withPage( null, { page: response.page, totalPages: response.totalPages, } )
        } )
        .catch( function ( error ) {
          withPage( error )
        } )

    }

    function paginate ( error, pagination ) {
      if ( error ) return withCnames( error )

      if ( pagination.page < pagination.totalPages ) return getPageOfCnames( { page: pagination.page + 1 }, paginate )

      else return withCnames( null, cnameSources )
    }

    return getPageOfCnames( { page: 1 }, paginate )

  }

  function stripWww ( record ) {
    var www = 'www.'
    return record.indexOf( www ) === 0 ? record.slice( www.length ) : record;
  }

}

function ensureCdn ( fastlyToken ) {
  return miss.through.obj( function ( row, enc, next ) {
    console.log( 'ensure-cdn:' + row.siteBucket );

    var fastlyOptions = { domain: row.siteBucket, fastlyToken: fastlyToken }
    fastlyServiceForDomain( fastlyOptions, function ( error, service ) {
      if ( error ) { error.step = 'ensureCdn'; return next( error ) }

      console.log( 'ensure-cdn:done' );
      row.fastly = service;
      return next( null, row )
    } )
  } )
}

function fastlyServiceForDomain ( options, callback ) {
  if ( !options ) return callback( new Error( 'Requires { fastlyToken, domain }.' ) )
  var fastlyToken = options.fastlyToken;
  var domain = options.domain;

  var fastly = require( 'Fastly' )( fastlyToken )
  var serviceForDomain = require( './redirects.js' ).serviceForDomain;

  miss.pipe(
    usingArguments( { domain: domain } ),
    serviceForDomain( fastly ),
    sink( function ( row ) {
      // row = { service_id, dictionary_id, active_version }
      callback( null, Object.assign( {}, row, { usesFastly: true } ) )
    } ),
    function onComplete ( error ) {
      if ( error ) { error.step = 'fastlyServiceForDomain'; return callback( error ) }
    } )
}
