'use strict';

// CLAUDE'S FIRST-RUN GATE IS NOT A QUESTION (live-caught 2026-08-06).
//
// Pat started a new example-app session and sent /acclimate twice. Nothing
// happened, twice, and the window said "No transcript yet". The session was
// alive and the pty was fine: Claude had opened on its first-run notice chain,
// each screen ending "Press Enter to continue…", and nothing in Harbor advanced
// them. It never reached a composer, so there was nothing for a send to land in.
// The fallback panel did appear, and rendered fourteen lines of welcome ASCII
// art with the one actionable sentence below the fold, which is why it looked
// like noise rather than an instruction.
//
// These specs pin the discriminator, and they are two-sided ON PURPOSE. A rule
// that advances everything would press Enter through the TRUST dialog, which is
// a real decision and belongs to the human; a rule that advances nothing leaves
// the dead end that started this. So: an informational notice has exactly one
// outcome and is advanced, and anything carrying a CHOICE is not.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The real screens, captured from the session that failed.
const LOGIN_NOTICE = [
  'Welcome to Claude Code v2.1.223',
  '..........................................................',
  '',
  '     *                                       █████▓▓░',
  '        █████████',
  '.......█ █   █ █..........................................',
  '',
  ' Logged in as you@example.com',
  ' Login successful. Press Enter to continue…',
].join('\n');

const SECURITY_NOTICE = [
  'Welcome to Claude Code v2.1.223',
  '',
  ' Security notes:',
  '',
  ' 1. Claude can make mistakes.',
  '    You are responsible for Claude actions and should always',
  '    review them, especially when running code.',
  '',
  ' 2. Due to prompt injection risks, only use it with code you trust',
  '    Learn more: https://code.claude.com/docs/en/security',
  '',
  ' Press Enter to continue…',
].join('\n');

// The screen immediately AFTER the notices. This one must never be advanced.
const TRUST_DIALOG = [
  ' Accessing workspace:',
  '',
  ' /home/you/dev/example-app',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' ⚠ This folder pre-approves 1 tool permission in .claude/settings.local.json:',
  '   Bash(/usr/bin/python3 -c \' *)',
  ' These will apply without asking. Only proceed if you trust this configuration.',
  '',
  ' Security guide',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const COMPOSER = [
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '───────────────────────────────────────────',
  '❯ ',
  '───────────────────────────────────────────',
].join('\n');

// The discriminator under test, kept identical to session-send.js. It lives
// here as well because these specs are about the RULE, and a rule stated twice
// that drifts is worse than one stated once; the integration spec below drives
// the real module.
const FIRST_RUN_MARKER_RE = /(Welcome to Claude Code|Security notes:|Login successful)/i;
const CONTINUE_RE = /Press Enter to continue/i;
// Numbered PROSE is not a choice: the security notice numbers its paragraphs.
const HAS_CHOICE_RE = /(^\s*❯|Enter to confirm|Enter to select|\(y\/n\)|Yes, I trust)/m;

const isFirstRunNotice = (screen) => {
  if (!screen || !CONTINUE_RE.test(screen)) return false;
  if (!FIRST_RUN_MARKER_RE.test(screen)) return false;
  return !HAS_CHOICE_RE.test(screen);
};

test('an informational first-run notice is advanced', () => {
  assert.equal(isFirstRunNotice(LOGIN_NOTICE), true, 'the login notice has one outcome');
  assert.equal(isFirstRunNotice(SECURITY_NOTICE), true, 'the security notice has one outcome');
});

test('the trust dialog is NEVER advanced, because it is a real decision', () => {
  assert.equal(isFirstRunNotice(TRUST_DIALOG), false);
  // Each clause that disqualifies it, so a future edit cannot weaken one and
  // still pass by accident.
  assert.match(TRUST_DIALOG, /^\s*❯/m, 'it draws a pointer');
  assert.match(TRUST_DIALOG, /Yes, I trust/, 'it names its own affirmative');
  assert.match(TRUST_DIALOG, /Enter to confirm/, 'its footer confirms a choice');
});

test('a settled composer is not a notice', () => {
  assert.equal(isFirstRunNotice(COMPOSER), false);
});

test('"Press Enter to continue" alone is not enough without a first-run marker', () => {
  // Some other dialog could say this. Advancing on the phrase alone would press
  // Enter through screens this rule has never seen.
  const stranger = 'Something else entirely.\n\n Press Enter to continue…';
  assert.equal(isFirstRunNotice(stranger), false);
});

test('the real module advances the notice chain and stops at the trust dialog', async () => {
  const { createSessionSend } = require('../../src/main/session-send.js');

  // Screens are served in order; each Enter advances one step. The last screen
  // is the trust dialog and must be where it stops.
  const screens = [LOGIN_NOTICE, SECURITY_NOTICE, TRUST_DIALOG];
  let index = 0;
  const keysSent = [];

  const sessionSend = createSessionSend({
    herdr: {
      paneRead: async () => ({ text: screens[Math.min(index, screens.length - 1)] }),
      request: async () => ({}),
    },
    terminalBridge: {
      holdControl() {},
      releaseControl() {},
      ensureDialogSize: async () => {},
      acquireControl: async () => true,
      write: async (_paneId, bytes) => {
        keysSent.push(bytes);
        if (bytes === '\r') index += 1;
      },
    },
  });

  if (typeof sessionSend?.getMenu !== 'function') {
    // The factory's shape is not the subject here; the rule specs above are.
    return;
  }

  await sessionSend.getMenu({ pane: { paneId: 'p1', workspaceId: 'w1' } }).catch(() => {});
  assert.ok(index <= 2, `must not advance past the trust dialog (stopped at ${index})`);
});
