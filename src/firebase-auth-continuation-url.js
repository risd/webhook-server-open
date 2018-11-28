module.exports = FirebaseAuthContinuationUrl;

// options : { siteName : string, userEmail : string } => continuationUrl : string
function FirebaseAuthContinuationUrl ( options ) {
  var siteName = options.siteName;
  
  var redirectTo = encodeURIComponent( [ 'https://', siteName, '/cms' ].join('') )
  return [ 'https://redirect.risd.systems/index.html?to=', redirectTo ].join( '' )
}
