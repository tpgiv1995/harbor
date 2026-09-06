'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendTranscription,
  attachmentsAfterSend,
  fileAttachmentsFromPaths,
  removeAttachmentAt,
  composeOutgoingText,
  imageAttachmentPaths,
  classifyPasteItems,
  attachmentPreviewPlan,
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

test('chip removal removes only the selected file attachment', () => {
  const chips = fileAttachmentsFromPaths(['/tmp/a.pdf', '/tmp/b.md', '/tmp/c.zip']);
  assert.deepEqual(removeAttachmentAt(chips, 1).map((chip) => chip.basename), ['a.pdf', 'c.zip']);
});

test('send appends each file path on its own line at the end and sends images separately', () => {
  const attachments = [
    { kind: 'file', path: 'C:\\work\\brief one.pdf', basename: 'brief one.pdf' },
    { kind: 'image', path: 'C:\\cache\\shot.png', thumbDataUri: null },
    { kind: 'file', path: 'C:\\work\\notes.md', basename: 'notes.md' },
  ];
  assert.equal(
    composeOutgoingText('Review these please', attachments),
    'Review these please\nC:\\work\\brief one.pdf\nC:\\work\\notes.md',
  );
  assert.equal(
    composeOutgoingText('', attachments),
    'C:\\work\\brief one.pdf\nC:\\work\\notes.md',
  );
  assert.deepEqual(imageAttachmentPaths(attachments), ['C:\\cache\\shot.png']);
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

test('a pasted attachment previews from the bytes it already carries', () => {
  const plan = attachmentPreviewPlan({
    path: 'C:\\Users\\you\\.cache\\harbor\\pastes\\paste-1.png',
    thumbDataUri: 'data:image/png;base64,AAA',
  });
  assert.equal(plan.src, 'data:image/png;base64,AAA');
  assert.equal(plan.needsFetch, false);
  assert.equal(plan.name, 'paste-1.png', 'the name is the file leaf, on either separator');
});

test('file attachments never enter the image preview or clipboard attachment path', () => {
  const file = { kind: 'file', path: '/tmp/report.pdf', basename: 'report.pdf' };
  assert.equal(attachmentPreviewPlan(file), null);
  assert.deepEqual(imageAttachmentPaths([file]), []);
});

test('an attachment with no bytes is read back off disk rather than opening blank', () => {
  // The Electron-clipboard path captures no data URI, and a draft restored from
  // localStorage carries paths only; both must still open when clicked.
  for (const file of [
    '/home/you/.cache/harbor/pastes/paste-2.png',
    'C:\\Users\\you\\.cache\\harbor\\pastes\\paste-2.png',
  ]) {
    const plan = attachmentPreviewPlan({ path: file, thumbDataUri: null });
    assert.equal(plan.needsFetch, true, file);
    assert.equal(plan.src, null, file);
    assert.equal(plan.name, 'paste-2.png', file);
  }
});

test('an unknown attachment shape is refused by preview planning without throwing', () => {
  for (const attachment of [{}, { path: '' }, null, undefined]) {
    const plan = attachmentPreviewPlan(attachment);
    assert.equal(plan, null, JSON.stringify(attachment));
  }
});
