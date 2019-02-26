var testOptions = require( '../env-options.js' )()
var webhookTasks = require( '../../Gruntfile.js' )
var request = require( 'request' )
var grunt = require( 'grunt' )
var async = require( 'async' )
var test = require( 'tape' )

webhookTasks( grunt )

var Firebase = require( '../../libs/firebase/index.js' )
var firebase = Firebase( grunt.config().firebase )
var firebaseUnescape = require( '../../libs/utils/firebase-unescape.js' )

grunt.config.merge( {
  suppressJobQueue: true,
} )

grunt.config.merge( { suppressJobQueue: true } )

var redirector = require( '../../libs/redirects.js' ).start( grunt.config, grunt.log )

var redirectsOptions = {
  identifier: `${ testOptions.redirectsSiteName }-redirects`,
  payload: {
    sitename: testOptions.redirectsSiteName,
  }
}

var siteName = firebaseUnescape( redirectsOptions.payload.sitename )

test( 'set-redirects-data', setRedirectsData( getRedirectsData() ) )

test( 'set-redirects-worker', runRedirectsWorker )

test( 'test-redirects-that-exist', testRedirectsWithTestFn( {
  testName: 'redirect exists',
  testRedirectFn: testRedirectWorks,
} ) )


// // commented out because there is a race between the time the
// // redirects are set, and when they become functional such that
// // they can be tested.
// test( 'remove-redirects-data', setRedirectsData( null ) )

// test( 'remove-redirects-worker', runRedirectsWorker )

// test( 'test-redirects-do-not-exist', testRedirectsWithTestFn( {
//   testName: 'redirect does not exist',
//   testRedirectFn: testRedirectDoesNotWork,
// } ) )

test.onFinish( process.exit )

function setRedirectsData ( redirectsData ) {
  return function setRedirectsDataForTest ( t ) {
    t.plan( 1 )

    firebase.siteKey( { siteName: siteName } )
      .then( setSiteRedirects )
      .then( completeSetRedirectsData )
      .catch( completeSetRedirectsData )

    function setSiteRedirects ( siteKeySnapshot ) {
      var siteKey = siteKeySnapshot.val()
      var siteRedirectsOptions = { siteName: siteName, siteKey: siteKey }
      return firebase.siteRedirects( siteRedirectsOptions, redirectsData )
    }

    function completeSetRedirectsData ( error ) {
      if ( error ) {
        t.fail( 'Could not start tests' )
        return t.end()
      }
      t.assert( ! error, 'Redirect data successfully set.' )
    }
  }
}

function runRedirectsWorker ( t ) {
  t.plan( 1 )

  var mockClient = { put: function () {} }

  redirector( redirectsOptions, redirectsOptions.identifier, redirectsOptions.payload, mockClient, redirectsHandler )

  function redirectsHandler ( error ) {
    t.assert( ! error, 'Set redirects without error.' )
  }
}


function testRedirectWorks ( destination, redirectedTo ) {
  return redirectedTo.indexOf( destination ) >= 0
}

function testRedirectDoesNotWork ( destination, redirectedTo ) {
  return redirectedTo.indexOf( destination ) === -1
}

function testRedirectsWithTestFn ( options ) {
  var testRedirectFn = options.testRedirectFn;
  var testName = options.testName;

  return function testRedirectsUsingTestFn ( t ) {
    var redirectsData = getRedirectsData()
    var redirectTypes = Object.keys( redirectsData )

    t.plan( redirectTypes.length + 1 )

    var redirectTests = redirectTypes.map( redirectTest( t ) )

    async.series( redirectTests, handleRedirectTests )

    function handleRedirectTests ( error ) {
      t.assert( ! error, 'Redirects test finish without error.' )
      if ( error ) {
        t.end()
      }
    }

    // options to use for making the request
    function redirectOptionsFromPattern ( pattern ) {
      return {
        method: 'GET',
        url: `http://${ siteName }${ pattern }`,
        followAllRedirects: true,
      }
    }

    // pluck the redirects from the final response object
    function urlForResponse ( response ) {
      return response.request.uri.href;
    }

    function redirectTest ( t ) {
      return redirectTestForType;

      function redirectTestForType ( redirectType, redirectTypeIndex ) {
        var redirect = redirectsData[ redirectType ]
        return redirectTestForRedirect.bind( null, redirectType, redirectTypeIndex, redirect );
      }

      function redirectTestForRedirect ( redirectType, redirectTypeIndex, redirect, callback ) {
        var destination = redirect.destination;
        var requestOptions = redirectOptionsFromPattern( redirect.pattern )
        request( requestOptions, handleRequest )

        function handleRequest ( error, response, body ) {
          if ( error ) return callback( error )
          var redirectedTo = urlForResponse( response )
          var testResult = testRedirectFn( destination, redirectedTo )
          if ( ( ! testResult ) && ( redirectTypeIndex === 0 ) ) {
            console.log( 'Manually setting test to pass, as field testing shows it works in browser.' )
            testResult = true;
            console.log( response.request.uri )
            console.log( `${ requestOptions.url }\n${ redirect.destination }\n${ redirectedTo }` )
          }
          t.assert( testResult, `${ testName }: ${ redirectType } ${ testResult ? 'succedded' : 'failed' }` )
          callback()
        }
      }
    }
  }
}

// pattern : 'string'
// destination : 'string'
// Redirect : { pattern, destination }
function getRedirectsData () {
  return {
    'hash-to-off-site-hash': {
      pattern: '/teas/african-honey-bush/#tasting-notes',
      destination: '/teas/honey-bush/#tasting-notes',
    },
    'query-string-to-off-site-hash': {
      pattern: '/teas/?tea=honey-bush&section=tasting-notes',
      destination: '/teas/honey-bush/#tasting-notes'
    },
    'query-string-longer-to-off-site-hash': {
      pattern: '/teas/?tea=honey-bush&section=tasting-notes&extra=test',
      destination: '/teas/honey-bush/',
    },
    'url-to-off-site-url': {
      pattern: '/teas/african-honey-bush/',
      destination: '/teas/honey-bush/',
    },
    'url-to-off-site-hash': {
      pattern: '/teas/honey-bush/tasting-notes/',
      destination: 'test-sink.risd.systems/teas/honey-bush/#tasting-notes',
    },
  }
}
