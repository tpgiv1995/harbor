'use strict';

// NOT EVERY BYTE INTO A PANE IS A PERSON (2026-10-19).
//
// The keeper's `input` verb carries what the app's terminal sends, and a
// terminal answers the CLI's own queries through that same channel: focus
// in/out when a pane gains or loses focus (mode 1004), cursor-position and
// device-attribute replies, mode reports, window-size reports, OSC colour
// replies, XTVERSION, and mouse reports when the CLI has turned tracking on.
// None of that is someone typing. Counting it would let the app reattaching
// to a pane (it answers the CLI's capability probes again) or a user merely
// clicking through panes stamp `last_input_at` on a session nobody has
// written to in days, which is the exact failure `last_input_at` exists to
// fix for pty output.
//
// So a write is a terminal reply only when it consists ENTIRELY of such
// sequences. Anything else, including a single printable byte, an Enter, a
// bracketed paste or an arrow key, is user input. The asymmetry is
// deliberate: misreading a keystroke as a reply would make a session look
// more idle than it is, so the patterns are exact and anchored.
const TERMINAL_REPLY = new RegExp([
  '\\x1b\\[[IO]',                        // focus in / focus out
  '\\x1b\\[\\??\\d+(?:;\\d+)*R',         // cursor position report (CPR, DECXCPR)
  '\\x1b\\[[?>=][\\d;]*c',               // primary / secondary / tertiary device attributes
  '\\x1b\\[\\??[\\d;]*\\$y',             // DECRPM mode report
  '\\x1b\\[\\?\\d*u',                    // kitty keyboard flags reply
  '\\x1b\\[\\d+(?:;\\d+)*t',             // window size / position reports
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC reply (colour queries)
  '\\x1bP[^\\x1b]*\\x1b\\\\',            // DCS reply (XTVERSION, DECRQSS)
  '\\x1b\\[<\\d+;\\d+;\\d+[Mm]',         // SGR mouse report
  '\\x1b\\[M[\\s\\S]{3}',                // X10 mouse report
].map((source) => `(?:${source})`).join('|'), 'y');

function isTerminalReply(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  TERMINAL_REPLY.lastIndex = 0;
  while (TERMINAL_REPLY.lastIndex < text.length) {
    const start = TERMINAL_REPLY.lastIndex;
    if (!TERMINAL_REPLY.test(text) || TERMINAL_REPLY.lastIndex === start) return false;
  }
  return true;
}

module.exports = { isTerminalReply };
