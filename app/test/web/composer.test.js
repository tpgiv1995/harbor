'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '../..');
const WEB_SRC = path.join(APP_ROOT, 'web/src');

function source(file) {
  const target = path.join(WEB_SRC, file);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
}

test('MOBILE-OVERHAUL-4: composer sends the complete real payload from a button', () => {
  const composer = source('composer/Composer.jsx');
  const sendHook = source('composer/use-send.js');

  assert.match(composer, /<textarea/);
  assert.match(composer, /type="button"/);
  assert.match(composer, /onKeyDown=\{.*slashOpen/s);
  assert.match(sendHook, /client\.call\('session:send',\s*\{/);
  assert.match(sendHook, /sessionId,\s*text,\s*images,\s*pane,\s*resumeOnly:\s*false/);
});

test('MOBILE-PARITY-3b: phone image picker uploads bytes and sends returned host paths', () => {
  const composer = source('composer/Composer.jsx');
  const sendHook = source('composer/use-send.js');
  const attachmentHook = source('attach/use-attachments.js');
  const chips = source('attach/AttachChips.jsx');
  const css = source('composer/composer.css');

  assert.match(composer, /type="file"/);
  assert.match(composer, /accept="image\/\*"/);
  assert.match(composer, /multiple/);
  assert.match(attachmentHook, /client\.call\('upload:image'/);
  assert.match(attachmentHook, /bytesBase64/);
  assert.match(sendHook, /images,/);
  assert.match(chips, /<img/);
  assert.match(chips, /Remove/);
  assert.match(css, /min-(?:width|height): 44px/);
});

test('MOBILE-PARITY-3b: attachment refusal is honest and failed sends retain staged images', () => {
  const composer = source('composer/Composer.jsx');
  const attachmentHook = source('attach/use-attachments.js');

  assert.match(attachmentHook, /reasonFrom\(error\)/);
  assert.match(composer, /role="alert"/);
  assert.match(composer, /if \(result\.ok\)/);
  assert.doesNotMatch(composer, /clear\(\);\s*}\s*else/);
});

test('MOBILE-OVERHAUL-4: queue, cancellation, interruption, and status pushes use real channels', () => {
  const composer = source('composer/Composer.jsx');
  const sendHook = source('composer/use-send.js');

  assert.match(sendHook, /client\.call\('session:send-queue'/);
  assert.match(sendHook, /client\.call\('session:cancel-send'/);
  assert.match(sendHook, /client\.call\('session:interrupt',\s*\{ paneId \}\)/);
  assert.match(sendHook, /client\.onChannel\('send:status'/);
  assert.match(composer, /Cancel queued/);
  assert.match(composer, /Stop/);
});

test('MOBILE-OVERHAUL-4: refusal reasons are rendered verbatim while allowed sends clear the draft', () => {
  const composer = source('composer/Composer.jsx');
  const sendHook = source('composer/use-send.js');

  assert.match(sendHook, /result\?\.ok === false/);
  assert.match(sendHook, /String\(result\.reason\)/);
  assert.match(composer, /role=\{status\.phase === 'error' \? 'alert'/);
  assert.match(composer, /if \(result\.ok\) \{\s*setText\(''\)/);
});

test('MOBILE-PARITY-7: composer ships voice-to-draft, slash palette, formatting toolbar, and live voice controls', () => {
  const composer = source('composer/Composer.jsx');
  const voiceDraft = source('voice/use-voice-draft.js');
  const slash = source('slash/SlashPalette.jsx');
  const format = source('composer/FormatToolbar.jsx');
  const live = source('voice/use-live-voice.js');

  assert.match(voiceDraft, /whisper:transcribe/);
  assert.match(composer, /composer-mic/);
  assert.match(composer, /composer-live-voice/);
  assert.match(composer, /composer-format-toggle/);
  assert.match(slash, /classifySlashTokens/);
  assert.match(slash, /SlashPalette/);
  assert.match(format, /applyFormat/);
  assert.match(live, /voice:token/);
  assert.match(live, /response\.done/);
  assert.match(live, /queueRef/);
  assert.doesNotMatch(composer, /OpenAI.*key/i);
});

test('MOBILE-KEYBOARD-1: composer stays in normal flow inside the visual-viewport shell', () => {
  const composer = source('composer/Composer.jsx');
  const css = source('composer/composer.css');

  assert.doesNotMatch(composer, /useVisualViewport|keyboardOpen|bottomAnchoredStyle|style=\{/);
  assert.doesNotMatch(css, /(^|\n)\s*bottom\s*:/m);
  assert.doesNotMatch(css, /position:\s*fixed/);
});
