const { createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

module.exports = async function fetchToFile ({ url, localFile }) {
  const res = await fetch(url)
  await finished(
    Readable.fromWeb(res.body)
      .pipe(createWriteStream(localFile)))
}