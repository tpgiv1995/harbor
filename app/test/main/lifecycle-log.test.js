'use strict';
// Harbor's main process leaves a durable record of how it started and how it
// ended. Live-caught 2026-09-04: six boots in eighteen minutes, at least two
// of which exited before drawing a window, and NOTHING on the machine said
// why, because the app is launched from a shortcut (stdout goes nowhere) and
// wrote no log of its own. The daemon has had sessiond.log since 2026-08-14 for
// exactly this reason; the app gets the same courtesy here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLifecycleLog } = require('../../src/main/lifecycle-log.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-lifecycle-'));
}

test('note appends one JSON line per event with pid and timestamp', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'lifecycle.jsonl');
  const log = createLifecycleLog({ file, now: () => new Date('2026-09-05T03:12:47.659Z'), pid: 4242 });
  log.note('boot', { argv: ['electron', 'app'] });
  log.note('startup-failed', { error: 'boom' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { at: '2026-09-05T03:12:47.659Z', pid: 4242, kind: 'boot', argv: ['electron', 'app'] },
    { at: '2026-09-05T03:12:47.659Z', pid: 4242, kind: 'startup-failed', error: 'boom' },
  ]);
});

test('the file rotates once past its cap so it never grows without bound', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'lifecycle.jsonl');
  const log = createLifecycleLog({ file, maxBytes: 200, pid: 1 });
  for (let i = 0; i < 20; i += 1) log.note('tick', { i, pad: 'x'.repeat(30) });
  assert.ok(fs.existsSync(`${file}.1`), 'the previous file was rotated aside');
  assert.ok(fs.statSync(file).size < 400, 'the live file restarted small');
});

test('an unwritable location never throws into the app', () => {
  const file = path.join(tmpDir(), 'not-a-dir-file');
  fs.writeFileSync(file, 'occupied');
  const log = createLifecycleLog({ file: path.join(file, 'lifecycle.jsonl'), pid: 1 });
  assert.doesNotThrow(() => log.note('boot', {}));
});

test('a disabled log is a no-op that writes nothing', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'lifecycle.jsonl');
  const log = createLifecycleLog({ file, enabled: false, pid: 1 });
  log.note('boot', {});
  assert.equal(fs.existsSync(file), false);
});
