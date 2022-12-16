const date = new Date().getTime()
module.exports = {
  cloudStorage: {
    bucketName: `bucket-${date}`,
  },
  creater: {
    siteName: `site-${date}`,
    userId: 'admin@domain.com',
  },
}
