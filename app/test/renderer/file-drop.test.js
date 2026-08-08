'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dragCarriesFiles,
  isImageFile,
  splitDroppedFiles,
  appendPaths,
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

test('paths append with the same spacing rule the + add-files menu uses', () => {
  assert.equal(appendPaths('', ['/tmp/a.pdf']), '/tmp/a.pdf ');
  assert.equal(appendPaths('look at', ['/tmp/a.pdf']), 'look at /tmp/a.pdf ');
  assert.equal(appendPaths('look at ', ['/tmp/a.pdf']), 'look at /tmp/a.pdf ');
  assert.equal(appendPaths('x', ['/tmp/a', '/tmp/b']), 'x /tmp/a /tmp/b ');
  assert.equal(appendPaths('unchanged', []), 'unchanged', 'nothing resolvable leaves the draft alone');
  assert.equal(appendPaths('unchanged', ['', '   ']), 'unchanged');
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
  assert.equal(dropReport({ attached: 2 }), '2 images attached');
  assert.equal(dropReport({ attached: 1 }), '1 image attached');
  assert.equal(dropReport({ paths: 1 }), '1 path added');
  assert.equal(dropReport({ attached: 1, paths: 2, unresolved: 1 }),
    '1 image attached, 2 paths added, 1 file could not be read');
  assert.equal(dropReport({ unresolved: 2 }), '2 files could not be read');
  assert.equal(dropReport({}), null);
});
