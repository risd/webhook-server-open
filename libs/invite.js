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

var unescapeFirebase = require( './utils/firebase-unescape.js' )

module.exports = configure
function configure (config) {
  var fromEmail = config.get('fromEmail');
  var mailgunDomain = config.get('mailgunDomain');
  var mailgun = new Mailgun({
    apiKey: config.get('mailgunKey'),
    domain: mailgunDomain,
  });
  const firebase = Firebase({
    initializationName: 'invite-worker',
    ...config.get('firebase'),
  })

  return async function inviter ({ userId, from_userid, siteref }) {
    const userEmail = unescape(userId)
    const userExists = await firebase.userExists({ userEmail })
    const fromUser = unescape(from_userid)
    const siteName = unescape(siteref)
    const domain = mailgunDomain
    const siteUrl = `http://${siteName}`
    const cmsUrl = `${siteUrl}/cms/`
    const subject = `[${domain}] You\'ve been invited to edit ${siteName}`
    if (userExists) {
      const contentTemplate = fs.readFileSync('libs/emails/invite-login.email');
      const content = _.template(contentTemplate);
      const message = {
        from: fromEmail,
        to: userEmail,
        subject,
        text: content({ fromUser, siteUrl, cmsUrl, domain }),
      }
      await sendMessage(message)
    }
    else {
      const createUrl = `${cmsUrl}#/create-user?username=${userEmail}`
      const contentTemplate = fs.readFileSync('libs/emails/invite-signup.email')
      const content = _.template(contentTemplate)
      const message = {
        from: fromEmail,
        to: userEmail,
        subject,
        text: content({ fromUser, siteUrl, createUrl, domain }),
      }
      await sendMessage(message)
    }
  }

  function sendMessage (message) {
    return new Promise((resolve, reject) => {
      mailgun.messages().send(message, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}


module.exports.start = function (config) {
  const job = configure(config)

  const wrapJob = (payload, callback) => {
    job(payload)
      .then(() => {
        console.log('inviter:job:complete')
        callback()
      })
      .catch((error) => {
        console.log('inviter:job:error')
        console.log(error)
        callback(error)
      })
  }

  var jobQueue = JobQueue.init(config)
  console.log('Waiting for invites'.red);

  // Wait for jobs
  jobQueue.reserveJob('invite', 'invite', wrapJob)
};

