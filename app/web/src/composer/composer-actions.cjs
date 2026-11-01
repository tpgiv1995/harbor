'use strict';

// What the composer card's toolbar draws on the right (2026-10-31, Pat, from a
// screenshot of a working session: "change the ui for the 'stop' button so it's
// either like on the same line as send button or maybe below it... Ideally want
// to give the text box line as much width as possible").
//
// The pattern is the established chat-composer card (Claude and ChatGPT on the
// phone, Vercel AI Elements' PromptInput: attachments on top, the text box at the
// card's full width, a toolbar along the bottom edge with tools on the left and
// the actions on the right). The rule that makes it hold still:
//   idle                    [Send]
//   a turn is running       [Stop] [Send]
// Send is always the rightmost button and Stop, when it is there, is always the
// one just left of it, so a button never changes place when a draft appears or
// goes (Cursor and Codex do the same: a draft typed during a turn queues behind
// it while Stop stays). Send is muted until there is something to send.
//
// Pure, so the node tests can pin the rule and the component stays a renderer.

// A draft is anything Send would send: text with a character in it, or an
// attachment. Whitespace alone is not a draft (Send stays disabled for it).
function hasDraft(text, attachmentCount) {
  return Boolean(String(text ?? '').trim()) || Number(attachmentCount) > 0;
}

function composerActions({ canStop, hasDraft: draft } = {}) {
  return { stop: Boolean(canStop), sendReady: Boolean(draft) };
}

module.exports = { composerActions, hasDraft };
