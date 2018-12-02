module.exports = function firebaseEscape ( str ) {
  return str.replace( /\./g, ',1' )
}
