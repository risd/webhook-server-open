const date = dateString()

module.exports = {
  cloudStorage: {
    bucket: () => {
      return `automated-server-cloud-storage-test-bucket-${date}.risd.systems`
    },
  },
}

function dateString () {
  return new Date().getTime()
}
