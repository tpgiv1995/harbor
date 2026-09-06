'use strict';

// Which server URL a freshly-loaded PWA should default to talking to.
//
// The PWA is always served BY the harbor-server (src/server/http/static.js
// serves dist-web), so the ORIGIN that served this page is the server to talk
// to, in every deployment: loopback (http://127.0.0.1:8787), a direct tailnet
// IP (http://100.x.x.x:8787), or a MagicDNS name behind `tailscale serve`
// (https://box.tailnet.ts.net). Returning the origin covers all three.
//
// The old code named only a .ts.net host and returned '' everywhere else. That
// empty value flowed through ingestSetupFragment/loadSettings into setupGate,
// which returns 'setup' (the Connect screen) whenever serverUrl is empty and
// BEFORE it looks at the token, so a valid one-tap token link (#token=...)
// stranded on a manual Connect screen anywhere but a .ts.net name, including the
// loopback "try it on this machine" flow the README recommends first (a phone
// over a real tailnet was fine only because it also carries a tailnet identity,
// which authenticates it without a token at all).
//
// `origin` is used rather than protocol//hostname so a non-default port
// survives (loopback's :8787), and a non-http(s) page (file://, which reports
// origin 'null') falls through to '' rather than a junk URL.
function deriveServerUrl(location) {
  if (!location) return '';
  const { protocol, origin } = location;
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  return origin || '';
}

module.exports = { deriveServerUrl };
