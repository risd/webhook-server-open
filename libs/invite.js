'use strict';

/**
* The invite worker handles sending out invites when someone adds an email to their user list on webhook.
* It first checks to see if the account has been registered, if so it simply sends a link to the login page
* for the site, if not it sends a link to the registration page for the site.
*/

var fs = require('fs');
var Firebase = require('./firebase/index.js');
var colors = require('colors');
var _ = require('lodash');
var uuid = require('node-uuid');
var async = require('async');
var JobQueue = require('./jobQueue.js');
var Mailgun = require('mailgun-js');

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeUserId = function(userid) {
  return userid.replace(/,1/g, '.');
};

/**
 * @param  {Object}   config     Configuration options from .firebase.conf
 * @param  {Object}   logger     Object to use for logging, defaults to no-ops (deprecated)
 */
module.exports.start = function (config, logger) {
  var fromEmail = config.get('fromEmail');
  var mailgunDomain = config.get('mailgunDomain');
  var mailgun = new Mailgun({
    apiKey: config.get('mailgunKey'),
    domain: mailgunDomain,
  });

  var jobQueue = JobQueue.init(config);
  var self = this;

  var firebaseOptions = Object.assign(
    { initializationName: 'invite-worker' },
    config().firebase )

  // project::firebase::initialize::done
  var firebase = Firebase( firebaseOptions )
  this.root = firebase.database()
  this.users = this.root.ref( 'management/users' )

  console.log('Waiting for invites'.red);

  // Wait for jobs
  jobQueue.reserveJob('invite', 'invite', inviter);

  return inviter;

  function inviter (payload, identifier, data, client, callback) {
    var username = data.userid;
    var fromUsername = data.from_userid;
    var siteref = data.siteref;

    // project::firebase::child::done
    // project::firebase::once--value::done
    // Check to see if the user exists
    self.users.child(escapeUserId(username)).once('value', function(data) {
      var user = data.val();


      // If hte user doesnt exist, send a registration email
      if(!user || !user.exists) {
        sendRegistrationEmail(username, fromUsername, siteref, callback);
      } else { // If they do, send a login to the site
        sendLoginEmail(username, fromUsername, siteref, callback);
      }
    });
  }

  /*
  * Sends a registration-invite email to the user. This is an email that both sends the user
  * to the registration part of the webhook site.
  *
  * @param email        The email to send the invite to
  * @param fromUsername The username (email) thats being invited, should be the same as email
  * @param siteref      The site that the user is being invited to
  */
  function sendRegistrationEmail(email, fromUsername, siteref, callback) {
    console.log('Sending email');

    var siteRefUrl = 'http://' + unescapeUserId(siteref);

    // project::firebase::ref::done
    // project::firebase::once--value::done
    self.root.ref('management/sites/' + siteref + '/dns').once('value', function(snap) {
      if(snap.val()) {
        siteRefUrl = 'http://' + snap.val();
      }

      var url = siteRefUrl + '/cms/#/create-user?username=' + email;
      var siteUrl = siteRefUrl +'/';

      var contentTemplate = fs.readFileSync('libs/emails/invite-signup.email');
      var content = _.template(contentTemplate);

      var message = {
        from: fromEmail,
        to: email,
        subject: '[' + mailgunDomain + '] You\'ve been invited to edit ' + unescapeUserId(siteref),
        text: content({ fromUser: fromUsername, siteUrl: siteUrl, url: url, domain: mailgunDomain }),
      }

      mailgun.messages().send( message, callback )
    });

  }

  /*
  * Sends a normal invite email to the user. Since the user is already registered they just have
  * to login to the site.
  *
  * @param email        The email to send the invite to
  * @param fromUsername The username (email) thats being invited, should be the same as email
  * @param siteref      The site that the user is being invited to
  */
  function sendLoginEmail(email, fromUsername, siteref, callback) {
    console.log('Sending email');

    var siteRefUrl = 'http://' + unescapeUserId(siteref);

    // project::firebase::ref::done
    // project::firebase::once--value::done
    self.root.ref('management/sites/' + siteref + '/dns').once('value', function(snap) {
      if(snap.val()) {
        siteRefUrl = 'http://' + snap.val();
      }

      var url = siteRefUrl + '/cms/';
      var siteUrl = siteRefUrl + '/';

      var contentTemplate = fs.readFileSync('libs/emails/invite-login.email');
      var content = _.template(contentTemplate);

      var message = {
        from: fromEmail,
        to: email,
        subject: '[' + mailgunDomain + '] You\'ve been invited to edit ' + unescapeUserId(siteref),
        text: content({ fromUser: fromUsername, siteUrl: siteUrl, url: url, domain: mailgunDomain }),
      }

      mailgun.messages().send( message, callback )
    });
  }
};

