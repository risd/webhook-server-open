const config = require('../config')
const test = require('tape')
const grunt = require('grunt')

require('../../Gruntfile.js')(grunt)

const GetImageResizeUrl = require('../../libs/utils/get-image-resize-url.js')

const getImageResizeUrl = GetImageResizeUrl(config.getImageResizeUrl)

test('get-url', async (t) => {
  try {
    const {imageUrl} = config.getImageResizeUrl
    const url = await getImageResizeUrl(imageUrl)
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
