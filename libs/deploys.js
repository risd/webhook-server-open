var fs = require('fs');

module.exports = Deploys;

/**
 * Configure the deploys object with the bucket root
 * that can be used to manage deploy configuration for
 * individual sites.
 * 
 * @param {object}  bucketsRoot
 */
function Deploys ( bucketsRoot ) {
  if ( ! ( this instanceof Deploys ) ) return new Deploys( bucketsRoot );

	return {
		get: getFirebaseConfiguration,
		set: setFirebaseConfiguration,
		findInDirectory: findConfigurationInDirectory,
		default: defaultConfiguration,
	}

	function getKeyForSite (siteName, callback)  {
		bucketsRoot.root().child('/management/sites')
			.child(siteName)
			.child('key')
			.once('value',
				function success ( snapshot ) {
					callback( null, snapshot.val() )
				},
				function ( error ) {
					callback( error )
				})
	}

	function getDeploysForSiteAndKey ( siteName, key, callback ) {
		var configuration = {
			name: siteName,
			key: key,
			deploys:  defaultConfiguration( siteName )
		};

		bucketsRoot.child(siteName)
			.child(key)
			.child('dev/deploys')
			.once('value',
				function onSnapshot (snapshot) {
					callback( null, Object.assign(
						configuration,
						{ deploys: snapshot.val() } )
					)
				},
				function onError (err) {
					callback( null, configuration )
				});
	}

	/**
	 * Set the deploy configuration in the firebase bucket tree.
	 * 
	 * @param  {object}   opts
	 * @param  {string}   opts.name
	 * @param  {string}   opts.key
	 * @param  {object}   opts.deploys
	 * @param  {string}   opts.deploys[].buckets
	 * @param  {function} Callback with error if could not be set
	 * @return {undefined}
	 */
	function setFirebaseConfiguration ( opts, callback ) {
		if ( ! ( areValidGetterOpts(opts) && areValidSetterOpts(opts) ) )
			callback( new Error( 'Options for deploys.setter not valid.' ) )

		bucketsRoot.child(opts.name).child(opts.key)
			.child('dev/deploys')
			.set(  bucketNamesForSiteNames( opts.deploys ), callback );
	}

	/**
	 * Get the deploy configuration in the firebase bucket tree.
	 * @param  {string}   siteName
	 * @param  {function} Callback with deploy settings
	 * @return {undefined}
	 */
	function getFirebaseConfiguration ( siteName, callback ) {
		getKeyForSite( siteName, function onKey ( error, key ) {
			if ( error ) callback( error )
			getDeploysForSiteAndKey( siteName, key, callback )
		} )		
	}

	/**
	 * Given a site build folder, find the deploys.json file.
	 * If found, the configuration is validated, and the callback
	 * is invoked with ( null, configuration )
	 * If none is found, or is found to be invalid the callback is
	 * invoked with ( null, false )
	 * 
	 * @param  {string}
	 * @param  {Function}
	 * @return {undefined}
	 */
	function findConfigurationInDirectory ( siteDirectory, callback ) {
		var deployConfigurationPath = [ siteDirectory, 'deploys.json' ].join('/');

		var deployConfiguration = false;

		try {
			fs.readFile( deployConfigurationPath, 'utf8',
				function ( read_error, file_contents ) {
					var configuration = JSON.parse(file_contents);
					if ( isValidDeploy( configuration ) )
						callback( null, configuration )
					else
						callback( null, deployConfiguration )
				});
		} catch (error) {
			callback( error, deployConfiguration )
		}
	}

	function defaultConfiguration ( siteBucket ) {
		// escaped site name is expected
		if ( siteBucket.indexOf('.') !== -1 )
			siteBucket = bucketNameForSiteName(siteBucket)
		return [{
			bucket: siteBucket
		}];
	}

}

// utilities

function bucketNameForSiteName (siteName) {
  return siteName.replace(/\./g, ',1');
};

// validation functions

function isStringWithLength ( str ) {
	return typeof str === 'string' && str.length > 0;
}

// function areValidGetterOpts ( opts ) {
// 	try {
// 		return isStringWithLength( opts.name )
// 	} catch (error) {
// 		return false;
// 	}
// }

function areValidSetterOpts (opts) {
	try {
		return isStringWithLength( opts.siteName ) &&
			isStringWithLength( opts.key ) &&
			areValidDeploys( opts.deploys )
	} catch (error) {
		return false;
	}
	// return (typeof opts === 'object' &&
	// 	opts.hasOwnProperty('deploys') &&
	// 	areValidDeploys( opts.deploys ) );
}

function areValidDeploys ( deployConfig ) {
	// validates individual keys
	// return Object.keys(deployConfig)
	// 	.map(function validate ( destination ) {
	// 		return typeof destination === 'string' &&
	// 		  deployConfig[destination].hasOwnProperty('bucket') &&
	// 		  isStringWithLength(deployConfig[destination].bucket);
	// 	})
	// 	.filter(function isTrue (validated) {
	// 		return validated;
	// 	})
	// 	.length === Object.keys(deployConfig).length;
	return deployConfig.filter( function isValidDeploy ( deploy ) {
			try {
				return typeof deploy.bucket === 'string';
			} catch (error) {
				return false;
			}
		} )
		.length === deployConfig.length;
}

function bucketNamesForSiteNames ( deployConfig ) {
	return deployConfig.map( function ( deploy ) {
		deploy.bucket = bucketNameForSiteName( deploy.bucket )
		return deploy
	} )
	// return Object.keys( deployConfig )
	// 	.map( function toArray ( destination ) {
	// 		return {
	// 			destination: destination,
	// 			config: deployConfig[destination],
	// 		}
	// 	})
	// 	.map( function escape ( deploy ) {
	// 		Object.keys( deploy.config ).forEach( function( configKey ) {
	// 			if ( configKey === 'bucket' )
	// 				deploy.config[configKey] = bucketNameForSiteName(deploy.config[configKey])
	// 		} )
	// 		return deploy;
	// 	} )
	// 	.reduce( function toObject (previous, current) {
	// 		var obj = {};
	// 		obj[current.destination] = current.config;

	// 		return Object.assign(previous, obj);
	// 	}, {} );
}