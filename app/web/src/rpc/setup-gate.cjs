'use strict';

// Whether the phone has to be asked for a token, as a value, so the rule has a
// test instead of a screenshot.
//
// This is the decision that made the installed app ask for a 64-character hex
// token on EVERY cold launch. iOS gives a home-screen web app its own storage
// container, separate from Safari's, so `token` is empty on every launch no
// matter what was pasted into the browser, and the old gate
// (`!settings.token` -> show the setup screen) read that empty token as "never
// set up". There was no way to tell those two states apart on the client, which
// is why the answer has to come from the server.
//
// `auth` is the server's own answer from /whoami:
//   null/undefined  the answer has not arrived yet. HOLD. Guessing "required"
//                   flashes the very prompt this exists to remove, and guessing
//                   "not required" flashes the app for someone who is genuinely
//                   unauthenticated.
//   {authenticated} whether this caller is already authenticated by the tailnet,
//                   in which case no token exists to be asked for.
function setupGate({ settings = {}, auth = null } = {}) {
  if (auth === null || auth === undefined) return 'pending';
  // No server URL means nothing to ask, which is the genuine first-run case on a
  // client that was not served BY the server it talks to.
  if (!settings.serverUrl) return 'setup';
  // A stored token still works, so a non-tailnet client is unaffected.
  if (settings.token) return 'ready';
  return auth.authenticated ? 'ready' : 'setup';
}

module.exports = { setupGate };
