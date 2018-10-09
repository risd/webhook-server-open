var testOptions = require( './env-options.js' )()
var webhookTasks = require( '../Gruntfile.js' )
var grunt = require( 'grunt' )
var test = require( 'tape' )

webhookTasks( grunt )

var inviter = require( '../libs/invite.js' )

grunt.config.merge( { suppressJobQueue: true } )

var inviteOptions = {
  identifier: `${ testOptions.inviteSiteName }-${ testOptions.inviteUser }`,
  payload: {
    from_userid: testOptions.inviteUser,
    userid: namespaceEmail( testOptions.inviteUser ),
    siteref: testOptions.inviteSiteName,
  }
}

test( 'invite-user', function ( t ) {
  t.plan( 1 )

  var mockClient = { put: function () {} }

  inviter.start( grunt.config, grunt.log )
    ( inviteOptions, inviteOptions.identifier, inviteOptions.payload, mockClient, invitedHandler )

  function  invitedHandler ( error ) {
    t.assert( ! error, 'Invited user without error.' )
  }
} )

test.onFinish( process.exit )

function namespaceEmail ( address ) {
  var parts = address.split( '@' )
  return `${ parts[ 0 ] }+invite-test@${ parts[ 1 ] }`
}
