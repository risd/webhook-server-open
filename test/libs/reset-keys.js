var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var resetKeys = require( '../../libs/reset-keys.js' )

webhookTasks( grunt )

Error.stackTraceLimit = Infinity;

// test('reset-keys', async function (t) {
//   try {
//     await resetKeys({
//       config: grunt.config,
//     })
//     t.ok(true, 'reset keys')
//   }
//   catch (error) {
//     console.error(error)
//     t.ok(fail, 'reset keys : error')
//   }
//   t.end()
// })

test.onFinish( process.exit )
