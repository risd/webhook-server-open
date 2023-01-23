module.exports = function chainCallbackResponse (chain, callback) {
  chain.then((results) => {
    return callback(null, results)
  })
  .catch((error) => {
    return callback(error)
  })
}