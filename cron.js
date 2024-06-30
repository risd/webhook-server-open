const { CronJob } = require('cron')
let grunt = require( 'grunt' )
const webhookTasks = require( './Gruntfile.js' )
const backup = require('./libs/backup.js')

webhookTasks(grunt)

const job = new CronJob(
  '0 0 * * * *', // cronTime
  function () {
    backup.start(grunt.config)
      .then(({ file, timestamp }) => {
        console.log('backup-complete')
        console.log({ file, timestamp })
      })
      .catch((error) => {
        console.log('bacup-error')
        console.log(error)
      })
  }, // onTick
  null, // onComplete
  true, // start
  'America/New_York' // timeZone
)
