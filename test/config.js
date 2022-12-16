const date = dateString()

module.exports = {
  cloudStorage: {
    bucket: `automated-server-cloud-storage-test-bucket-${date}.risd.systems`,
  },
  creator: {
    siteName: `automated-server-creator-test-${date}.risd.systems`,
    userId: 'rrodrigu@risd.edu',
    deploy: {
      bucket: `automated-server-creator-test-${date}.risd.systems`
    },
  },
}

function dateString () {
  return new Date().getTime()
}
