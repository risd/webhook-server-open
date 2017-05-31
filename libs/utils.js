var miss = require( 'mississippi' )
var path = require( 'path' )
var fs = require( 'fs' )
var crypto = require( 'crypto' )
var zlib = require( 'zlib' )
var cloudStorage = require('./cloudStorage.js')
var mime = require( 'mime' )

module.exports = {
  usingArguments: usingArguments,
  sink: sink,
  uploadIfDifferent: uploadIfDifferent,
  redirectTemplateForDestination: redirectTemplateForDestination,
}

// Read stream that passes in initialze arguments
function usingArguments ( args ) { return miss.from.obj( [ args, null ] ) }

/**
 * Sink stream. Used as the last step in a stream pipeline as a stream
 * to write to, that doesn't push anything to be read.
 * @param  {Function} fn?     Optional function to call on the current item.
 * @return {object}   stream  Transform stream that handles incoming objects.
 */
function sink ( fn ) {
  if ( typeof fn !== 'function' ) fn = function noop () {}
  return miss.through.obj( function ( args, enc, next ) {
    fn( args )
    next()
  } )
}


/**
 * uploadIfDifferent is a transform stream that expects objects with:
 * { builtFile, builtFilePath }
 *
 * Pushes { bucket, builtFile, builtFilePath, builtFileMd5, remoteFileMd5, fileUploaded }
 *
 * With this, the stream will
 * - Get the file within the buckets for its metadata.
 * - Create an MD5 hash using the file on the current file system
 * - Compare its MD5 hash against the file coming through the stream
 * - If they are different, upload the new file.
 *
 * `builtFilePath` can be the path to the content, or the content itself.
 * In the case of templates that are never written to the file system.
 *
 * Expects: cloudStorage, fs, crypto, zlib
 * 
 * @param  {object} options
 * @param  {object} options.buckets[]  List of buckets to upload the file to
 * @return {object} stream             Transforms stream that handles the work.
 */
function uploadIfDifferent ( options ) {
  if ( !options ) options = {};
  var buckets = options.buckets;

  return miss.through.obj( function ( args, enc, next ) {

    var stream = this;

    var uploadArgs = {
      builtFile: args.builtFile,
      builtFilePath: args.builtFilePath,
    }

    if ( args.bucket ) uploadArgs.bucket = args.bucket;

    miss.pipe(
      usingArguments( uploadArgs ),
      builtFileMd5(),         // adds builtFileMd5
      feedBuckets( buckets ), // pushes { bucket, builtFile, builtFilePath, builtFileMd5 }
      remoteFileMd5(),        // adds { remoteFileMd5 }
      conditionalUpload(),    // adds { fileUploaded }
      sink(),
      function onComplete ( error ) {
        if ( error ) return next( error )
        next( null, args )
      } )
  } )

  function builtFileMd5 () {
    return miss.through.obj( function ( args, enc, next ) {
      var encoding = 'utf8';
      fs.readFile( args.builtFilePath, encoding, function ( error, builtFileContent ) {
        if ( error ) builtFileContent = args.builtFilePath;

        zlib.gzip( builtFileContent, function ( error, compressedBuiltFileContent ) {
          
          args.overrideMimeType = path.extname( args.builtFilePath ) === ''
            ? 'text/html'
            : mime.lookup( args.builtFilePath )
          args.builtFileMd5 = crypto.createHash('md5').update(compressedBuiltFileContent, encoding).digest('base64');
          // args.compressed = compressedBuiltFileContent.toString( encoding );

          next( null, args );

        } )
      } )
    } )
  }

  function feedBuckets ( buckets ) {
    return miss.through.obj( function ( args, enc, next ) {
      var stream = this;

      // One file per bucket
      if ( args.bucket ) {
        stream.push( args )
      }
      // Same file for multiple buckets?
      if ( buckets ) {
        buckets.map( function ( bucket ) {
            return Object.assign( args, { bucket: bucket } )
          } )
          .forEach( function ( bucketArgs ) {
            stream.push( bucketArgs )
          } )  
      }

      next();
    } )
  }

  function remoteFileMd5 () {
    return miss.through.obj( function ( args, enc, next ) {
      cloudStorage.objects.getMeta( args.bucket, args.builtFile, function ( error, remoteFileMeta ) {
        if ( error ) args.remoteFileMd5 = false;
        else args.remoteFileMd5 = remoteFileMeta.md5Hash;
        next( null, args )
      } )
    } ) 
  }

  function conditionalUpload () {
    return miss.through.obj( function ( args, enc, next ) {
      if ( args.builtFileMd5 === args.remoteFileMd5 ) return next( null, Object.assign( args, { fileUploaded: false } ) )

      var uploadOptions = streamArgsToUploadOptions( args );

      cloudStorage.objects.uploadCompressed( uploadOptions, function ( error, uploadResponse ) {
        if ( error ) {
          console.log( 'conditional-upload:error' )
          console.log( error )
          args.fileUploaded = false;
        }
        else {
          args.fileUploaded = true;
        }
        next( null, args )
      } )
    } )
  }

  function streamArgsToUploadOptions ( args ) {
    return {
      bucket: args.bucket,
      local: args.builtFilePath,
      remote: args.builtFile,
      cacheControl: 'no-cache',
      overrideMimeType: args.overrideMimeType,
      compressed: args.compressed,
    }
  }
}

function redirectTemplateForDestination ( destination ) {
  return [
    '<html>',
      '<head>',
        '<meta charset="utf-8" />',
      '</head>',
      '<body>',
        '<script>',
          'window.location="', destination , '";',
        '</script>',
      '</body>',
    '</html>',
  ].join( '' )
}