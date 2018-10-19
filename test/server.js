var testOptions = require( './env-options.js' )()
var test = require( 'tape' )
var grunt = require( 'grunt' )
var request = require( 'request' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt )

var Server = require( '../libs/server.js' )
var server = Server.start( grunt.config, console.log )
var serverUrl = `localhost:${ server.port }`

// method : GET, url : /
test( '/', function ( t ) {} )

// method : GET, url : /backup-snapshot/, qs : { token, site, timestamp }
test( '/backup-snapshot/', function ( t ) {} )

// method : POST, url : /upload-url/, json : true, body : { site, token, resize_url, url }
test( '/upload-url/' function ( t ) {} )

// method : POST, url : /upload-file/, json : true, body : { site, token, resize_url, files : { payload } }
test( '/upload-file/', function ( t ) {} )

// method : POST, url : '/search/', json : true, body : { site, token, query, page?, typeName? }
test( '/search/', function ( t ) {} )

// method : POST, url : '/search/index/', json : true, body : { site, token, data, id, typeName, oneOff? }
test( '/search/index/', function ( t ) {} )

// method : POST, url : '/search/delete/', json : true, body : { site, token, id, typeName }
test( '/search/delete/', function ( t ) {} )

// method : POST, url : /search/delete/type/, json : true, body : { site, token, typeName }
test( '/search/delete/type/', function ( t ) {} )

// method : POST, url : /search/delete/index/, json : true, body : { site, token }
test( '/search/delete/index/', function ( t ) {} )

// method : POST, url : /upload/, json : true, body : { site, token, branch, files : { payload }  }
test( '/upload/', function ( t ) {} )

test.onFinish( process.exit )

function makeRequest () {
  url = `${ serverUrl }${ url }`
}
