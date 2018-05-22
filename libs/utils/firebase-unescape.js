module.exports = function firebaseUnescape ( str ) {
  return str.replace( /,1/g, '.' )
}
