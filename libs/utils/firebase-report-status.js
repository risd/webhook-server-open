var _ = require('lodash');

module.exports = ReportStatus;

/**
 *  Reports the status to firebase, used to display messages in the CMS
 *
 *  @param site    The name of the site
 *  @param message The Message to send
 *  @param status  The status code to send (same as command line status codes)
 *  @param code    The code to use to categorize the type of message being sent
 *  @param callback  Function called at the end of the status report
 */
function ReportStatus ( firebase ) {

  return function reportStatus ( site , message, status, code, callback ) {
    if ( typeof code === 'function' ) {
      callback = code
      code = undefined
    }
    if ( ! code ) code = 'BUILT'
    if ( ! callback ) callback = function noop () {}
    
    // project::firebase::ref::done
    var messagesRef = firebase.ref('/management/sites/' + site + '/messages/');
    // project::firebase::push::done
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: code }, function() {
      // project::firebase::once--value::done
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limitToFirst(1).once('child_added', function(snap) {
            messagesRef.child(snap.key).remove(callback);
          });
        }
        else {
          callback()
        }
      });
    });
  }

}
