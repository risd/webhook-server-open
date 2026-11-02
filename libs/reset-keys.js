const async = require( 'async' )
const Firebase = require( './firebase/index.js' )
const resetSiteKeys = require( './firebase/reset-site-keys.js' )
const resetUserPasswords = require( './firebase/reset-user-passwords.js' )
const { sendMessage } = require('./emails/mailgun.js')

module.exports = {
  resetKeys,
}

async function resetKeys ({ config }) {
  const firebase = Firebase(config.get('firebase'))
  const mailgun = {
    async sendMessage ({ message }) {
      return sendMessage({
        config: {
          ...config.get('mailgun'),
          username: 'webhook-server-open-reset-keys',
        },
        message,
      })
    }
  }

  function resetSiteKeysTask (complete) {
    resetSiteKeys({ firebase }, complete)
  }

  function resetUserPasswordsTask (complete) {
    resetUserPasswords({ firebase, mailgun }, complete)
  }

  return new Promise((resolve, reject) => {
    async.series([resetSiteKeysTask, resetUserPasswordsTask], hanldeSeries)  

    function hanldeSeries ( error ) {
      if ( error ) reject( error )
      else resolve()
    }
  })
}