#!/usr/bin/env node

/*

site=start-here,1risd,1systems
token=e443836a-ca8d-4c05-b4b4-18f7acd27ac2
query=qa
page=1
typeName=galleries

*/
var grunt = require( 'grunt' )
var webhookTasks = require( '../Gruntfile.js' )
var WHElasticSearch = require( '../libs/elastic-search/index.js' )

webhookTasks( grunt )

var elastic = WHElasticSearch( grunt.config().elastic )

const options = {
  siteName: 'start-here,1risd,1systems',
  query: 'gallery',
  page: 1,
  typeName: 'galleries',
}

elastic.search( options )
  .then( handleSearch )
  .catch( handleSearchError )

function handleSearch ( results ) {
  console.log( 'handle-search' )
  console.log( results )
  if ( results.error ) {
    console.log( results.error )
  }
}

function handleSearchError ( error ) {
  console.log( error )
}
