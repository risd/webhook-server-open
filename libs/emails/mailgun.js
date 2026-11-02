const Mailgun = require('mailgun.js')

module.exports = {
  sendMessage,
}

async function sendMessage ({ config, message }) {
  const {
    apiKey,
    fromEmail,
    domain,
    replyEmail,
    username = 'webhook-server-open-send-message',
  } = config
  const mailgun = new Mailgun(FormData)
  const mg = mailgun.client({
    username,
    key: apiKey,
    useFetch: true,
  })

  return mg.messages.create(domain, {
    from: fromEmail,
    ...message,
  })
}