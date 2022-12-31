const debug = require("debug")("run-build-emitter")
const path = require('node:path')
const { fork } = require("node:child_process")
const { redirectTemplateForDestination } = require('../utils')

const BUILD_EVENT = 'build:document-written:./.build/'

module.exports = runInDir

function runBuildEmitter ({ builtFolder, bucketSpec }) {
  return miss.through.obj(function (cmd, enc, next) {
    const stream = this
    console.log('run-build-emitter')
    console.log(cmd)
    const p = fork(...cmd)
    p.on('message', (msg) => {
      console.log(msg)
      if (!msg.startsWith(BUILD_EVENT)) return
      let builtFile = msg.trim().slice(BUILD_EVENT.length)
      const builtFilePath = path.join(builtFolder, builtFile)

      if (builtFile.endsWith('.html') && (!builtFile.endsWith('index.html')) && (!builtFile.endsWith( '404.html'))) {
        // html pages that aren't already an index.html file, or the root 404.html file
        builtFile = htmlAsIndexFile(builtFile)
      }

      stream.push({
        builtFile,
        builtFilePath,
        bucket: bucketSpec,
      })

      if (builtFile.endsWith('/index.html')) {
        stream.push({
          builtFile: builtFile.replace('/index.html', ''),
          builtFilePath: redirectTemplateForDestination('/' + builtFile.replace('index.html', '')),
          bucket: bucketSpec,
        })
      }
    })
    p.on('exit', (exitCode) => {
      if (exitCode === 0) next()
      else next(new Error(`Error in build: ${JSON.stringify(cmd)}`))
    })
  })
}

function htmlAsIndexFile (file) {
  // file = path/to/doc.html
  // return file = path/to/doc/index.html
  return file.slice(0, ('.html'.length * -1)) + '/index.html'
}