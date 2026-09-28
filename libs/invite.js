'use strict';

/**
* The invite worker handles sending out invites when someone adds an email to their user list on webhook.
* It first checks to see if the account has been registered, if so it simply sends a link to the login page
* for the site, if not it sends a link to the registration page for the site.
*/

const debug = require('debug')('invite')
var fs = require('fs');
var Firebase = require('./firebase/index.js');
var _ = require('lodash');
var async = require('async');
var JobQueue = require('./jobQueue.js');
const Mailgun = require('mailgun.js')

var unescapeFirebase = require( './utils/firebase-unescape.js' )

module.exports.configure = configure

function configure (config) {
  const mailgunConfig = config.get('mailgun')
  const {apiKey, fromEmail, domain, replyEmail} = mailgunConfig
  const mailgun = new Mailgun(FormData)
  const mg = mailgun.client({
    username: 'webhook-server-open-inviter',
    key: apiKey,
    useFetch: true,
  })

  const sendMessage = async (message) => {
    try {
      const res = await mg.messages.create(domain, {
        ...message,
        from: fromEmail,
      })
      console.log({res})
    }
    catch (error) {
      console.error('Error sending invite email')
      console.error(error)
    }
  }

  const firebase = Firebase({
    initializationName: 'invite-worker',
    ...config.get('firebase'),
  })

  return async function inviter ({ userId, fromUser, siteName }) {
    debug('invite')
    debug('invite:siteName', siteName)
    const userEmail = unescapeFirebase(userId)
    debug('userEmail', userEmail)
    const userExists = await firebase.userExists({ userEmail })
    fromUser = unescapeFirebase(fromUser)
    siteName = unescapeFirebase(siteName)
    const siteUrl = `http://${siteName}`
    const cmsUrl = `${siteUrl}/cms/`
    const subject = `[${domain}] You\'ve been invited to edit ${siteName}`
    if (userExists) {
      debug('msg:login')
      const contentTemplate = fs.readFileSync('libs/emails/invite-login.email');
      const content = _.template(contentTemplate);
      const message = {
        to: userEmail,
        subject,
        text: content({ fromUser, siteUrl, cmsUrl, domain }),
      }
      if (replyEmail) message['h:Reply-To'] = replyEmail
      await sendMessage(message)
    }
    else {
      debug('msg:signup')
      const createUrl = `${cmsUrl}#/create-user?username=${userEmail}`
      const contentTemplate = fs.readFileSync('libs/emails/invite-signup.email')
      const content = _.template(contentTemplate)
      const message = {
        to: userEmail,
        subject,
        text: content({ fromUser, siteUrl, createUrl, domain }),
      }
      if (replyEmail) message['h:Reply-To'] = replyEmail
      await sendMessage(message)
    }
    debug('msg:sent')
  }
}

/**
 * JobQueue wrapper used by the command delegator
 */
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
  jobQueue.reserveJob('invite', 'invite', wrapJob)
};

