var testOptions = require( '../env-options.js' )()
var fs = require( 'fs' )
var mime = require( 'mime' )
var path = require( 'path' )
var test = require( 'tape' )
var grunt = require( 'grunt' )
var request = require( 'request' )
var webhookTasks = require( '../../Gruntfile.js' )

webhookTasks( grunt )

var Server = require( '../../libs/server.js' )
var server = Server.start( grunt.config, console.log )
var serverUrl = `http://localhost:${ server.port }`

var Firebase = require( '../../libs/firebase/index.js' )
var firebase = Firebase( grunt.config().firebase )

var siteName = testOptions.serverSiteName
// get these variables based on the database
var siteToken;
var backupTimestamp;

test( 'get-vars-for-server-queries', function ( t ) {
  t.plan( 1 )
  // get site token for site established in the `creator` test
  firebase.siteKey( { siteName: siteName } )
    .then( setSiteToken )
    .then( setBackupTimestamp )
    .catch( handleError )

  function setSiteToken ( token ) {
    siteToken = token.val();
    return firebase.backups()
  }

  function setBackupTimestamp ( backupsSnapshot ) {
    var backups = backupsSnapshot.val()
    if ( backups === null ) return handleError( new Error( 'No backups set. Run the backup test before running the server test.' ) )
    backupTimestamp = backups[ Object.keys( backups )[ Object.keys( backups ).length - 1 ] ]

    runTests( testObjects() )
    t.pass( 'Started tests' )
  }

  function handleError ( error ) {
    t.fail( 'Could not start tests' )
    t.end()
  }  
} )

function siteTokenFn () {
  return {
    site: siteName,
    token: siteToken,
  }
}

// RequestOptions : { method, uri, ... }
// ResponseTest : ExpectedValue => TestInjector => MakeAssertions
// TestInjector.testCount : Int
// testObjects => [ req : RequestOptions, res : [ResponseTest] ]
function testObjects () {
  return [
    {
      name: 'GET /',
      req: {
        method: 'GET',
        uri: serverUrlForPath( '/' ),
      },
      res: [ statusCode( 200 ) ],
    },
    {
      name: 'GET /backup-snapshot/',
      req: {
        method: 'GET',
        uri: serverUrlForPath( '/backup-snapshot/' ),
        qs: Object.assign( {
          timestamp: backupTimestamp,
        }, siteTokenFn() ),
      },
      res: [ statusCode( 200 ), jsonBody( siteDataShape ), ],
    },
    {
      name: 'GET /backup-snapshot/ fail',
      req: {
        method: 'GET',
        uri: serverUrlForPath( '/backup-snapshot/' ),
        qs: {},
      },
      res: [ statusCode( 500 ) ],
    },
    {
      name: 'POST /upload-url/',
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/upload-url/' ),
        json: true,
        body: Object.assign( {
          resize_url: true,
          url: 'https://lh3.googleusercontent.com/G6Tkw7hXhmR34zpkXA3nBHZ05tgAb2OewVO5NOrv5LUovd-UIqtaZ3rOoNemzXosxFt4HrQXshJ3UIbDuwQOf2sIjQJcuuGeSalc4QG1E1s=s760',
        }, siteTokenFn() ),
      },
      res: [ statusCode( 200 ), jsonBody( uploadedFileShape ) ],
    },
    {
      name: 'POST /upload-file/', 
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/upload-file/' ),
        headers: {
            'Content-Type': 'multipart/form-data',
        },
        multipart: [ {
          'Content-Disposition': 'form-data; name="payload"; filename="img.png"',
          'Content-Type': mime.lookup( 'img.png' ),
          body: fs.readFileSync( path.join( __dirname, '..', 'files', 'img.png' ) ),
        }, {
          'Content-Disposition': 'form-data; name="site"',
          body: siteTokenFn().site,
        }, {
          'Content-Disposition': 'form-data; name="token"',
          body: siteTokenFn().token,
        }, {
          'Content-Disposition': 'form-data; name="resize_url"',
          body: "true"
        } ],
      },
      res: [ statusCode( 200 ), jsonBody( uploadedFileShape ) ],
    },
    {
      name: 'POST /search/',
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/search/' ),
        json: true,
        body: Object.assign( {
          query: 'home',
        }, siteTokenFn() ),
      },
      res: [ statusCode( 200 ), jsonBody( searchResultsShape ) ],
    },
    {
      name: 'POST /search/index/',
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/search/index/' ),
        json: true,
        body: Object.assign( {}, siteTokenFn(), searchDocument() ),
      },
      res: [ statusCode( 200 ), jsonBody( searchIndexShape ) ],
    },
    {
      name: 'POST /search/delete/',
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/search/delete/' ),
        json: true,
        body: Object.assign( {}, siteTokenFn(), searchDocument() ),
      },
      res: [ statusCode( 200 ), jsonBody( searchIndexShape ) ],
    },
    {
      name: 'POST /search/delete/type/',
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/search/delete/type/' ),
        json: true,
        body: Object.assign( {}, siteTokenFn(), searchDocument() ),
      },
      res: [ statusCode( 200 ), jsonBody( searchIndexShape ) ],
    },
    {
      name: 'POST /search/delete/index/',
      req: {
        method: 'POST',
        uri: serverUrlForPath( '/search/delete/index/' ),
        json: true,
        body: siteTokenFn()
      },
      res: [ statusCode( 200 ), jsonBody( searchIndexShape ) ],
    },
    // {
    //   name: 'POST /upload/',
    //   req: {
    //     method: 'POST',
    //     uri: serverUrlForPath( '/upload/' ),
    //     json: true,
    //     body: Object.assign( {
    //       branch: 'feature/test',
    //       payload: 'file.zip'
    //     }, siteTokenFn() ),
    //   }
    //   res: [ statusCode( 200 ), jsonBody( uploadedFileShape ) ],
    // },
  ]
}

function runTests ( testObjects ) {
  testObjects.forEach( function makeTest ( testSpec ) {
    test( testSpec.name, function ( t ) {
      var testCount = testSpec.res.reduce( resCount, 0 )
      t.plan( testCount )
      runTest( t )( testSpec )
    } )  
  } )
}

test.onFinish( process.exit )


function statusCode ( expected ) {
  function injectTest ( t ) {
    return function testResponse ( testName, error, response, body ) {
      t.assert( expected === response.statusCode, `${ testName}: Status code is ${ response.statusCode }, expected ${ expected }.` )
    }
  }
  injectTest.testCount = 1;
  return injectTest;
}

function jsonBody ( expectedShape ) {
  function injectTest ( t ) {
    return function testResponse ( testName, error, response, body ) {
      var parseError;
      try {
        var payload = typeof body === 'string' ? JSON.parse( body ) : body;  
        t.assert( typeof payload === 'object', `${ testName }: Body is JSON` )
      }
      catch ( jsonParseError ) {
        parseError = jsonParseError
        t.fail( `${ testName }: Body is not JSON` )
      }
      
      if ( ! error && ! parseError && expectedShape ) {
        t.assert( expectedShape( payload ), `${ testName }: Body conforms to shape.` )
      }
      else if ( expectedShape ) {
        t.fail( `${ testName }: Body not an object, could not test shape.` )
      }
    }
  }
  injectTest.testCount = expectedShape ? 2 : 1 ;
  return injectTest;
}

function siteDataShape ( obj ) {
  return obj.hasOwnProperty( 'contentType' ) &&
         obj.hasOwnProperty( 'data' ) &&
         obj.hasOwnProperty( 'settings' )
}

function uploadedFileShape ( obj ) {
  return obj.hasOwnProperty( 'message' ) &&
         obj.hasOwnProperty( 'url' ) &&
         obj.hasOwnProperty( 'size' ) &&
         obj.hasOwnProperty( 'mimeType' )
}

function searchResultsShape ( obj ) {
  return obj.hasOwnProperty( 'hits' )
}

function searchIndexShape ( obj ) {
  return obj.hasOwnProperty( 'message' )
}

function searchDocument () {
  return {
    data: JSON.stringify( { name: 'test-title' } ),
    id: 'one-off-page',
    typeName: 'pages',
    oneOff: true,
  }
}


// helpers

function countTests ( count, testObject ) {
  return count + testObject.res.reduce( resCount, 0 )
}

function resCount ( resCount, resFn ) {
  return resCount + resFn.testCount;
}

function runTest ( t ) {
  return makeRequest;

  function makeRequest( options ) {
    request( options.req, handleResponse )

    function handleResponse ( error, response, body ) {
      options.res.map( testInjector ).map( runAssertions )

      function runAssertions ( makeAssertions ) {
        makeAssertions( options.name, error, response, body )
      }
    }
  }

  function testInjector ( resExpectedValue ) {
    return resExpectedValue( t )
  }
}

function serverUrlForPath ( path ) {
  return `${ serverUrl }${ path }`
}
