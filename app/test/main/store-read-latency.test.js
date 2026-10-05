'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { holdStoreLock } = require('../support/held-store-lock.cjs');
for (const kind of ['notes', 'tasks']) {
  const createStore = require(`../../src/main/providers/${kind}.js`)[kind === 'notes' ? 'createNoteStore' : 'createTaskStore'];
  for (const queuedWrite of [false, true]) {
    test(`${kind}: held-lock read takes under 500ms${queuedWrite ? ' even behind a queued mutation' : ''}`, { timeout: 9500 }, async (t) => {
      const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-fast-read-'));
      const file = path.join(dir, kind + '.json');
      const before = JSON.stringify({ version: 1, [kind]: [{ title: 'Saved text without an ID' }] });
      fs.writeFileSync(file, before);
      const store = createStore({ file });
      t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      await holdStoreLock(t, file + '.lock');
      const mutation = queuedWrite ? store.mutate({ type: kind === 'notes' ? 'note.add' : 'task.add', title: 'Refused' }) : null;
      const start = performance.now();
      const result = await store.read();
      const elapsed = performance.now() - start;
      t.diagnostic(`held-lock read ${kind}, queued=${queuedWrite}: ${elapsed.toFixed(1)}ms`);
      try {
        assert.equal(result.ok, true);
        assert.equal(result.repairDeferred, true);
        assert.equal(result.doc[kind][0].title, 'Saved text without an ID');
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        assert.ok(elapsed < 500, `read stalled for ${elapsed.toFixed(1)}ms`);
      } finally { if (mutation) assert.equal((await mutation).ok, false, 'writes keep their refusal contract'); }
    });
  }
}
