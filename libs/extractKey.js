var fs = require('fs');
var _ = require('lodash');

/*
* Extracts the SSH key for a google service account from the JSON provided by google
*
* @param file   The file to extract from
* @param config The Grunt Config
* @param logger The logger (deprecated)
*/
module.exports.start = function (file, config, logger) {
  if(!file) {
    console.log('Error, no file specified. Please specify with --file option.');
    return;
  }

  var contents = fs.readFileSync(file).toString();
  var obj = JSON.parse(contents);

  var keyFile = fs.writeFileSync(__dirname + '/keyfile.key', obj.private_key);

  console.log('Keyfile written');
};

