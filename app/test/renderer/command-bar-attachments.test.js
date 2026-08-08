'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendTranscription,
  attachmentsAfterSend,
  classifyPasteItems,
} = require('../../src/renderer/stage/command-bar-attachments.cjs');

test('Whisper transcription is appended to the existing composer draft for review', () => {
  assert.equal(appendTranscription('Existing draft', 'spoken words'), 'Existing draft spoken words');
  assert.equal(appendTranscription('Existing draft\n', 'spoken words'), 'Existing draft\nspoken words');
  assert.equal(appendTranscription('', 'spoken words'), 'spoken words');
});

test('stage -> successful send clears exactly the submitted image attachments', () => {
  const first = { path: '/tmp/first.png', thumbDataUri: 'data:image/png;base64,first' };
  const second = { path: '/tmp/second.png', thumbDataUri: 'data:image/png;base64,second' };

  assert.deepEqual(attachmentsAfterSend([first, second], [first, second], true), []);
});

test('stage -> failed send retains image attachments for retry', () => {
  const staged = [{ path: '/tmp/retry.png', thumbDataUri: null }];

  assert.deepEqual(attachmentsAfterSend(staged, staged, false), staged);
});

test('a successful send does not clear an image staged while that send was in flight', () => {
  const submitted = { path: '/tmp/submitted.png', thumbDataUri: null };
  const stagedLater = { path: '/tmp/later.png', thumbDataUri: null };

  assert.deepEqual(
    attachmentsAfterSend([submitted, stagedLater], [submitted], true),
    [stagedLater],
  );
});

test('paste classification stages direct images, falls back only for itemless paste, and leaves text alone', () => {
  const image = { kind: 'file', type: 'image/png' };
  assert.deepEqual(classifyPasteItems([image]), { imageItem: image, readClipboardImage: false });
  assert.deepEqual(classifyPasteItems([]), { imageItem: null, readClipboardImage: true });
  assert.deepEqual(
    classifyPasteItems([{ kind: 'string', type: 'text/plain' }]),
    { imageItem: null, readClipboardImage: false },
  );
});
