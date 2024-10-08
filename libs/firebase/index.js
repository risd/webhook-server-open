const debug = require('debug')('WHFirebase')
const path = require( 'path' )
const axios = require( 'axios' )
const admin = require( 'firebase-admin' )
const {
  initializeApp,
  cert,
} = require( 'firebase-admin/app' )
const {
  getDatabase,
} = require('firebase-admin/database')
const getAccessToken = require( './access-token.js' )
const uuid = require('node-uuid')

const unescape = require( '../utils/firebase-unescape.js' )
const escape = require( '../utils/firebase-escape.js' )

module.exports = WHFirebase;

/**
 * Initialize the firebase admin SDK via service account key.
 * 
 * @param  {object}  config
 * @param  {string}  config.name                 The name of the firebase to initialize
 * @param  {string}  config.serviceAccountKeyFile    The service account key for the firebase to initialize
 * @param  {string?} config.initializationName   The name to use when initializing the firebase instance
 * @return {object}  firebase                          The firebase instance that has been initialized.
 */
function WHFirebase ( config ) {
  if ( ! ( this instanceof WHFirebase ) ) return new WHFirebase( config )
  var firebaseName = config.name;
  this._firebaseName = firebaseName;
  var firebaseServiceAccount
  if (config.serviceAccountCredentials) firebaseServiceAccount = config.serviceAccountCredentials
  else if (config.serviceAccountKeyFile) firebaseServiceAccount = require(path.join(process.cwd(), config.serviceAccountKeyFile));

  var options = {
    credential: cert( firebaseServiceAccount ),
    databaseURL: 'https://' + firebaseName + '.firebaseio.com',
  }

  this._initializationName = config.initializationName || '[DEFAULT]'

  this._app = appForName( this._initializationName )
  if ( ! this._app ) {
    this._app = initializeApp( options, this._initializationName )
  }

  this._getAccessToken = getAccessToken.bind( this, firebaseServiceAccount )
}

WHFirebase.prototype.database = function () {
  return getDatabase(this._app)
}

WHFirebase.prototype.siteKey = WebhookSiteKey;
WHFirebase.prototype.siteVersion = WebhookSiteVersion;
WHFirebase.prototype.siteDevData = WebhookSiteDevData;
WHFirebase.prototype.siteOwners = WebhookSiteOwners;
WHFirebase.prototype.siteManagement = WebhookSiteManagement;
WHFirebase.prototype.siteManagementError = WebhookSiteManagementError;
WHFirebase.prototype.userManagementSetSiteOwner = WebhookUserManagementSetSiteOwner;
WHFirebase.prototype.siteBillingCreate = WebhookSiteBillingCreate;
WHFirebase.prototype.siteBillingActive = WebhookSiteBillingActive;
WHFirebase.prototype.siteMessageAdd = WebhookSiteMessagesAdd;
WHFirebase.prototype.allSites = WebhookSites;
WHFirebase.prototype.removeSiteKeyData = WebhookSiteKeyDataRemove;
WHFirebase.prototype.allUsers = WebhookUsers;
WHFirebase.prototype.deleteSite = WebhookSiteDelete;
WHFirebase.prototype.backupUrl = WebhookSiteBackupURL;
WHFirebase.prototype.backups = WebhookBackups;
WHFirebase.prototype.siteRedirects = WebhookSiteRedirects;
WHFirebase.prototype.userExists = WebhookUserExists;
WHFirebase.prototype.signalBuild = WebhookSignalBuild;
WHFirebase.prototype.signalInvite = WebhookSignalInvite;
WHFirebase.prototype.signalDomainMapper = WebhookSignalDomainMap;
WHFirebase.prototype.signalRedirects = WebhookSignalRedirects;
WHFirebase.prototype.signalPreviewBuild = WebhookSignalPreviewBuild;
WHFirebase.prototype.signalSearchIndex = WebhookSignalSiteSearchIndex;

// helper - for initialization

function appForName ( name ) {
  var appOfNameList = admin.apps.filter( appOfName )
  if ( appOfNameList.length === 1 ) return appOfNameList[ 0 ]
  return null

  function appOfName ( app ) {
    return app.name === name
  }
}

// methods for interacting with webhook data

function WebhookSiteKey ( options, siteKey ) {
  var keyPath = `${ siteManagementPath( options ) }/key`
  if ( siteKey ) {
    // set
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, siteKey )
  }
  else {
    // get
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
}

function WebhookSiteVersion ({ siteName }, version) {
  const keyPath = `${ siteManagementPath({ siteName }) }/version`
  if (version) {
    return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, version)
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
  }
}

function WebhookSiteDevData ( options, siteData ) {
  var keyPath = siteDevKeyPath( options )
  var setMethod = appropriateSetMethod( siteData )
  if ( setMethod && setMethod.sdk  ) {
    // set via sdk
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, siteData )
  }
  else if ( setMethod && setMethod.rest ) {
    // set via rest
    return firebaseDatabaseSetLargeValueForKeyPath.call( this, keyPath, siteData )
  }
  else if ( setMethod ) {
    return Promise.reject( new Error( 'File is too big to set.' ) )
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )  
  }

  function appropriateSetMethod ( siteData ) {
    if ( ! siteData ) return false;
    var dataSize = sizeOf( siteData )

    // sizes defined: https://firebase.google.com/docs/database/usage/limits#writes
    return {
      sdk: fitsInSDK( dataSize ),
      rest: fitsInREST( dataSize ),
    }
  }

  function fitsInSDK ( dataSize ) {
    var maxSDKSize = 16 * 1024 * 1024; // 16MB
    return dataSize <= maxSDKSize
  }

  function fitsInREST ( dataSize ) {
    var maxRESTSize = 256 * 1024 * 1024; // 256MB
    return dataSize <= maxRESTSize;
  }

  function sizeOf ( data ) {
    return Buffer.from( JSON.stringify( data ) ).length
  }
}

function WebhookSiteManagement ({ siteName }) {
  const keyPath = siteManagementPath({ siteName })
  return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
}

function WebhookSiteManagementError ({ siteName }, value) {
  const keyPath = `${siteManagementPath({ siteName })}/error`
  if (typeof value !== 'undefined') {
    return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, value)
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
  }
}

function WebhookSites () {
  var keyPath = siteManagementPath()
  return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
}

function WebhookUsers () {
  var keyPath = usersManagementPath()
  return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
}

function WebhookUserExists ({ userEmail }) {
  const keyPath = usersManagementPath({ userEmail })
  return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
    .then((userSnapshot) => {
      const user = userSnapshot.val()
      if (user && user.exists) return true
      return false
    })
    .catch((error) => {
      return false
    })
}

function WebhookUserManagementSetSiteOwner ({ siteName, userEmail }) {
  const keyPath = usersManagementPath({ siteName, userEmail, owner: true })
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, true)
}

function WebhookSiteKeyDataRemove ( options ) {
  var keyPath = siteDataKeyPath( options )
  return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, null )
}

function WebhookSiteDelete ( options ) {
  var self = this;
  var deleteSite = options.siteName;

  // delete management path
  // delete billing path
  // delete bucket path
  var deleteKeyPaths = [
    siteManagementPath( options ),
    siteBilling( options ),
    siteBucketKeyPath( options ),
  ]

  // delete user references ( /management/users )
  // allUsers => users => usersSites => deleteKeyPathPromises
  return this.allUsers()
    .then( getUserSites )
    .then( returnDeletePromises )

  function returnDeletePromises ( usersSites ) {
    const keyPaths = usersSites
      .filter( includesSiteToDelete )
      .map( usersManagementPath )
        .concat( deleteKeyPaths )
    debug({keyPaths})
    var deletePromises = keyPaths.map( setKeyPathToNull )

    return admin.Promise.all( deletePromises )
  }

  function includesSiteToDelete ( userSite ) {
    return unescape( userSite.siteName ) === unescape( deleteSite )
  }

  function setKeyPathToNull ( keyPath ) {
    return firebaseDatabaseSetValueForKeyPath( self._app, keyPath, null )
  }

  function getUserSites ( usersSnapshot ) {
    var users = usersSnapshot.val()
    var usersSites = []
    var userKeys = Object.keys( users )
    for (var i = userKeys.length - 1; i >= 0; i--) {
      var userKey = userKeys[ i ]
      var userData = users[ userKey ]
      if ( ! userData.sites ) continue;
      var siteKeys = Object.keys( userData.sites )
      for (var j = siteKeys.length - 1; j >= 0; j--) {
        var siteKey = siteKeys[ j ]
        var siteData = users[ userKey ].sites[ siteKey ]
        if ( siteData ) {
          var usersSitesKeys = Object.keys( siteData )
          for (var k = 0; k < usersSitesKeys.length; k++) {
            var userSite = usersSitesKeys[ k ]
            usersSites.push( {
              userEmail: unescape( userKey),
              siteName: unescape( userSite ),
              owner: siteKey === 'owners',
              user: siteKey === 'users'
            } )
          }
        }
      }
    }

    return admin.Promise.resolve( usersSites )
  }
}

function WebhookBackups ( options, value, pushCallback ) {
  var keyPath = backupManagementPath( options )
  if ( options && options.key && value === null ) {
    // set, remove backup key
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, value )
  }
  else if ( options && options.push && value ) {
    // set, push key
    return firebaseDatabasePushValueForKeyPath( this._app, keyPath, value)
  }
  else if ( options && options.key && typeof value === 'undefined' ) {
    // get, backup timestamp
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
  else if ( typeof options === 'undefined' && typeof value === 'undefined' ) {
    // get all backup keys
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
  else {
    return this._app.Promise.reject( new Error( 'Could not return a promise for options proivded to WebhookBackups.' ) )
  }
}

async function WebhookSiteBackupURL () {
  let uri = `https://${ this._firebaseName }.firebaseio.com/.json?format=export`
  const token = await this._getAccessToken()
  uri += `&access_token=${ token }`
  return uri
}

function WebhookSiteRedirects ( options, value ) {
  var keyPath = siteRedirectPath( options )
  if ( typeof value !== 'undefined' ) {
    return firebaseDatabaseSetValueForKeyPath( this._app, keyPath, value )
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath( this._app, keyPath )
  }
}

function WebhookSiteOwners (options, ownerData) {
  var keyPath = `${siteManagementPath(options)}/owners`
  if (ownerData) {
    // set
    return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, ownerData)
  } else {
    // get
    return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
  }
}

function WebhookSiteBillingCreate ({ siteName, userEmail }) {
  const keyPath = siteBilling({ siteName })
  const billingData = {
    'plan-id': 'mainplan',
    'email': userEmail,
    'status': 'paid',
    'active': true,
    'endTrial' : Date.now()
  }
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, billingData)
}

function WebhookSiteBillingActive ({ siteName }) {
  const keyPath = `${siteBilling({ siteName })}/active`
  return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
    .then((activeSnapshot) => {
      const active = activeSnapshot.val()
      return active
    })
}


function WebhookSiteMessages ({ siteName }, value) {
  
  if (value) {
    
  }
  else {
    return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
  }
}

// value : { message, timestamp, status, code }
function WebhookSiteMessagesAdd ({ siteName }, value) {
  const keyPath = siteMessagesKeyPath({ siteName })
  return firebaseDatabasePushValueForKeyPath(this._app, keyPath, value)
    .then(() => {
      return firebaseDatabaseOnceValueForKeyPath(this._app, keyPath)
    })
    .then((messagesSnapshot) => {
      const messages = messagesSnapshot.val()
      if (Object.keys(messages).length <= 50) return
      const oldestKey = Object.keys(messages).sort()[0]
      return firebaseDatabaseSetValueForKeyPath(this._app, `${keyPath}/${oldestKey}`, null)
    })
}

function WebhookSignalBuild ({ siteName }, payload) {
  const keyPath = `management/commands/build/${ escape(siteName) }`
  if (!payload.id) payload.id = uuid.v4()
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, payload)
}

function WebhookSignalInvite ({ siteName }, payload) {
  const keyPath = `management/commands/invite/${ escape(siteName) }`
  if (!payload.id) payload.id = uuid.v4()
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, payload)
}

function WebhookSignalDomainMap ({ siteName }, payload) {
  const keyPath = `management/commands/domainMap/${ escape(siteName) }`
  if (!payload.id) payload.id = uuid.v4()
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, payload)
}

function WebhookSignalRedirects ({ siteName }, payload) {
  const keyPath = `management/commands/redirects/${ escape(siteName) }`
  if (!payload.id) payload.id = uuid.v4()
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, payload)
}

function WebhookSignalPreviewBuild ({ siteName }, payload) {
  const keyPath = `management/commands/previewBuild/${ escape(siteName) }`
  if (!payload.id) payload.id = uuid.v4()
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, payload)
}

function WebhookSignalSiteSearchIndex ({ siteName }, payload) {
  const keyPath = `management/commands/siteSearchReindex/${ escape(siteName) }`
  if (!payload.id) payload.id = uuid.v4()
  return firebaseDatabaseSetValueForKeyPath(this._app, keyPath, payload)
}

// helpers - interfaces into data

function firebaseDatabaseSetValueForKeyPath ( app, keyPath, value ) {
  // return set(child(ref(getDatabase(app)), keyPath), value)
  return getDatabase(app).ref().child(keyPath).set(value)
}

function firebaseDatabaseSetLargeValueForKeyPath ( keyPath, value ) {
  var uri = `https://${ this._firebaseName }.firebaseio.com/${ keyPath }.json`
  return this._getAccessToken()
    .then( function ( token ) {
        uri += `?access_token=${ token }`
        var putOptions = {
          method: 'PUT',
          url: uri,
          data: value,
          json: true,
        }
        return axios.put( putOptions )
    } )
}

function firebaseDatabaseOnceValueForKeyPath ( app, keyPath ) {
  debug(`get:${keyPath}`)
  return getDatabase(app).ref().child(keyPath).get()
}

function firebaseDatabasePushValueForKeyPath (app, keyPath, value) {
  debug(`push:${keyPath}`)
  return getDatabase(app).ref().child(keyPath).push(value)
}

// helpers - construct paths

function backupManagementPath ( options ) {
  var base = `management/backups`
  if ( options && options.key ) {
    return `${ base }/${ options.key }`
  }
  else {
    return base;
  }
}

function siteManagementPath ( options ) {
  var base = `management/sites`
  if ( options && options.siteName ) {
    return `${ base }/${ escape( options.siteName ) }`  
  }
  else {
    return base;
  }
}

// {
//   siteName : string?,
//   userEmail : string?,
//   owner : boolean?,
//   user: boolean?
// }
function usersManagementPath ( options ) {
  var base = `management/users`
  if ( options && options.userEmail && options.owner && options.siteName ) {
    return `${ base }/${ escape( options.userEmail ) }/sites/owners/${ escape( options.siteName ) }`
  }
  if ( options && options.userEmail && options.user && options.siteName ) {
    return `${ base }/${ escape( options.userEmail || options.user ) }/sites/users/${ escape( options.siteName ) }`
  }
  if ( options && options.userEmail ) {
    return `${ base }/${ escape( options.userEmail ) }`
  }
  else {
    return base;
  }
}

function siteBucketKeyPath ( options ) {
  return `buckets/${ escape( options.siteName ) }`
}

function siteDataKeyPath ( options ) {
  return `${ siteBucketKeyPath( options ) }/${ options.siteKey }`
}

function siteDevKeyPath ( options ) {
  return `${ siteDataKeyPath( options ) }/dev`
}

function siteRedirectPath ( options ) {
  return `${ siteDevKeyPath( options ) }/settings/redirect`
}

function siteBilling ( options ) {
  return `billing/sites/${ escape( options.siteName ) }`
}

function siteMessagesKeyPath ({ siteName }) {
  return `${siteManagementPath({ siteName })}/messages`
}
