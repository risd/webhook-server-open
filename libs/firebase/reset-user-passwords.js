var async = require( 'async' )

module.exports = ResetUserPasswords;

function ResetUserPasswords ( opts, callback ) {
  if ( ! ( this instanceof ResetUserPasswords ) ) return new ResetUserPasswords( opts, callback )
  if ( typeof callback !== 'function' ) callback = function noop () {}

  var firebase = opts.firebase;

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

          var owner = sites.owners
          var user = sites.users

          if ( ! owners && ! users ) {
            return firstSite;
          }
          
          if ( owner ) {
            firstSite = firstKeyInObject( owner )
          }
          else if ( user && ( firstSite === false ) ) {
            firstSite = firstKeyInObject( user )
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
    var retryTask = taskRetryManager();

    var resetPasswordTasks = usersSites.map( resetPasswordTaskFromUser )

    async.parallelLimit( resetPasswordTasks, 5, onComplete )

    function resetPasswordTaskFromUser ( userSite ) {

      var createTaskFrom = function ( userSite, onTaskComplete, onTaskError ) {
        firebase.resetUserPassword( userSite, function ( error ) {
          if ( error && error.code && error.message ) {
            console.log( `error: ${ user } - ${ error.code } - ${ error.message }` )
            return onTaskComplete()
          }
          else if ( error ) {
            return onTaskError( error )
          }
        } )
      }

      function onTaskError ( error ) {
        if ( retryTask.attempts > 5 ) return onTaskError( error )

        retryTask( function () {
          createTaskFrom( userSite, onTaskComplete, onTaskError )
        } )
      }

      function task ( onTaskComplete ) {
        return createTaskFrom( userSite, onTaskComplete, onTaskError )
      }

      return task;
    }

    function taskRetryManager () {
      var taskRetryAttempts = 0;

      var retryTask = function ( task ) {
        taskRetryAttempts += 1;
        var timeout = backoffTime( taskRetryAttempts );
        setTimeout( function retry () {
          task()
        }, timeout )
      }

      retryTask.attempts = taskRetryAttempts;

      return retryTask;

      function backoffTime (attempt) {
        var backoff = Math.pow(2, attempt);
        var maxBackoffTime = 32000;
        var randomOffset = Math.random() * 10;
        return Math.min(backoff, maxBackoffTime) + randomOffset;
      }
    }
  }
}
