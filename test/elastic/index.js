var test = require( 'tape' )
var grunt = require( 'grunt' )
var webhookTasks = require( '../../Gruntfile.js' )
var WebHookElasticSearchManager = require( 'webhook-elastic-search' )
var WebhookElasticSearchQuery = require( '../../libs/elastic-search/index.js' )

webhookTasks( grunt )

var siteName = 'test.risd.systems'

var elasticOptions = grunt.config().elastic;

var elasticManager = WebHookElasticSearchManager( elasticOptions )
var elasticQuery = WebhookElasticSearchQuery( elasticOptions )

// test( 'site-entries', function ( t ) {
//   t.plan( 1 )
//   getSiteIndex( siteName )
//     .then( function ( siteIndex ) {
//       console.log( siteIndex )
//       t.assert( Array.isArray( siteIndex ), 'Site index is an array of entries' )
//     } )
//     .catch( function ( error ) {
//       console.log( error )
//       t.fail( 'Failed to retrieve site index' )
//     } )
// } )

// test( 'populate-index', function ( t ) {
//   t.plan( 1 )
//   setIndex( { siteName: siteName, siteData: fullData() } )
//     .then( function getSitesIndex ( results ) { return getSiteIndex( siteName ) } )
//     .then( function assertSiteIndex( siteIndex ) {
//       console.log( siteIndex )
//       t.assert( siteIndex.length > 0, 'Site index is populated' )
//     } )
//     .catch( function catchSiteIndexError ( error ) {
//       console.log( error )
//       t.fail( 'Failed to populate index.' )
//     } )
// } )

// test( 'index-item', function ( t ) {
//   t.plan( 1 )

//   elasticQuery.index( {
//     siteName: siteName,
//     typeName: 'teahouses',
//     id: Object.keys( fullData().data.teahouses )[ 0 ],
//     doc: JSON.stringify( fullData().data.teahouses[ Object.keys( fullData().data.teahouses )[ 0 ] ] ),
//     oneOff: false,
//   } )
//     .then( function ( results ) {
//       t.ok( true, 'Successfully got search results for a content type.' )
//     } )
//     .catch( function ( error ) {
//       t.fail( error, 'Failed to get search results for a content type.' )
//     } )
// } )

// test( 'site-search', function ( t ) {
//   t.plan( 1 )
//   
//   elasticQuery.search( {
//     siteName: siteName,
//     query: 'honey bush',
//     page: 1,
//   } )
//     .then( function ( results ) {
//       if ( results && results.hits && results.hits.hits ) {
//         console.log( 'results.hits.hits' )
//         console.log( results.hits.hits )
//       }
//       else if ( results && results.hits ) {
//         console.log( 'results.hits' )  
//         console.log( results.hits )  
//       }
      
//       t.ok( 'Successfully got search results without a content type.' )
//     } )
//     .catch( function ( error ) {
//       console.log( error )
//       if ( error && error.body && error.body.error ) {
//         console.log( 'error.body.error' )
//         console.log( error.body.error )
//       }
//       t.fail( 'Failed to get search results without a content type.' )
//     } )
// } )

// test( 'site-search-with-type', function ( t ) {
//   t.plan( 1 )
//   elasticQuery.search( {
//     siteName: siteName,
//     query: 'vanilla',
//     typeName: 'teas',
//     page: 1,
//   } )
//     .then( function ( results ) {
//       if ( results && results.hits && results.hits.hits ) {
//         console.log( 'results.hits.hits' )
//         // console.log( results.hits.hits )
//         // console.log( results.hits.hits.map( (d) => d._source.doc ) )
//         console.log( results.hits.hits.map( (d) => d._source.doc.name ) )
//       }
//       else if ( results && results.hits ) {
//         console.log( 'results.hits' )  
//         console.log( results.hits )  
//       }
//       t.ok( results.hits.hits.length === 1, 'Successfully got search results for a content type.' )
//     } )
//     .catch( function ( error ) {
//       console.log( error )
//       t.fail( error, 'Failed to get search results for a content type.' )
//     } )
// } )

// test( 'site-search-with-type-one-hit', function ( t ) {
//   t.plan( 1 )
//   elasticQuery.search( {
//     siteName: siteName,
//     query: 'providence',
//     typeName: 'teahouses',
//     page: 1,
//   } )
//     .then( function ( results ) {
//       t.ok( results.hits.hits.length === 1, 'Successfully got search results for a content type.' )
//     } )
//     .catch( function ( error ) {
//       console.log( error )
//       t.fail( 'Failed to get search results for a content type.' )
//     } )
// } )

// test( 'delete-type', function ( t ) {
//   t.plan( 1 )

//   elasticQuery.deleteType( {
//     siteName: siteName,
//     typeName: 'teas',
//   } )
//     .then( function () {
//       t.ok( true, 'Successfully deleted type.' )
//     } )
//     .catch( function ( error ) {
//       t.fail( error, 'Failed to delete type.' )
//     } )
// } )

// test( 'empty-index', function ( t ) {
//   t.plan( 1 )
//   setIndex( { siteName: siteName, siteData: emptyData() } )
//     .then( function ( results ) {
//       return getSiteIndex( siteName )
//     } )
//     .then( function ( siteIndex ) {
//       t.assert( siteIndex.length === 0, 'Empty array for siteIndex.' )
//     } )
//     .catch( function ( error ) {
//       t.fail( 'Failed to empty index.' )
//     } )
// } )

// test( 'delete-site-index', function ( t ) {
//   t.plan( 1 )

//   elasticQuery.deleteSite( { siteName: siteName } )
//     .then( function () {
//       t.ok( true, 'Successfully deleted site index.' )
//     } )
//     .catch( function ( error ) {
//       console.log( error )
//       t.fail( error, 'Failed to delete site index.' )
//     } )
// } )

function setIndex ( options ) {
  var siteName = options.siteName;
  var siteData = options.siteData;
  return getSiteIndex( siteName )
    .then( function ( siteIndex ) {
      return updateSiteIndex( Object.assign( options, { siteIndex: siteIndex } ) )
    } )
    .then( function ( results ) {
      return Promise.resolve( results )
    } )
    .catch( function ( error ) {
      return Promise.reject( error )
    } )
}

function getSiteIndex ( siteName ) {
  return new Promise( function getSiteIndex ( resolve, reject ) {
    elasticManager.siteEntries( siteName, function ( error, siteIndex ) {
      if ( error ) return reject( error )
      resolve( siteIndex )
    } )
  } )
}

function updateSiteIndex ( options ) {
  var siteName = options.siteName;
  var siteData = options.siteData;
  var existingSiteIndex = options.siteIndex;

  return new Promise ( function ( resolve, reject) {
    elasticManager.updateIndex( options, function ( error, results ) {
      if ( error ) return reject( error )
      resolve( results )
    } )
  } )
}


function emptyData () {
  return { data: {}, contentType: {} }
}

function fullData () {
  return {
    "data": {
      "gradshow": {
        "_sort_create_date": 1548190320,
        "_sort_last_updated": 1548190320,
        "create_date": "2019-01-22T15:52:00-05:00",
        "last_updated": "2019-01-22T15:52:00-05:00",
        "name": "gradshow",
        "preview_url": "d759f405-20cf-6d9e-ce3e-e6229a27efdf"
      },
      "teahouses": {
        "-LXKeZZ_9G9t6P77vc_L": {
          "_sort_create_date": 1548699180,
          "_sort_last_updated": 1548699180,
          "_sort_publish_date": 1548699180,
          "create_date": "2019-01-28T13:13:00-05:00",
          "last_updated": "2019-01-28T13:13:00-05:00",
          "name": "Tealuxe",
          "preview_url": "32aa1204-5cc5-32a4-129b-5f876cbb2115",
          "publish_date": "2019-01-28T13:13:00-05:00",
          "address": "200 thayer st, providence, ri"
        }
      },
      "teas": {
        "-LXW51IDNwFTJDvZ-LYr": {
          "_sort_create_date": 1548890940,
          "_sort_last_updated": 1548890940,
          "_sort_publish_date": 1548890940,
          "create_date": "2019-01-30T18:29:00-05:00",
          "last_updated": "2019-01-30T18:29:00-05:00",
          "name": "vanilla honey bush",
          "preview_url": "29a2b093-730e-fb4d-ff08-825e005c07d4",
          "publish_date": "2019-01-30T18:29:00-05:00"
        },
        "-LXW56589LNe8ScrCXAV": {
          "_sort_create_date": 1548890940,
          "_sort_last_updated": 1548890940,
          "_sort_publish_date": 1548890940,
          "create_date": "2019-01-30T18:29:00-05:00",
          "last_updated": "2019-01-30T18:29:00-05:00",
          "name": "silver tips white tea",
          "preview_url": "dccd4614-eec7-1db0-ad26-f1b9372d6749",
          "publish_date": "2019-01-30T18:29:00-05:00"
        }
      }
    },
    "contentType": {
      "gradshow": {
        "controls": [
          {
            "controlType": "textfield",
            "hidden": false,
            "label": "Name",
            "locked": true,
            "name": "name",
            "required": true,
            "showInCms": true
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Create Date",
            "locked": true,
            "name": "create_date",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Last Updated",
            "locked": true,
            "name": "last_updated",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "textfield",
            "hidden": true,
            "label": "Preview URL",
            "locked": true,
            "name": "preview_url",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "textfield",
            "hidden": true,
            "label": "Slug",
            "locked": true,
            "name": "slug",
            "required": false,
            "showInCms": false
          }
        ],
        "name": "gradshow",
        "oneOff": true,
        "oneOffMD5": "54a3c2f81b88c103aecff99cb1132cf0"
      },
      "teahouses": {
        "controls": [
          {
            "controlType": "textfield",
            "hidden": false,
            "label": "Name",
            "locked": true,
            "name": "name",
            "required": true,
            "showInCms": true
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Create Date",
            "locked": true,
            "name": "create_date",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Last Updated",
            "locked": true,
            "name": "last_updated",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Publish Date",
            "locked": true,
            "name": "publish_date",
            "required": false,
            "showInCms": false
          },
          {
            "controlType": "relation",
            "hidden": false,
            "label": "Teas in Stock",
            "locked": false,
            "meta": {
              "contentTypeId": "teas",
              "reverseName": "tea_houses_teas_in_stock"
            },
            "name": "teas_in_stock",
            "required": false,
            "showInCms": true
          },
          {
            "controlType": "textfield",
            "hidden": true,
            "label": "Preview URL",
            "locked": true,
            "name": "preview_url",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "textfield",
            "hidden": true,
            "label": "Slug",
            "locked": true,
            "name": "slug",
            "required": false,
            "showInCms": false
          }
        ],
        "individualMD5": "a0a25bc6e15cb5aff97cecddddc34056",
        "listMD5": "a2264252891bb1d75ccb27bdeefa7233",
        "name": "Tea Houses",
        "oneOff": false
      },
      "teas": {
        "controls": [
          {
            "controlType": "textfield",
            "hidden": false,
            "label": "Name",
            "locked": true,
            "name": "name",
            "required": true,
            "showInCms": true
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Create Date",
            "locked": true,
            "name": "create_date",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Last Updated",
            "locked": true,
            "name": "last_updated",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "datetime",
            "hidden": true,
            "label": "Publish Date",
            "locked": true,
            "name": "publish_date",
            "required": false,
            "showInCms": false
          },
          {
            "controlType": "grid",
            "controls": [
              {
                "controlType": "textfield",
                "hidden": false,
                "label": "headline",
                "locked": false,
                "name": "headline",
                "required": false,
                "showInCms": true
              },
              {
                "controlType": "wysiwyg",
                "hidden": false,
                "label": "body",
                "locked": false,
                "meta": {
                  "image": true,
                  "javascript": true,
                  "link": true,
                  "quote": true,
                  "table": true,
                  "video": true
                },
                "name": "body",
                "required": false,
                "showInCms": true
              }
            ],
            "hidden": false,
            "label": "narrative",
            "locked": false,
            "name": "narrative",
            "required": false,
            "showInCms": true
          },
          {
            "controlType": "textfield",
            "hidden": true,
            "label": "Preview URL",
            "locked": true,
            "name": "preview_url",
            "required": true,
            "showInCms": false
          },
          {
            "controlType": "textfield",
            "hidden": true,
            "label": "Slug",
            "locked": true,
            "name": "slug",
            "required": false,
            "showInCms": false
          },
          {
            "controlType": "relation",
            "hidden": false,
            "label": "Tea Houses (Teas in Stock)",
            "locked": false,
            "meta": {
              "contentTypeId": "teahouses",
              "reverseName": "teas_in_stock"
            },
            "name": "tea_houses_teas_in_stock",
            "required": false,
            "showInCms": false
          }
        ],
        "individualMD5": "53c6d6b54ac8c591beaf8d4be2c0d657",
        "listMD5": "685a8043484c5d580398218bc497910a",
        "name": "teas",
        "oneOff": false
      }
    }
  }
}
