'use strict';

const { originAllowed } = require('../transport/ws.js');

// ---------------------------------------------------------------------------
// Cross-origin embedding of the HTTP asset routes (2026-09-19).
// ---------------------------------------------------------------------------
// transport/ws.js checks Origin on the `/ws` upgrade, but the plain HTTP
// routes (`/artifacts`, `/icons/*`, and everything the static handler
// serves) had no check at all. A web page open in any browser on the same
// machine or tailnet could `<script src>`, `<img>`, or `<iframe>` an indexed
// artifact by path: probing existence, and for a `.js` artifact, running it
// IN THE ATTACKER'S OWN ORIGIN where it can read whatever globals it defines
// and hand them back to that page.
//
// The fix is deliberately NOT "require an allowed Origin header": the phone
// PWA is served BY this same server, and its own same-origin `<img>` and
// `fetch` GETs normally carry NO Origin header at all (Origin is only ever
// attached to a "cors mode" cross-origin request, not a same-origin one), so
// that would refuse the product's own legitimate traffic. Two independent
// signals instead:
//
//   - Sec-Fetch-Site is sent by every Fetch-Metadata browser (Chrome, Edge,
//     Firefox, current Safari) on EVERY request the browser makes,
//     INCLUDING a same-origin `<img>` tag that carries no Origin header.
//     That makes it the primary signal: `cross-site` is another site
//     entirely (the actual attack), and `same-site` (a different origin
//     that shares a registrable domain, e.g. another tailnet node's
//     `*.ts.net` name) is refused too, since by definition it is never
//     `same-origin`. Only `same-origin`/`none` are legitimate for this
//     server's own PWA.
//   - Origin, checked with the SAME allow rule transport/ws.js already uses
//     (`originAllowed`, reusing its `isSelfOrigin` allowlist), is the
//     fallback for a client that sends Origin but no Sec-Fetch-Site (an
//     older or non-Fetch-Metadata browser). `originAllowed` already treats
//     a MISSING Origin as allowed, which covers curl, native apps, and the
//     standalone/installed PWA shells that send neither header at all: the
//     attack this guards against requires a browser, so a client with
//     neither header is not that attack.
function crossOriginRequestAllowed(req, originCtx) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  return originAllowed(req.headers.origin, originCtx);
}

// Applied to every artifact/icon/static response, allowed or not, so a
// browser that never even reaches the wire-level guard above (a request
// this process cannot see coming, or a future route someone adds without
// remembering the check) still cannot hand the bytes to a cross-origin
// document. Cross-Origin-Resource-Policy tells the BROWSER to block a
// cross-origin `no-cors` embed (`<img>`, `<script>`, `<link>`) of the
// response even though the request itself succeeded; that is a different,
// response-side decision from the request-side refusal above, and the two
// are complementary rather than redundant. X-Content-Type-Options stops a
// response served with an unexpected or missing content-type from being
// sniffed into script or HTML by the browser.
function setAssetSecurityHeaders(res) {
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function refuseCrossOrigin(res) {
  setAssetSecurityHeaders(res);
  res.writeHead(403);
  res.end('forbidden');
}

module.exports = { crossOriginRequestAllowed, setAssetSecurityHeaders, refuseCrossOrigin };
