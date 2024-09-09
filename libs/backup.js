/**
* The backup worker is meant to run as a cron job that runs periodically.
* It downloads the full JSON data from the firebase that contains all the sites
* then uploads it to the backup bucket in google cloud storage. This way we
* have a full backup of all the sites/information/users that we can restore
* if we need to
*/

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const axios = require('axios')
const cloudStorage = require( './cloudStorage.js' )
const Firebase = require( './firebase/index.js' )
const {JWT} = require('google-auth-library')
const path = require('path')
const {pipeline} = require('node:stream')

const fileNameForTimestamp = (timestamp) => {
  return `backup-${timestamp}`
}

module.exports.fileNameForTimestamp = fileNameForTimestamp

/**
* @params config The configuration from Grunt
*/
module.exports.start = async function (config) {

  // Necessary setup for cloud storage module
  cloudStorage.configure(config.get('cloudStorage'))

  const firebase = Firebase(config.get('firebase'))
  const bucket = config.get('backupBucket')
  const timestamp = Date.now()
  const file = fileNameForTimestamp(timestamp)

  const serviceAccount = config.get('cloudStorage').credentials

  const gcloudClient = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: [
      'https://www.googleapis.com/auth/devstorage.full_control',
      'https://www.googleapis.com/auth/siteverification'
    ],
  })
  const gcloudCredentials = await gcloudClient.authorize()
  const gcloudAccessToken = gcloudCredentials.access_token

  const backupUrl = await firebase.backupUrl()

  const backupResponseStream = await axios({
    method: 'get',
    url: backupUrl,
    responseType: 'stream',
  })

  const promisePipeline = (...streams) => {
    return new Promise((resolve, reject) => {
      pipeline(...streams, (error) => {
        if (error) return reject(error)
        resolve()
      })
    })
  }

  await promisePipeline(
    backupResponseStream.data,
    fs.createWriteStream(file)
  )

  await cloudStorage.objects.upload({
    bucket,
    local: file,
    remote: file,
    overrideMimeType: 'application/json',
  })

  await fsp.unlink(file)

  await firebase.backups({ push: true }, timestamp)

  const backupsLogSnapshot = await firebase.backups()
  const backupsLog = backupsLogSnapshot.val()

  const backupKeys = Object.keys(backupsLog)
  if (backupKeys.length < 30) {
    // we have less than 30 backups, we can return here
    return { file, timestamp }
  }

  const oldestBackupKey = backupKeys[0]
  const oldestBackupTimestamp = backupsLog[oldestBackupKey]

  await firebase.backups({ key: oldestBackupKey }, null)
  await cloudStorage.objects.del({
    bucket,
    file: fileNameForTimestamp(oldestBackupTimestamp)
  })

  return { file, timestamp }
}
