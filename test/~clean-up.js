var testOptions = require( './env-options.js' )()
var grunt = require( 'grunt' )
var async = require( 'async' )
var test = require( 'tape' )
var webhookTasks = require( '../Gruntfile.js' )

webhookTasks( grunt )

var Firebase = require( '../libs/firebase/index.js' )
var firebase = Firebase( grunt.config.get( 'firebase' ) )

test( 'delete-created-site', function ( t ) {
  t.plan( 1 )

  deleteSite( testOptions.createSiteName, deleteHandler )

  function deleteHandler ( error ) {
    t.assert( ! error, 'Deleted all firebase site paths without error.' )
  }
} )

test.onFinish( process.exit )

function deleteSite ( siteName, callback ) {

  async.parallel( removePaths( firebaseSitePaths( siteName ) ), callback )

  function removePaths ( pathsObject ) {
    return Object.keys( pathsObject ).map( pathKeyToRemovePathTask )

    function pathKeyToRemovePathTask ( pathKey ) {
      return function removePathTask ( taskComplete ) {
        firebase.database().ref( pathsObject[ pathKey ] ).remove( taskComplete )
      }
    }
  }
}

function firebaseSitePaths ( siteName ) {
  return {
    management: `management/sites/${ siteName }`,
    billing: `billing/sites/${ siteName }`,
    buckets: `buckets/${ siteName }`,
  }
}
