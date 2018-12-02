var _ = require( 'lodash' )
var fs = require( 'fs' )
var async = require( 'async' )

module.exports = ResetUserPasswords;

function ResetUserPasswords ( opts, callback ) {
  if ( ! ( this instanceof ResetUserPasswords ) ) return new ResetUserPasswords( opts, callback )
  if ( typeof callback !== 'function' ) callback = function noop () {}

  var firebase = opts.firebase;
  var mailgun = opts.mailgun;
  var fromEmail = opts.fromEmail;

  getFirebaseUsers( function withUsers ( error, usersSites ) {
    if ( error ) return callback( error )

    resetPasswords( usersSites, function onComplete ( error ) {
      if ( error ) return callback( error )
      callback()
    } )
  } )

  // usersHandler : ( error | usersSites : { userEmail : string, siteName : string } )
  function getFirebaseUsers ( usersHandler ) {
    firebase.allUsers()
      .then( returnUsers )
      .catch( usersHandler )

    function returnUsers ( usersSnapshot ) {
      try {
        var usersData = usersSnapshot.val();
        var usersSites = Object.keys( usersData ).map( userEmailToUserSite ).filter( filterFalse )
        usersHandler( null, usersSites )
      } catch ( error ) {
        usersHandler( error )
      }

      function userEmailToUserSite ( userEmail ) {
        var siteName = firstSiteForUserEmail()
        if ( siteName === false ) return siteName;

        return {
          userEmail: userEmail,
          siteName: siteName,
        }

        function firstSiteForUserEmail () {
          var firstSite = false;

          var sites = usersData[ userEmail ].sites
          if ( ! sites ) return firstSite;

          var owners = sites.owners
          var users = sites.users

          if ( ! owners && ! users ) {
            return firstSite;
          }
          
          if ( owners ) {
            firstSite = firstKeyInObject( owners )
          }
          else if ( userr && ( firstSite === false ) ) {
            firstSite = firstKeyInObject( users )
          }

          return firstSite;

          function firstKeyInObject( obj ) {
            var noFirstKey = false;
            if ( typeof obj !== 'object' || obj === null ) return noFirstKey;

            try {
              var keys = Object.keys( obj )
              if ( keys.length === 0 ) return noFirstKey;
              return keys[ 0 ]
            } catch ( error ) {
              return noFirstKey;
            }
          }
        }
      }
    }

    function filterFalse ( value ) {
      return value !== false;
    }
  }

  // usersSites : { userEmail : string, siteName : string }, onComplete : ( error |  )
  function resetPasswords ( usersSites, onComplete ) {

    var rawEmailTemplate = fs.readFileSync( 'libs/emails/password-reset.email' )
    var emailTemplate = _.template( rawEmailTemplate )

    var resetPasswordTasks = usersSites.map( resetPasswordTaskFromUser )

    async.series( resetPasswordTasks, onComplete )

    function resetPasswordTaskFromUser ( userSite ) {
      return function createTaskFrom ( onTaskComplete ) {
        firebase.resetUserPasswordLink( userSite )
          .then( sendEmail )
          .then( onTaskComplete )
          .catch( handleError )

        function sendEmail ( resetPasswordLink ) {
          return new Promise( function ( resolve, reject ) {
            var message = {
              from: fromEmail,
              to: userSite.userEmail,
              subject: `[ ${ userSite.siteName } ] Please reset your password.`,
              text: emailTemplate( Object.assign( { link: resetPasswordLink }, userSite ) ),
            }
            mailgun.messages().send( message, function ( error ) {
              if ( error ) return reject( error )
              resolve()
            } )  
          } )
        }

        function handleError ( error ) {
          if ( error && error.code && error.message ) {
            console.log( `error: ${ user } - ${ error.code } - ${ error.message }` )
            return onTaskComplete()
          }
          else {
            return onTaskComplete( error )
          }
        }
      }
    }
  }
}
