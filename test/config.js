const path = require('path')
const date = dateString()

const config = {
  backupExtractor: {
    timestamp: 1509019203226,
    keyPath: ['buckets', 'commencement,1risd,1systems', 'd1b96975-edd0-4f8c-af62-cf05d134f28a', 'dev'],
  },
  cloudStorage: {
    bucket: `automated-server-cloud-storage-test-bucket-${date}.risd.systems`,
  },
  creator: {
    cwd: path.join(process.cwd(), 'test', 'createSiteDir')
    siteName: `automated-server-creator-test-${date}.risd.systems`,
    userId: 'rrodrigu@risd.edu',
    deploy: {
      bucket: `automated-server-creator-test-${date}.risd.systems`
    },
  },
  builder: {
    buildFolder: path.join(process.cwd(), 'test', 'build-folders'),
    buildOptions: {
      siteName: 'start-here,1risd,1systems',
      branch: 'feature/node-16',
      bucket: 'node-16-start-here.risd.systems',
      userId: 'rrodrigu@risd.edu',
    },
  },
  wh: {
    config: `/Users/rdr/.risd-media/wh-next.json`,
    opts: {
      email: 'rrodrigu@risd.edu',
      password: 'TxasDq@[cRw72FKtG+7iyTm)Ju',
    },
  },
  fastly: {
    addDomain: 'perpetualhappiness.com',
    doNotAddDomain: 'test.risd.systems',
    mapDomain: {
      maskDomain: 'test.risd.systems',
      contentDomain: '0001.test.risd.systems',
    },
  },
  invite: {
    userId: 'rrodrigu+testinvite@risd.edu',
    from_userid: 'rrodrigu@risd.edu',
  },
  domainMapper: {
    siteName: config.creator.siteName,
    contentDomain: config.creator.siteName,
    maskDomain: `mask-${config.creator.siteName}`,
  },
  searchIndex: {
    siteName: config.creator.siteName,
  },
  deploySet: {
    bucketSet: 'webhook-dev.risd.edu',
    branch: 'master',
  }
}

module.exports = config

function dateString () {
  return new Date().getTime()
}
