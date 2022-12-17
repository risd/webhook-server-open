const {JWT} = require('google-auth-library')

module.exports = FirebaseAccessToken;

// get a rest API access token
async function FirebaseAccessToken (firebaseServiceAccountKey) {
  // Define the required scopes.
  const scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/firebase.database"
  ]

  // Authenticate a JWT client with the service account.
  const client = new JWT({
    email: firebaseServiceAccountKey.client_email,
    key: firebaseServiceAccountKey.private_key,
    scopes,
  })

  const credentials = await client.authorize()
  return credentials.access_token
}
