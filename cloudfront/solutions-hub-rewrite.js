// CloudFront viewer-request function for the /solutions/* behavior on
// distribution E39WJRUVOH25A4. Files are stored in S3 under the key prefix
// solutions/. Internal links in the HTML already include the prefix, so
// most requests need no rewrite. Two cases that do:
//   1. /solutions-hub        → 301 to /solutions-hub/  (canonical trailing slash)
//   2. /solutions-hub/       → rewrite to /solutions-hub/index.html
// All other requests pass through unchanged (e.g. /solutions-hub/industries/foo.html
// resolves directly to S3 key solutions-hub/industries/foo.html).
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    if (uri === '/solutions') {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: '/solutions/' } }
        };
    }
    if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
    }
    return request;
}
