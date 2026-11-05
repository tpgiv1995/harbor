'use strict';

// Claude Code's "send now" chord: Ctrl+X then Ctrl+S (keybinding chat:sendNow).
// A message typed while a turn is running sits in Claude's own queue until the
// turn ends, and the CLI shows "ctrl+x ctrl+s to send now" under it
// (test/fixtures/composer-enter/queued-above-box-2.1.280.txt); the chord
// delivers it into the running turn. It is a key chord, not text, so it goes in
// as two writes with a gap, the way a person presses it.
const CHORD_GAP_MS = 120;
const SEND_NOW_HINT = /ctrl\+x ctrl\+s to send now/i;

const showsSendNowHint = (screen) => SEND_NOW_HINT.test(String(screen || ''));

// `typeKey` writes one key and returns the bridge's answer ({ ok: false } is a
// refusal). The second key is never written after a refused first one: a bare
// Ctrl+S is a different binding.
async function sendNowChord(typeKey, sleep) {
  const first = await typeKey('\x18');
  if (first && first.ok === false) return first;
  await sleep(CHORD_GAP_MS);
  const second = await typeKey('\x13');
  if (second && second.ok === false) return second;
  return { ok: true };
}

module.exports = { sendNowChord, showsSendNowHint, CHORD_GAP_MS, SEND_NOW_HINT };
