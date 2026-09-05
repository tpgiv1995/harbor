'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dragCarriesFiles,
  isImageFile,
  splitDroppedFiles,
  fileAttachmentsFromPaths,
  imageAttachment,
  imageExtension,
  dropPrompt,
  dropReport,
} = require('../../src/renderer/stage/file-drop.cjs');

test('only file drags are claimed, so dropping text or a link still behaves normally', () => {
  assert.equal(dragCarriesFiles(['Files']), true);
  assert.equal(dragCarriesFiles(['text/plain', 'Files']), true);
  assert.equal(dragCarriesFiles(['text/plain', 'text/uri-list']), false);
  assert.equal(dragCarriesFiles([]), false);
  assert.equal(dragCarriesFiles(undefined), false);
  // A DOMStringList is array-like, not an array.
  assert.equal(dragCarriesFiles({ length: 1, 0: 'Files', [Symbol.iterator]: Array.prototype[Symbol.iterator] }), true);
});

test('images are recognized by MIME type, and by extension when the OS sends none', () => {
  assert.equal(isImageFile({ name: 'shot.png', type: 'image/png' }), true);
  assert.equal(isImageFile({ name: 'shot.PNG', type: '' }), true, 'a file manager can send an empty type');
  assert.equal(isImageFile({ name: 'photo.jpeg', type: '' }), true);
  assert.equal(isImageFile({ name: 'notes.md', type: 'text/markdown' }), false);
  assert.equal(isImageFile({ name: 'archive.png.zip', type: 'application/zip' }), false);
  assert.equal(isImageFile(null), false);
});

test('a mixed drop splits into the paste path and the add-files path', () => {
  const { images, others } = splitDroppedFiles([
    { name: 'a.png', type: 'image/png' },
    { name: 'report.pdf', type: 'application/pdf' },
    { name: 'b.jpg', type: 'image/jpeg' },
  ]);
  assert.deepEqual(images.map((f) => f.name), ['a.png', 'b.jpg']);
  assert.deepEqual(others.map((f) => f.name), ['report.pdf']);
});

test('image drops keep the pasted-image attachment shape and preview bytes', () => {
  assert.deepEqual(imageAttachment('/tmp/paste-1.png', 'data:image/png;base64,AAA'), {
    kind: 'image',
    path: '/tmp/paste-1.png',
    thumbDataUri: 'data:image/png;base64,AAA',
  });
});

test('N resolved non-image paths become N removable file-chip model entries', () => {
  assert.deepEqual(fileAttachmentsFromPaths([
    '/tmp/a.pdf',
    'C:\\work\\notes.md',
    '/tmp/archive.zip',
  ]), [
    { kind: 'file', path: '/tmp/a.pdf', basename: 'a.pdf' },
    { kind: 'file', path: 'C:\\work\\notes.md', basename: 'notes.md' },
    { kind: 'file', path: '/tmp/archive.zip', basename: 'archive.zip' },
  ]);
  assert.deepEqual(fileAttachmentsFromPaths(['', '   ', null]), []);
});

test('the saved extension follows the real type, never a guess that renames the file', () => {
  assert.equal(imageExtension({ name: 'x', type: 'image/jpeg' }), 'jpg');
  assert.equal(imageExtension({ name: 'x', type: 'image/png' }), 'png');
  assert.equal(imageExtension({ name: 'x', type: 'image/webp' }), 'webp');
  assert.equal(imageExtension({ name: 'shot.gif', type: '' }), 'gif');
  assert.equal(imageExtension({ name: 'noext', type: '' }), 'png');
});

test('the overlay refuses honestly when there is no session to attach to', () => {
  assert.deepEqual(dropPrompt({ hasSession: false }), {
    kind: 'refused', text: 'Select a session window first',
  });
  assert.deepEqual(dropPrompt({ hasSession: true, sessionTitle: 'Fix the rail' }), {
    kind: 'ready', text: 'Drop to attach to Fix the rail',
  });
  assert.equal(dropPrompt({ hasSession: true, sessionTitle: null }).kind, 'ready');
});

test('the post-drop report counts what landed AND what did not', () => {
  assert.equal(dropReport({ images: 2 }), '2 images attached');
  assert.equal(dropReport({ images: 1 }), '1 image attached');
  assert.equal(dropReport({ files: 1 }), '1 file attached');
  assert.equal(dropReport({ images: 1, files: 2, unresolved: 1 }),
    '1 image attached, 2 files attached, 1 file could not be read');
  assert.equal(dropReport({ unresolved: 2 }), '2 files could not be read');
  assert.equal(dropReport({}), null);
});
