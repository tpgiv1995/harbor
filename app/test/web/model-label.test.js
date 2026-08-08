'use strict';

// The phone and the desktop must name a model the same way.
//
// AppShell's own comment claimed they could not drift, one line above the code
// that drifted: it capitalized only the first hyphen-separated segment, so the
// codex model `gpt-5.6-sol` read "Gpt 5.6 sol" on the phone and "Gpt 5.6 Sol"
// on the desktop. That divergence shipped inside two published README
// screenshots of the SAME session before anybody noticed, which is what a claim
// with no test behind it is worth.
//
// This runs both formatters over the same ids and requires the same answer, so
// the claim is now checked rather than asserted in a comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelDisplay } = require('../../src/main/providers/transcript.js');

// Ids with a table entry in modelDisplay are named from that table, which the
// phone has no copy of and never will; the shared rule is the FALLBACK, which
// is what every non-Claude model goes through.
const UNTABLED = [
  'gpt-5.6-sol',
  'gpt-5.6',
  'composer-1',
  'grok-code-fast-1',
  'some-future-model-x',
];

test('the phone and the desktop derive the same label from a model id', async () => {
  const { prettyModelId } = await import('../../web/src/shell/model-label.js');
  for (const id of UNTABLED) {
    const desktop = modelDisplay(id).name;
    assert.equal(prettyModelId(id), desktop, `phone and desktop disagree about ${id}`);
  }
  // The one place they deliberately differ: the phone rejoins a split version
  // number, because `claude-opus-4-5` reaching it as a raw id should read as a
  // version and not as two numbers.
  assert.equal(prettyModelId('claude-opus-4-5'), 'Opus 4.5');
  assert.equal(prettyModelId('claude-opus-5'), 'Opus 5');
  assert.equal(prettyModelId(''), '');
  assert.equal(prettyModelId(null), '');
});
