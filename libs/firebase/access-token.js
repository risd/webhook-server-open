var google = require( 'googleapis' ).google

module.exports = FirebaseAccessToken;

// get a rest API access token
function FirebaseAccessToken ( firebaseServiceAccountKey ) {
  // Define the required scopes.
  var scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/firebase.database"
  ]

  // Authenticate a JWT client with the service account.
  var jwtClient = new google.auth.JWT(
    firebaseServiceAccountKey.client_email,
    null,
    firebaseServiceAccountKey.private_key,
    scopes
  )

  return new Promise( function ( resolve, reject ) {

    // Use the JWT client to generate an access token.
    jwtClient.authorize(function(error, tokens) {
      if (error) {
        return reject( error )
      }
      else if (tokens.access_token === null) {
        var errorMsg = "Provided service account does not have permission to generate access tokens"
        return reject( new Error( errorMsg ) )
      }
      else {
        var accessToken = tokens.access_token;
        resolve( accessToken )
      }
    } )
  } )
}
