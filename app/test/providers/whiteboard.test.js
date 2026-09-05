'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createWhiteboardStore, resolveBoardsDir } = require('../../src/main/providers/whiteboard.js');

const scene = (elements = [], files = {}) => ({
  type: 'excalidraw', version: 2, source: 'local', elements, appState: {}, files,
});

test('whiteboard directory precedence is env, config, then userData', () => {
  assert.equal(resolveBoardsDir({ env: { HARBOR_BOARDS_DIR: 'C:\\tmp\\boards' }, configuredDir: 'ignored' }), path.resolve('C:\\tmp\\boards'));
  assert.equal(resolveBoardsDir({ env: {}, configuredDir: 'configured' }), path.resolve('configured'));
  assert.equal(resolveBoardsDir({ env: {}, app: { getPath: () => 'profile' } }), path.join('profile', 'boards'));
});

test('whiteboard store creates, writes, backs up, renames, orders, and trashes boards', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-whiteboard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-08-25T12:00:00.000Z');
  const store = createWhiteboardStore({ dir, now: () => clock });

  const first = await store.create({ name: 'Ideas & Images' });
  assert.equal(first.board.id, 'ideas-and-images');
  clock += 1000;
  const second = await store.create({ name: 'Ideas & Images' });
  assert.equal(second.board.id, 'ideas-and-images-2');

  const file = { id: 'image-1', dataURL: 'data:image/png;base64,AA==', mimeType: 'image/png', created: clock };
  clock += 1000;
  const written = await store.write({
    id: first.board.id,
    scene: scene([{ id: 'rect-1', type: 'rectangle' }], { [file.id]: file }),
  });
  assert.equal(written.ok, true);
  assert.equal(written.board.elements[0].type, 'rectangle');
  assert.equal(written.board.files['image-1'].dataURL, file.dataURL);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'ideas-and-images.json.bak'), 'utf8')).name, 'Ideas & Images');

  const listed = await store.list();
  assert.deepEqual(listed.boards.map(({ id }) => id), ['ideas-and-images', 'ideas-and-images-2']);
  const renamed = await store.rename({ id: first.board.id, name: 'Reference Wall' });
  assert.equal(renamed.board.id, 'reference-wall');
  assert.equal((await store.read({ id: 'reference-wall' })).board.files['image-1'].dataURL, file.dataURL);

  const removed = await store.delete({ id: 'reference-wall' });
  assert.equal(removed.ok, true);
  assert.match(removed.trashPath, /[\\\/]\.trash[\\\/].+\.json$/);
  assert.equal((await store.read({ id: 'reference-wall' })).ok, false);
});

// H1 (b6 review): a CLI write to a board the user has OPEN must reach the app,
// so the store watches its directory the way notes.js does. The store's OWN
// writes are suppressed (lastWritten text compare), an outside write notifies
// with the board's metadata, and an outside removal notifies removed: true.
test('outside board writes reach subscribers while self writes are suppressed', async (t) => {
  const dir = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-whiteboard-watch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-08-29T12:00:00.000Z');
  const store = createWhiteboardStore({ dir, now: () => clock });
  const created = await store.create({ name: 'Watched Board' });
  const id = created.board.id;

  const seen = [];
  const unsubscribe = store.subscribe((payload) => seen.push(payload));

  clock += 1000;
  await store.write({ id, scene: scene([{ id: 'own-edit', type: 'rectangle' }]) });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(seen, [], 'the store does not echo its own write');

  const file = path.join(dir, `${id}.json`);
  const outside = JSON.parse(await fs.readFile(file, 'utf8'));
  outside.elements.push({ id: 'cli-sticky', type: 'rectangle' });
  outside.updatedAt = new Date(clock + 5000).toISOString();
  await fs.writeFile(file, `${JSON.stringify(outside, null, 2)}\n`, 'utf8');
  let deadline = Date.now() + 4000;
  while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.length, 1, 'the outside write notified');
  assert.equal(seen[0].id, id);
  assert.equal(seen[0].name, 'Watched Board');
  assert.equal(seen[0].updatedAt, outside.updatedAt);
  assert.equal(seen[0].removed, undefined);

  await fs.rm(file);
  deadline = Date.now() + 4000;
  while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen[1], { id, removed: true });

  unsubscribe();
  store.close();
});

test('corrupt boards are quarantined and never overwritten', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-whiteboard-corrupt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'broken.json');
  await fs.writeFile(target, '{not json', 'utf8');
  const store = createWhiteboardStore({ dir, now: () => Date.parse('2026-08-25T12:00:00.000Z') });
  const read = await store.read({ id: 'broken' });
  assert.equal(read.ok, false);
  assert.equal(read.recovery.kind, 'corrupt');
  assert.equal(await fs.readFile(read.recovery.detail, 'utf8'), '{not json');
  assert.equal((await store.write({ id: 'broken', scene: scene() })).ok, false);
  await assert.rejects(fs.access(target));
});
