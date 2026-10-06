'use strict';

// One block key is one bubble (2026-10-06, Pat: "messages appear to be sending
// and receiving twice"). See src/shared/transcript-blocks.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');

const block = (key, text) => ({ key, kind: 'user', text });

test('an append whose block is already shown updates it instead of drawing it twice', () => {
  const shown = [block('b0', 'hi'), block('b1', 'queued message')];
  const next = applyTranscriptUpdate(shown, { append: [block('b1', 'queued message'), block('b2', 'reply')] });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
});

test('the delivered copy wins, in place, so a late image still lands on its bubble', () => {
  const shown = [block('b0', 'a'), block('b1', 'b'), block('b2', 'c')];
  const withImage = { ...block('b1', 'b'), images: [{ dataUri: 'data:image/png;base64,x' }] };
  const next = applyTranscriptUpdate(shown, { append: [withImage] });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
  assert.equal(next[1].images.length, 1);
});

test('replace, changed and a plain append behave as before', () => {
  const shown = [block('b0', 'a'), { key: 'b1', kind: 'action', status: 'pending' }];
  assert.deepEqual(applyTranscriptUpdate(shown, { replace: [block('b9', 'z')] }), [block('b9', 'z')]);
  const next = applyTranscriptUpdate(shown, {
    changed: [{ key: 'b1', kind: 'action', status: 'ok' }],
    append: [block('b2', 'c')],
  });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
  assert.equal(next[1].status, 'ok');
  assert.equal(applyTranscriptUpdate(shown, { append: [], changed: [] }), shown, 'an empty delta keeps the same array');
});

test('a repeated key inside one append is drawn once', () => {
  const next = applyTranscriptUpdate([], { append: [block('b0', 'x'), block('b0', 'x')] });
  assert.equal(next.length, 1);
});
