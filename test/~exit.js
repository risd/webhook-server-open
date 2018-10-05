var test = require( 'tape' )
test( 'exit', function ( t ) {
  t.plan( 1 )
  t.assert( true, 'will-exit')
} )

test.onFinish( function ( fn ) {
  fn( process.exit )
} )
