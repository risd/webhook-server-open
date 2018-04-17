'use strict';

// Requires
require('colors');
var fs = require('fs');
var _ = require('lodash');
var domain = require('domain');
var firebase = require('firebase');
var JobQueue = require('./jobQueue.js');
var WebHookElasticSearch = require( 'webhook-elastic-search' )
var WebhookSiteData = require( 'webhook-site-data' )

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

function noop () {}

/**
 * The main reindex worker. The way this works is that it first checks to
 * see if it has a local up-to-date copy of the site, if it doesn't then it
 * downloads them from the cloud storage archive. After downloading it simply
 * runs `grunt build` in the sites directory, then uploads the result to cloud storage.
 *
 * @param  {Object}   config     Configuration options from Grunt
 * @param  {Object}   logger     Object to use for logging, deprecated, not used
 */
module.exports.start = function (config, logger) {
  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);

  var self = this;
  var firebaseUrl = config.get('firebase') || '';

  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com/buckets');

  var searchOptions = {
    host: config.get('elasticServer'),
    username: config.get('elasticUser'),
    password: config.get('elasticPassword'),
  }
  var search = WebHookElasticSearch( searchOptions )

  console.log( 'searchOptions' )
  console.log( searchOptions )

  var siteDataOptions = {
    firebase: {
      name: config.get('firebase'),
      secret: config.get('firebaseSecret'),
    },
  }
  var whSiteData = WebhookSiteData( siteDataOptions )

  /*
  *  Reports the status to firebase, used to display messages in the CMS
  *
  *  @param site    The name of the site
  *  @param message The Message to send
  *  @param status  The status code to send (same as command line status codes)
  */
  var reportStatus = function(site, message, status) {
    var messagesRef = self.root.root().child('/management/sites/' + site + '/messages/');
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: 'SITE_INDEX' }, function() {
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limit(1).once('child_added', function(snap) {
            snap.ref().remove();
          });
        }
      });
    });
  };

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    console.log('Waiting for commands'.red);

    // Wait for a searhc index job, extract info from payload
    jobQueue.reserveJob('siteSearchReindex', 'siteSearchReindex', siteSearchReindexJob);

  });

  return siteSearchReindexJob;

  function siteSearchReindexJob (payload, identifier, data, client, jobCallback) {
    console.log('Triggered command!');
    console.log('payload')
    console.log(JSON.stringify(payload))
    console.log('identifier')
    console.log(identifier)
    console.log('data')
    console.log(JSON.stringify(data))

    var userid = data.userid;
    var site = data.sitename;

    console.log('Processing Command For '.green + site.red);

    self.root.root().child('management/sites/' + site).once('value', function(siteData) {
      var siteValues = siteData.val();

      // If the site does not exist, may be stale build, should no longer happen
      if(!siteValues) {
        jobCallback();
        return;
      }

      var siteName = unescapeSite( siteData.name() );

      // Run a domain so we can survive any errors
      var domainInstance = domain.create();

      domainInstance.on('error', function(err) { 
        console.log('domain-instance:error');
        console.log(err);
        reportStatus(siteName, 'Failed to re-index, errors encountered in search indexing process', 1);
        jobCallback();
      });

      domainInstance.run(function() {
        
        search.siteEntries( siteName, function ( error, siteIndex ) {
          whSiteData.get( { siteName: siteName, key: siteValues.key }, function ( error, retrievedSiteData ) {

            var updateIndexOptions = {
              siteName: siteName,
              siteData: { data: retrievedSiteData.data, contentType: retrievedSiteData.contentType },
              siteIndex: siteIndex,
            }

            search.updateIndex( updateIndexOptions, function ( error, results ) {

              console.log( 'update-index-results' )
              if ( error ) {
                console.log( 'error:' )
                console.log( error )
              }
              if ( results.error ) {
                console.log( 'indexed-error:' )
                console.log( results.error )
              }
              if ( results.items ) {
                console.log( 'indexed-items:' + results.items.length )
              }
              reportStatus(siteData.name(), 'Re-index process complete', 0);
              jobCallback( error )

            } )

          } )
        } )

      })


    }, function(err) {
      jobCallback(err);
    });
  }

};
