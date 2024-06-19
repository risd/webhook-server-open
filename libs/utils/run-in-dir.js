const debug = require("debug")("run-in-dir")
const { spawn } = require("node:child_process")

module.exports = runInDir

function runInDir (command, args = [], options = { cwd: process.cwd() }) {
  if (!command)
    throw new Error(
      "runInDir requires a `command` key that expresses what command to run."
    )

  return new Promise((resolve, reject) => {
    debug("command:", command)
    debug("args:", args)
    debug("options:", options)
    const cmd = spawn(command, args, options)

    let stdout = ""
    let stderr = ""

    // stderror
    cmd.stdout.setEncoding("utf8")
    cmd.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    cmd.stderr.setEncoding("utf8")
    cmd.stderr.on("data", (d) => {
      stderr += d.toString()
    })

    cmd.on("close", (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        const e = new Error(
          `Error running\ncommand: ${command}\nargs=${args}\noptions=${JSON.stringify(options)}`
        )
        e.stack = `stdout=${stdout}\nstderr=${stderr}\n${e.stack}`
        reject(e)
      }
    })
  })
}
