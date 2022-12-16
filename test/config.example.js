module.exports = {
  cloudStorage: {
    bucketName: () => `bucket-${new Date().getTime()}`,
  },
}
