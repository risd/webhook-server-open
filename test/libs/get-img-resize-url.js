const config = require('../config')
const test = require('tape')
const grunt = require('grunt')

require('../../Gruntfile.js')(grunt)

const GetImgResizeUrl = require('../../libs/utils/get-img-resize-url.js')

const googleProjectId = grunt.config.get('googleProjectId')

// if we are actively developing we can produce our own endpoints here
// otherwise, lean on `serviceUrlFromGoogleProjectId`
// const resizeServiceUrl = `http://localhost:49354`
const resizeServiceUrl = `https://20230717t144724-dot-mgcp-1039568-risd-web-prod.appspot.com`

const getImgResizeUrl = GetImgResizeUrl()
getImgResizeUrl.serviceUrlFromGoogleProjectId(googleProjectId)
// getImgResizeUrl.serviceUrl(resizeServiceUrl)

test('get-url', async (t) => {
  try {
    const {imageUrl} = config.getImgResizeUrl
    const url = await getImgResizeUrl(imageUrl)
    console.log(url)
    t.ok(true)
  }
  catch (error) {
    console.log(error)
    t.fail(error)
  }
  finally {
    t.end()
  }
})
