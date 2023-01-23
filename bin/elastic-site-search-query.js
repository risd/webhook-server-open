#!/usr/bin/env node

/*

site=start-here,1risd,1systems
token=e443836a-ca8d-4c05-b4b4-18f7acd27ac2
query=qa
page=1
typeName=galleries

*/
const argv = require('minimist')(process.argv.slice(2), {
  alias: {
    n: 'siteName',
    q: 'query',
    c: 'contentType',
    i: 'id',
    o: 'oneOff',
  },
  default: {
    page: 1,
    pageSize: 10,
  },
})
const grunt = require( 'grunt' )
const webhookTasks = require( '../Gruntfile.js' )
const Elastic = require( 'webhook-elastic-search' )

webhookTasks(grunt)

const elastic = Elastic(grunt.config.get('elastic'))

;(async () => {
  const results = await elastic.queryIndex({
    siteName: argv.siteName,
    contentType: argv.contentType,
    query: argv.query,
    page: argv.page,
    pageSize: arge.pageSize,
  })
  console.log(results)
})()
