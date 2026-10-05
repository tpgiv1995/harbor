'use strict';

// The one protocol rule of live voice: never ask for a response while one is in
// flight (the API answers conversation_already_has_active_response). A tool call
// is exactly where that is tempting to get wrong, because the arguments arrive
// before the response that carried them has finished, so tool outputs and
// relayed news are queued and flushed on response.done.
//
// This reads the SOURCE rather than driving the hook, because the queue lives
// inside a React hook with refs and there is no DOM in this suite. It therefore
// proves the rule is still written down, not that it executes; the executing
// proof is scripts/live-drive-voice.js against the live model. Both twins are
// checked because the desktop hook and the phone hook are the same machine and
// have drifted apart before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TWINS = [
  ['phone', path.join(__dirname, '../../web/src/voice/use-live-voice.js')],
  ['desktop', path.join(__dirname, '../../src/renderer/voice/useVoiceAgent.js')],
];

for (const [name, file] of TWINS) {
  const source = fs.readFileSync(file, 'utf8');

  test(`${name} live voice queues tool output until response.done`, () => {
    assert.match(source, /if \(activeResponseRef\.current\) return/);
    assert.match(source, /queueRef\.current\.push/);
    assert.match(source, /case 'response\.done':[\s\S]*flush\(\)/);
    assert.match(source, /conversation_already_has_active_response|response\.create/);
  });

  test(`${name} live voice frees the lane ONLY for the create that failed`, () => {
    // The active flag is set optimistically when response.create is sent. If
    // that request FAILS there is no response.created and no response.done, so
    // without this recovery the flag stayed true forever and every later tool
    // output sat in the queue unsent: the agent went permanently silent with
    // nothing on screen to say why. Each create carries an event_id, and only
    // the error that names THAT id frees the lane (2026-09-03); an error for any
    // other client event must not, or a second response.create goes out while
    // the first is still starting.
    assert.match(source, /awaitingCreateRef\.current = true;[\s\S]*pendingCreateIdRef\.current = id;\s*\n\s*rawSend\(\{ type: 'response\.create', event_id: id \}\)/);
    assert.match(source, /case 'error':[\s\S]*awaitingCreateRef\.current && event\.error\?\.event_id[\s\S]*event\.error\.event_id === pendingCreateIdRef\.current[\s\S]*activeResponseRef\.current = false;[\s\S]*flush\(\)/);
    // ...except when the API is telling us a response really is running, where
    // clearing the flag would start the loop this rule exists to prevent.
    assert.match(source, /event\.error\?\.code !== 'conversation_already_has_active_response'/);
    // response.created and response.done both settle it (and clear the pending
    // id), so a normal turn never leaves the recovery armed.
    assert.match(source, /case 'response\.created':[\s\S]*awaitingCreateRef\.current = false;[\s\S]*pendingCreateIdRef\.current = null/);
    assert.match(source, /case 'response\.done':[\s\S]*awaitingCreateRef\.current = false;[\s\S]*pendingCreateIdRef\.current = null/);
  });

  test(`${name} live voice reports a peer connection that never came up`, () => {
    // An ICE failure opens no data channel, so channel.onclose never fires and
    // the bar sat on "connecting" forever with the microphone still held.
    assert.match(source, /pc\.onconnectionstatechange = \(\) => \{/);
    assert.match(source, /pc\.connectionState !== 'failed' \|\| pcRef\.current !== pc/);
    assert.match(source, /setPhase\('error'\);\s*\n\s*setMessage\('the voice connection failed'\)/);
  });

  test(`${name} live voice tears down on a remote channel close`, () => {
    // A server close leaves the peer connection and the mic track alive while
    // the UI reads idle; the close handler must stop() the whole session, guarded
    // by identity so a deliberate stop() does not recurse (2026-09-03).
    assert.match(source, /channel\.onclose = \(\) => \{ if \(channelRef\.current === channel\) stop\(\); \}/);
  });

  test(`${name} live voice cancels a start that a stop raced`, () => {
    // stop() and unmount bump a generation token; a start still awaiting the
    // token mint or the microphone checks it after every await and stops the
    // just-acquired stream instead of bringing the mic up after a stop.
    assert.match(source, /startGenRef\.current \+= 1/);
    assert.match(source, /const gen = \(startGenRef\.current \+= 1\)/);
    assert.match(source, /const cancelled = \(\) => startGenRef\.current !== gen/);
    // The stream acquired after a cancel is stopped, never assigned to the ref.
    assert.match(source, /if \(cancelled\(\)\) \{[\s\S]*getTracks\(\)[\s\S]*track\.stop\(\)/);
  });
}
