'use strict';

/**
* This is the main API used for interacting with Netlify.
* It is used to manage documents published on the CDN.
*/

require( 'dotenv' ).config({
  path: __dirname + '/../.env'
})

var netlify = require( "netlify" )

var rootDomain = 'risd.systems'
var subdomainFrom = function ( domain ) {
  return domain.slice( 0, ( - ( rootDomain.length + 1 ) ) )
}

var netlifyCredentials = {
  client_id: process.env.NETLIFY_CLIENT_ID,
  client_secret: process.env.NETLIFY_CLIENT_SECRET,
}

var siteSecret = process.env.NETLIFY_SITE_SECRET;
var siteNotification = process.env.NETLIFY_SITE_NOTIFICATION;

module.exports = NetlifyCDN;

function NetlifyCDN ( options ) {
  if ( ! ( this instanceof NetlifyCDN ) ) return new NetlifyCDN( options )
  options = options || {}
  var credentials = options.credentials || netlifyCredentials;

  var token = function () {
    var client = netlify.createClient( credentials )
    var request = client.authorizeFromCredentials()

    return request
  }

  var client = function ( callback ) {
    token()
      .then( function ( access_token ) {
        callback( null, netlify.createClient( { access_token: access_token } ) )
      } )
      .catch( function ( error ) {
        callback( error, undefined )
      } )
  }


  var www = function prefix ( domain ) { return [ 'www', domain ].join( '.' ) }
  var sliceRoot = function ( domain ) { return domain.slice( 0, - ( rootDomain.length + 1  ) ) }
  var toName = function ( domain ) {
    return [
      sliceRoot( domain ).replace( /\./g, '-' ),
      'risd-systems',
    ].join( '-' )
  }
  var toDomain = function ( name ) {
    return [
      name.slice( 0, - ( 'risd-systems' + 1 ) )
        .replace( /-/g, '.' ),
      rootDomain,
    ].join( '.' )
  }

  var init = function ( callback ) {
    client( function ( error, netlifyClient ) {
      if ( error ) return callback( error, undefined )

      netlifyClient.createDnsZone( { name: rootDomain } )
        .then( function ( zone ) {
          callback( null, zone )
        } )
        .catch( function ( error ) {
          callback( error, undefined )
        } )
    } )
  }

  var create = function ( domain, callback ) {
    client( function ( error, netlifyClient ) {
      if ( error ) return callback( error, undefined )

      var onRecord = function ( error, record ) {
        console.log( 'create:onrecord:', error )
        console.log( 'create:onrecord:', record )
        callback(  null, site )

      }

      netlifyClient.createSite( {
          name: toName( domain ),
          domain: domain,
          subdomain: sliceRoot( domain ),
        } )
        .then( function siteCreated ( site ) {
          console.log( 'create:sitecreated:site:', site )
          createCname( netlifyClient, function onRecord () {
            update( domain, function ( error, updated ) {
              callback(  null, site )
            } )
          } )
        } )
        .catch( function ( error ) {
          if ( error.data ) error.data = JSON.parse( error.data )
          console.log( 'create:sitecreated:error:', error )
          if ( ( 'subdomain' in error.data ) &&
               ( error.data.subdomain[0] === 'must be unique' ) )
            createCname( netlifyClient, callback )
          else
            callback( error, undefined )
        } )
    } )

    function createCname ( netlifyClient, onRecord ) {
      netlifyClient.dnsZones()
        .then( function ( zones ) {
          var creatingRecord = false;

          zones
            .filter( function ( zone ) {
              return zone.name === rootDomain
            } )
            .forEach( function ( zone ) {
              if ( creatingRecord ) return;
              zone.createRecord( {
                  hostname: 'www',
                  type: 'CNAME',
                  value: domain,
                  ttl: 3600,
                } )
                .then( function ( record ) {
                  // console.log( 'create:record:', record )
                  onRecord( null, record )
                } )
                .catch( function ( error ) {
                  // console.log( 'create:record:error:', error ) 
                  onRecord( error, undefined ) 
                } )

              creatingRecord = true
          } )

          var message = 'Did not create a CNAME record.' +
            '\nPerhaps the DNS zone has not been created?'
          if ( creatingRecord === false )
            onRecord( new Error( message ), undefined )

        } )
        .catch( function ( error ) {
          console.log( 'create:zone:', error )
          onRecord( error, undefined )
        } )
    }
  }

  var deploy = function ( domain, directory, callback ) {
    client( function ( error, netlifyClient ) {
      if ( error ) return callback( error, undefined )

      netlifyClient.sites()
        .then( function ( sites ) {

          var createdDeploy = false

          sites
            .filter( function ( site ) {
              return site.name === toName( domain )
            } )
            .forEach( function ( site ) {
              if ( createdDeploy ) return

              // var deploying = netlifyClient.deploy( {
              //   access_token: access_token,
              //   site_id: toName( domain ),
              //   dir: directory,
              // } )
              
              site.createDeploy( { dir: directory } )
                .then( function ( deployed ) {
                  callback( null, deployed )
                } )
                .catch( function ( error ) {
                  callback( error, undefined )
                } )

              createdDeploy = true
            } )

          var message = 'Could not deploy.' +
            '\nPerhaps the site that is attempting to be deployed' +
            'has not been created yet?'
          if ( createdDeploy === false )
            callback( new Error( message ), undefined )
        } )
        .catch( function ( error ) {
          callback( error, undefined )
        } )
    } )
  }

  var createAndDeploy = function ( domain, directory, callback ) {
    create( domain, function ( error, created ) {
      deploy( domain, directory, callback )
    } )
  }

  var sites = function ( callback ) {
    client( function ( error, netlifyClient ) {
      netlifyClient.sites().then( function ( sites ) {
        callback( null, sites )
      } )
      .catch( function ( error ) {
        callback( error, undefined )
      } )
    } )
  }

  var update = function ( domain, callback ) {
    client( function ( error, netlifyClient ) {
      if ( error ) return callback( error, undefined )
      netlifyClient.sites()
        .then( function ( sites ) {
          var createdUpdate = false;

          sites.filter( function ( site ) {
            return site.name === toName( domain )
          } )
          .forEach( function ( site ) {

            site.update( {
                name: toName( domain ),
                customDomain: domain,
                notificationEmail: siteNotification,
              } )
              .then( function ( updated ) {
                callback( null, updated )
              } )
              .catch( function ( error ) {
                callback( error, undefined )
              } )

            createdUpdate = true
          } )

          var message = 'Could not update.' +
            '\nPerhaps the site is not yet made?'
          if ( createdUpdate === false )
            callback( new Error( message ), undefined )
        } )
        .catch( function ( error ) {
          callback( error, undefined )
        } )
    } )
  }

  return {
    init: init,
    create: create,
    deploy: deploy,
    createAndDeploy: createAndDeploy,
    sites: sites,
    update: update,
  }
}
