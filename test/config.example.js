const date = new Date().getTime()
module.exports = {
  backupExtractor: {
    timestamp: 1509019203226,
  },
  cloudStorage: {
    bucketName: `bucket-${date}`,
  },
  creater: {
    siteName: `site-${date}`,
    userId: 'admin@domain.com',
  },
}
