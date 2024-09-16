const date = new Date().getTime()
const siteName = `automated-server-creator-test-${date}.domain.com`

module.exports = {
  backupExtractor: {
    timestamp: 1509019203226,
  },
  cloudStorage: {
    bucketName: `bucket-${date}`,
  },
  creator: {
    cwd: path.join(process.cwd(), 'test', 'createSiteDir'),
    siteName,
    userId: 'admin@domain.com',
    deploy: {
      bucket: `automated-server-creator-test-${date}.domain.com`
    },
  },
  builder: {
    buildFolder: path.join(process.cwd(), 'test', 'build-folders'),
    buildOptions: {
      siteName: 'start-here,1domain,1com',
      branch: 'feature/node-16',
      siteBucket: 'node-16-start-here.domain.com',
      userId: 'admin@domain.com',
    },
  },
  wh: {
    config: `/Users/admin/.webhook/wh-next.json`,
    opts: {
      email: 'admin@domain.com',
      password: '',
    },
  },
  fastly: {
    addDomain: 'new.domain.com',
    doNotAddDomain: 'test.domain.com',
    mapDomain: {
      maskDomain: 'test-mask.domain.com',
      contentDomain: 'test-content.domain.com',
    },
  },
  invite: {
    userId: 'new-user@domain.com',
    fromUser: 'admin@domain.com',
  },
  domainMapper: {
    siteName,
    contentDomain: siteName,
    maskDomain: `mask-${siteName}`,
  },
  searchIndex: {
    siteName,
  },
  deploySet: {
    bucketSet: 'deploy-bucket.domain.com',
    branch: 'master',
  },
  getImageResizeUrl: {
    appEngine: {
      projectId: '',
      version: '',
    },
    imageUrl: '',
  },
}
