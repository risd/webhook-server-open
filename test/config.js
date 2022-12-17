const date = dateString()

module.exports = {
  backupExtractor: {
    timestamp: 1509019203226,
    keyPath: ['buckets', 'commencement,1risd,1systems', 'd1b96975-edd0-4f8c-af62-cf05d134f28a', 'dev'],
  },
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
