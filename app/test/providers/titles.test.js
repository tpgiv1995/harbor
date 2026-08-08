'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTitlesProvider, scheduleTitler } = require('../../src/main/providers/titles.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-titles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  const titlesFile = path.join(cacheDir, 'session-titles.json');
  const indexFile = path.join(cacheDir, 'index.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { root, cacheDir, titlesFile, indexFile };
}

test('worker sessions are refused while the same title drive succeeds for an ordinary session', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: {
      worker: { id: 'worker-id', mt: 2, last: '2026-08-04T12:00:00Z', first_prompt: 'BATCH TITLE: secret worker', recent: [] },
      ordinary: { id: 'ordinary-id', mt: 1, last: '2026-08-04T11:00:00Z', first_prompt: 'Port the title generator to Node', recent: [] },
    },
  }));
  const requests = [];
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    key: 'test-key',
    now: () => new Date('2026-08-04T13:00:00Z'),
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Node Session Titles.' }] }) };
    },
  });

  const result = await provider.run({ all: true });

  assert.equal(result.titled, 1, 'the allowed ordinary drive must reach the API and write a title');
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /Port the title generator to Node/);
  assert.doesNotMatch(requests[0].messages[0].content, /secret worker/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')), {
    v: 1,
    titles: { 'ordinary-id': 'Node Session Titles' },
  });
});

test('retryable API failures are retried before the title is cached', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: { ordinary: { id: 'ordinary-id', mt: 1, last: '2026-08-04T11:00:00Z', first_prompt: 'Retry this title', recent: [] } },
  }));
  let attempts = 0;
  const waits = [];
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    key: 'test-key',
    sleep: async (ms) => waits.push(ms),
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Recovered Title' }] }) };
    },
  });

  const result = await provider.run({ all: true });

  assert.equal(result.titled, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1500, 3000]);
  assert.deepEqual(fs.readdirSync(files.cacheDir).sort(), ['index.json', 'session-titles.json']);
});

test('HARBOR_NO_TITLER refuses the scheduler and the same scheduler runs when allowed', async () => {
  const scheduled = [];
  const run = async () => { scheduled.push('ran'); return { titled: 0 }; };
  const setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return 7; };

  const refused = scheduleTitler({ env: { HARBOR_NO_TITLER: '1' }, run, setTimeout });
  assert.equal(refused.scheduled, false);
  assert.deepEqual(scheduled, []);

  const allowed = scheduleTitler({ env: {}, run, setTimeout });
  assert.equal(allowed.scheduled, true);
  assert.equal(scheduled[0].delay, 15_000);
  await scheduled[0].callback();
  assert.deepEqual(scheduled.slice(1), ['ran']);
});

test('HARBOR_TITLER_FORCE refuses E2E by default and allows the same E2E drive when set', async () => {
  const scheduled = [];
  const setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return 8; };
  const run = async () => { scheduled.push('ran'); return { titled: 0 }; };

  const refused = scheduleTitler({ env: {}, e2eMode: true, run, setTimeout });
  assert.equal(refused.scheduled, false);
  assert.deepEqual(scheduled, []);

  const allowed = scheduleTitler({ env: { HARBOR_TITLER_FORCE: '1' }, e2eMode: true, run, setTimeout });
  assert.equal(allowed.scheduled, true);
  await scheduled[0].callback();
  assert.deepEqual(scheduled.slice(1), ['ran']);
});

test('HARBOR_TITLER_DELAY_MS refuses execution before its delay and allows it at the delay', async () => {
  let callback;
  let delay;
  let runs = 0;
  const scheduled = scheduleTitler({
    env: { HARBOR_TITLER_DELAY_MS: '2345' },
    run: async () => { runs += 1; return { titled: 0 }; },
    setTimeout: (next, ms) => { callback = next; delay = ms; return 9; },
  });

  assert.equal(scheduled.scheduled, true);
  assert.equal(delay, 2345);
  assert.equal(runs, 0, 'the drive must be refused before the configured delay');
  await callback();
  assert.equal(runs, 1, 'the same drive must run when the configured delay elapses');
});
