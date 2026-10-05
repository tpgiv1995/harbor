'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCrashCapture, newestDump } = require('../../src/main/crash-capture.js');

// A minimal stand-in for the Electron surface the module touches: setPath,
// crashReporter.start, and app.on. Records call order so the ordering contract
// (setPath must precede start) can be asserted.
function fakeElectron() {
  const order = [];
  const listeners = {};
  const startOpts = [];
  const app = {
    setPath: (key, value) => order.push(['setPath', key, value]),
    on: (event, handler) => { (listeners[event] ||= []).push(handler); order.push(['on', event]); },
  };
  const crashReporter = {
    start: (opts) => { startOpts.push(opts); order.push(['start']); },
  };
  return { app, crashReporter, order, listeners, startOpts };
}

test('arm sets the dump dir before starting, and never uploads', () => {
  const { app, crashReporter, order, startOpts } = fakeElectron();
  const lines = [];
  const cap = createCrashCapture({
    crashReporter, app, dumpDir: 'D:/dumps', log: (l) => lines.push(l), findNewestDump: () => null,
  });

  const result = cap.arm();

  assert.equal(result.armed, true);
  assert.equal(cap.armed, true);
  // Ordering: setPath('crashDumps', dir) must come before start().
  const iSet = order.findIndex((c) => c[0] === 'setPath');
  const iStart = order.findIndex((c) => c[0] === 'start');
  assert.ok(iSet !== -1 && iStart !== -1, 'both setPath and start were called');
  assert.ok(iSet < iStart, 'setPath happened before start');
  assert.deepEqual(order[iSet], ['setPath', 'crashDumps', 'D:/dumps']);
  // The whole point: a crash dump can carry memory, so it must never leave the box.
  assert.equal(startOpts[0].uploadToServer, false);
  // An armed breadcrumb is logged so a future reader can confirm capture is on.
  assert.ok(lines.some((l) => l.kind === 'crash-capture' && /armed/.test(l.message)));
});

test('a renderer death logs a crash-dump line naming the newest dump', () => {
  const { app, crashReporter, listeners } = fakeElectron();
  const lines = [];
  const cap = createCrashCapture({
    crashReporter, app, dumpDir: 'D:/dumps', log: (l) => lines.push(l),
    findNewestDump: () => 'D:/dumps/abc.dmp',
  });
  cap.arm();

  // The module registers its OWN app-level render-process-gone listener; fire it.
  const handler = (listeners['render-process-gone'] || [])[0];
  assert.equal(typeof handler, 'function', 'a render-process-gone listener was registered');
  handler({}, {}, { reason: 'crashed', exitCode: -36861 });

  const note = lines.find((l) => l.kind === 'crash-dump');
  assert.ok(note, 'a crash-dump line was written');
  assert.equal(note.source, 'renderer');
  assert.equal(note.reason, 'crashed');
  assert.equal(note.exitCode, -36861);
  assert.equal(note.dump, 'D:/dumps/abc.dmp');
});

test('arm is idempotent: it does not start Crashpad twice', () => {
  const { app, crashReporter, startOpts } = fakeElectron();
  const cap = createCrashCapture({ crashReporter, app, dumpDir: 'D:/dumps', log: () => {}, findNewestDump: () => null });
  cap.arm();
  cap.arm();
  assert.equal(startOpts.length, 1);
});

test('arm never throws, and records the failure, when start() throws', () => {
  const app = { setPath: () => {}, on: () => {} };
  const crashReporter = { start: () => { throw new Error('crashpad unavailable'); } };
  const lines = [];
  const cap = createCrashCapture({ crashReporter, app, dumpDir: 'D:/dumps', log: (l) => lines.push(l), findNewestDump: () => null });

  assert.doesNotThrow(() => cap.arm());
  assert.equal(cap.armed, false);
  assert.ok(lines.some((l) => l.kind === 'crash-capture' && /failed to arm/.test(l.message)));
});

test('constructor rejects a missing Electron surface', () => {
  assert.throws(() => createCrashCapture({ app: { on() {} } }), /crashReporter/);
  assert.throws(() => createCrashCapture({ crashReporter: { start() {} } }), /app/);
});

test('newestDump returns null on a missing directory instead of throwing', () => {
  assert.equal(newestDump(path.join(os.tmpdir(), 'harbor-no-such-dir-xyz')), null);
});

test('newestDump picks the most recently written .dmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-crash-'));
  try {
    const older = path.join(dir, 'older.dmp');
    const newer = path.join(dir, 'newer.dmp');
    fs.writeFileSync(older, 'x');
    fs.writeFileSync(newer, 'y');
    // Force a distinct, later mtime on `newer` so the comparison is deterministic.
    const base = Date.now();
    fs.utimesSync(older, new Date(base - 10_000), new Date(base - 10_000));
    fs.utimesSync(newer, new Date(base), new Date(base));
    // A non-.dmp file must be ignored.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'z');
    assert.equal(newestDump(dir), newer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
