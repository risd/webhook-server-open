var ElasticSearch = require('elasticsearch');
var unescape = require( '../utils/firebase-unescape.js' )

module.exports = WHElasticSearch;

function WHElasticSearch ( options ) {
  if ( ! ( this instanceof WHElasticSearch ) ) return new WHElasticSearch( options )

  options.apiVersion = '6.6';

  options.httpAuth = `${ options.auth.username }:${ options.auth.password }`

  this._client = new ElasticSearch.Client( options )

  this._globalTypeName = '_doc';
}

WHElasticSearch.prototype.search = Search;
WHElasticSearch.prototype.index = Index;
WHElasticSearch.prototype.deleteDocument = DeleteDocument;
WHElasticSearch.prototype.deleteType = DeleteType;
WHElasticSearch.prototype.deleteSite = DeleteSite;

function Search ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var query = options.query;
  var page = options.page;
  var typeName = options.typeName;

  if ( ! query.endsWith( '*' ) ) {
    query = query + '*';
  }

  if ( ! query.startsWith( '*' ) ) {
    query = '*' + query;
  }

  if( page < 1 ) {
    page = 1;
  }

  var queryObject = {
    "from": ( page - 1 ) * 10,
    "size": 10,
    // "fields": [ 'doc.name' , 'oneOff' ],
    "highlight" : { "fields" : { "*" : {} }, "encoder": "html" },
  }

  if ( typeName ) {
    queryObject.query = {
      "bool": {
        "must": {
            "query_string": {
              // "fields": [ "doc.name^5", "_all" ],
              "query": query,
            },
          },
        "filter": {
          "term": {
            "contentType": typeName,
          },
        },
      },
    }
  }
  else {
    queryObject.query = {
      "query_string" : { 
        // "fields" : ["doc.name^5", "_all"],
        "query" : query,
      },
    }
  }

  // var args = [ siteName, queryObject ]
  var args = {
    index: siteName,
    body: queryObject,
  }

  return new Promise ( function ( resolve, reject ) {
    
    
    client.search( args )
      .then( function ( searchResponse ) {
        if ( typeof searchResponse === 'string' ) {
          searchResponse = JSON.parse( searchResponse )
        }

        if ( searchResponse && searchResponse.hits && searchResponse.hits.hits ) {
          var results = searchResponse.hits.hits.map( prepForCMS )
        }
        else if ( searchResponse && ! research.hits ) {
          var results = []
        }

        resolve( results )
      } )
      .catch( function ( error ) {
        reject( error )
      } )
  } )

  function prepForCMS ( result ) {
    // map our custom type back to the CMS expected `_type` key
    result._type = result._source.contentType;
    // map our nested doc.name field to the CMS expected highlight name field
    result.highlight = {
      name: result.highlight[ 'doc.name' ]
        ? result.highlight[ 'doc.name' ]
        : [ result._source.doc.name ],
    }
    result.fields = {
      name: result._source.doc.name,
      __oneOff: result._source.oneOff,
    }
    return result;
  }
}

function Index ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var typeName = options.typeName;
  var id = options.id;
  var doc = options.doc;
  var oneOff = options.oneOff || false;

  var parsedDoc = JSON.parse( doc );
  // parsedDoc.__oneOff = oneOff;
  // parsedDoc.__type = typeName;

  // var args = [ siteName, this._globalTypeName, parsedDoc, id ]
  var args = {
    index: siteName,
    type: this._globalTypeName,
    id: id,
    body: {
      doc: parsedDoc,
      oneOff: oneOff,
      contentType: typeName,
    },
  }

  return new Promise( function ( resolve, reject ) {

    client.index( args )
      .then( function ( indexedResponse ) {
        console.log( 'indexedResponse' )
        console.log( indexedResponse )
        if ( typeof indexedResponse === 'string' ) {
          var indexedData = JSON.parse( indexedResponse )
        }
        else {
          var indexedData = Object.assign( {}, indexedResponse )
        }

        if ( indexedData.error ) {
          reject( new Error( indexedData.error ) )
        }
        else {
          resolve()
        }
      } )
      .catch( function ( error ) {
        reject( error )
      } )

    // var errorValue = null;

    // client.index.apply( client, args )
    //   .on( 'data', function( indexedResponse ) {
    //     if ( typeof indexedResponse === 'string' ) {
    //       indexedData = JSON.parse( indexedResponse )
    //     }
    //     else if ( typeof indexedResponse === 'object' ) {
    //       indexedData = Object.create( indexedResponse )
    //     }

    //     if ( indexedData.error ) {
    //       errorValue = indexedData.error
    //     }
    //   } )
    //   .on( 'error', function ( error ) {
    //     errorValue = error;
    //   } )
    //   .on( 'done', function () {
    //     if ( errorValue === null ) {
    //       resolve()
    //     }
    //     else {
    //       reject( errorValue )
    //     }
    //   } )
    //   .exec()
  } )
}

function DeleteDocument ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var id = options.id;

  // var args = [ siteName, this._globalTypeName, id ]
  var args = {
    index: siteName,
    type: this._globalTypeName,
    id: id,
  }

  return new Promise( function ( resolve, reject ) {
    client.delete( args )
      .then( function ( deleteResponse ) {
        resolve()
      } )
      .catch( function ( error ) {
        reject( error )
      } )

    // client.deleteDocument.apply( client, args )
    //   .on( 'error', function ( error ) {
    //     errorValue = error;
    //   } )
    //   .on( 'done', function () {
    //     if ( errorValue === null ) {
    //       resolve()
    //     }
    //     else {
    //       reject( errorValue )
    //     }
    //   } )
    //   .exec()
  } )
}

function DeleteType ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var typeName = options.typeName;

  // var args = [ siteName, this._globalTypeName ]
  var args = {
    index: siteName,
    body: {
      query: {
        term: {
          contentType: typeName,
        }
      }
    }
  }

  return new Promise( function ( resolve, reject ) {

    client.deleteByQuery( args )
      .then( function ( deleteResponse ) {
        resolve()
      } )
      .catch( function ( error ) {
        reject( error )
      } )

    // var errorValue = null;

    // client.deleteMapping.apply( client, args )
    //   .on( 'error', function ( error ) {
    //     errorValue = error;
    //   } )
    //   .on( 'done', function () {
    //     if ( errorValue === null ) {
    //       resolve()
    //     }
    //     else {
    //       reject( errorValue )
    //     }
    //   } )
    //   .exec()
  } )
}

function DeleteSite ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )

  // var args = [ siteName ]
  var args = { index: siteName }

  return new Promise( function ( resolve, reject ) {

    client.indices.delete( args )
      .then( function ( deleteResponse ) {
        resolve()
      } )
      .catch( function ( error ) {
        reject( error )
      } )

    // var errorValue = null;

    // client.deleteIndex.apply( client, args )
    //   .on( 'error', function ( error ) {
    //     errorValue = error;
    //   } )
    //   .on( 'done', function () {
    //     if ( errorValue === null ) {
    //       resolve()
    //     }
    //     else {
    //       reject( errorValue )
    //     }
    //   } )
    //   .exec()
  } )
}
