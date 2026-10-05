'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { holdStoreLock } = require('../support/held-store-lock.cjs');

for (const kind of ['notes', 'tasks']) {
  const { [kind === 'notes' ? 'createNoteStore' : 'createTaskStore']: createStore } = require(`../../src/main/providers/${kind}.js`);
  for (const mutation of [true, false]) {
    test(`harbor-${kind}: held lock ${mutation ? 'reports a retryable mutation refusal, never a TypeError' : 'still permits listing saved work'}`, { timeout: 12000 }, async (t) => {
      const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-cli-lock-'));
      const file = path.join(dir, `${kind}.json`);
      const store = createStore({ file });
      t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      const added = await store.mutate({ type: `${kind === 'notes' ? 'note' : 'task'}.add`, title: 'Saved work' });
      assert.equal(added.ok, true);
      const before = fs.readFileSync(file, 'utf8');
      await holdStoreLock(t, file + '.lock');
      const args = mutation ? ['update', added.noteId || added.taskId, '--title', 'must not save'] : ['list'];
      const result = spawnSync(process.execPath, [path.join(__dirname, '../../../bin', `harbor-${kind}`), ...args, '--json'], {
        windowsHide: true, encoding: 'utf8', timeout: 9000,
        env: { ...process.env, [`HARBOR_${kind.toUpperCase()}_FILE`]: file },
      });
      assert.ifError(result.error);
      t.diagnostic(`CLI pid: ${result.pid} exited ${result.status}`);
      assert.doesNotMatch(result.stdout + result.stderr, /TypeError|Cannot read properties|undefined/);
      const payload = JSON.parse(result.stdout);
      if (mutation) {
        assert.equal(result.status, 1);
        assert.equal(payload.ok, false);
        assert.equal(payload.retryable, true);
        assert.match(payload.error, /lock.*retry/i);
        assert.match(result.stderr, /lock.*retry/i);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(payload.ok, true);
        assert.equal(payload[kind][0].title, 'Saved work');
        assert.equal(payload.repairDeferred, true);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
  }
}
