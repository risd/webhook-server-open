var ElasticSearchClient = require('elasticsearchclient');
var unescape = require( '../utils/firebase-unescape.js' )

module.exports = WHElasticSearch;

function WHElasticSearch ( options ) {
  if ( ! ( this instanceof WHElasticSearch ) ) return new WHElasticSearch( options )

  options.host = options.host
    .replace( 'http://' , '' )
    .replace( 'https://' , '' )
    .split( ':' )[ 0 ]

  this._client = new ElasticSearchClient( options )
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
    "query" : {
      "query_string" : { 
        "fields" : ["name^5", "_all"],
        "query" : query 
      }
    },
    "from": ( page - 1 ) * 10,
    "size": 10,
    "fields": [ 'name' , '__oneOff' ],
    "highlight" : { "fields" : { "*" : {} }, "encoder": "html" }
  }

  if ( typeName ) {
    var args = [ siteName, typeName, queryObject ]
  }
  else {
    var args = [ siteName, queryObject ]
  }

  return new Promise ( function ( resolve, reject ) {
    client.search.apply( client, args )
      .on( 'data', function ( data ) {
        resolve( JSON.parse( data ) )
      } )
      .on( 'error', function ( error ) {
        reject( error )
      } )
      .exec()
  } )
}

function Index ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var typeName = options.typeName;
  var id = options.id;
  var doc = options.doc;
  var oneOff = options.oneOff || false;

  var parsedDoc = JSON.parse( doc );
  parsedDoc.__oneOff = oneOff;

  var args = [ siteName, typeName, parsedDoc, id ]

  return new Promise( function ( resolve, reject ) {
    var errorValue = null;

    client.index.apply( client, args )
      .on( 'data', function( indexedResponse ) {
        if ( typeof indexedResponse === 'string' ) {
          indexedData = JSON.parse( indexedResponse )
        }
        else if ( typeof indexedResponse === 'object' ) {
          indexedData = Object.create( indexedResponse )
        }

        if ( indexedData.error ) {
          errorValue = indexedData.error
        }
      } )
      .on( 'error', function ( error ) {
        errorValue = error;
      } )
      .on( 'done', function () {
        if ( errorValue === null ) {
          resolve()
        }
        else {
          reject( errorValue )
        }
      } )
      .exec()
  } )
}

function DeleteDocument ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var typeName = options.typeName;
  var id = options.id;

  var args = [ siteName, typeName, id ]

  return new Promise( function ( resolve, reject ) {
    var errorValue = null;
    client.deleteDocument.apply( client, args )
      .on( 'error', function ( error ) {
        errorValue = error;
      } )
      .on( 'done', function () {
        if ( errorValue === null ) {
          resolve()
        }
        else {
          reject( errorValue )
        }
      } )
      .exec()
  } )
}

function DeleteType ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )
  var typeName = options.typeName;

  var args = [ siteName, typeName ]

  return new Promise( function ( resolve, reject ) {
    var errorValue = null;

    client.deleteMapping.apply( client, args )
      .on( 'error', function ( error ) {
        errorValue = error;
      } )
      .on( 'done', function () {
        if ( errorValue === null ) {
          resolve()
        }
        else {
          reject( errorValue )
        }
      } )
      .exec()
  } )
}

function DeleteSite ( options ) {
  var client = this._client;

  var siteName = unescape( options.siteName )

  var args = [ siteName ]

  return new Promise( function ( resolve, reject ) {
    var errorValue = null;

    client.deleteIndex.apply( client, args )
      .on( 'error', function ( error ) {
        errorValue = error;
      } )
      .on( 'done', function () {
        if ( errorValue === null ) {
          resolve()
        }
        else {
          reject( errorValue )
        }
      } )
      .exec()
  } )
}
