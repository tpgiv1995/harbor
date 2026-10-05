'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createIconGenerator,
  projectsFromIndex,
  promptFor,
  scheduleIconGen,
} = require('../../src/main/providers/icon-gen.js');
const { iconSlugCandidates, resolveIconUrl } = require('../../src/renderer/stage/project-icon-slug.cjs');

const HOME = 'C:\\Users\\pat';
const HOUR = 3_600_000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-icon-gen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  const iconsDir = path.join(root, 'icons');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });
  return {
    root,
    cacheDir,
    iconsDir,
    indexFile: path.join(cacheDir, 'index.json'),
    stateFile: path.join(cacheDir, 'icon-gen.json'),
    keyFile: path.join(root, 'keys.env'),
  };
}

// One session per row unless stated; `spanHours` spreads first->last so a
// project can be made to look established or brand new.
function writeIndex(files, sessions) {
  const entries = {};
  let n = 0;
  for (const session of sessions) {
    const count = session.sessions ?? 1;
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const start = session.startedAt ?? Date.parse('2026-08-10T00:00:00Z');
      const last = start + (i === count - 1 ? (session.spanMs ?? 2 * HOUR) : 0);
      entries[`f${n}`] = {
        id: `${session.cwd}#${i}`,
        cwd: session.cwd,
        start: new Date(start).toISOString(),
        last: new Date(last).toISOString(),
      };
    }
  }
  fs.writeFileSync(files.indexFile, JSON.stringify({ v: 2, files: entries }));
}

function pngResponse(t, calls) {
  return async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: Buffer.from('fake-png-bytes').toString('base64') }] }),
    };
  };
}

function generator(files, overrides = {}) {
  return createIconGenerator({
    home: HOME,
    platform: 'win32',
    cacheDir: files.cacheDir,
    indexFile: files.indexFile,
    stateFile: files.stateFile,
    iconsDir: files.iconsDir,
    keyFiles: [files.keyFile],
    env: { HARBOR_ICON_GEN_KEY: 'test-key' },
    now: () => Date.parse('2026-08-12T12:00:00Z'),
    logger: { log() {}, warn() {} },
    ...overrides,
  });
}

test('an established project with no icon is generated, and the file it writes is the one the rail resolves', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: 'C:\\dev\\data-mapper-live', sessions: 3, spanMs: 4 * HOUR }]);
  const calls = [];
  const resized = [];
  const generate = generator(files, {
    fetch: pngResponse(t, calls),
    resizeToPng: (buffer, px) => { resized.push({ size: buffer.length, px }); return Buffer.from('sized-png'); },
  });

  const result = await generate.run();

  assert.equal(result.generated, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-image-2');
  assert.match(calls[0].prompt, /data mapper live/i, 'the label is what the icon depicts');
  assert.match(calls[0].prompt, /NO text/u, 'a 96px icon with words in it is mush');
  assert.deepEqual(resized, [{ size: 'fake-png-bytes'.length, px: 96 }], 'the API returns 1024px; the set on disk is 96px');

  // THE POINT OF THE WHOLE FEATURE: the written filename must be the one the
  // renderer's own resolver finds for that label. A generator naming files by
  // its own rule writes icons that never appear and never report a problem.
  const written = fs.readdirSync(files.iconsDir);
  assert.deepEqual(written, ['data-mapper-live.png']);
  const userIcons = Object.fromEntries(written.map((name) => [name.replace(/\.png$/u, ''), `url:${name}`]));
  assert.equal(resolveIconUrl('data-mapper-live', { userIcons }), 'url:data-mapper-live.png');
  assert.equal(fs.readFileSync(path.join(files.iconsDir, 'data-mapper-live.png'), 'utf8'), 'sized-png');
});

test('a nested label is saved under its own slug, never its parent', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: 'C:\\dev\\Surveys\\Intake', sessions: 3, spanMs: 4 * HOUR }]);
  const generate = generator(files, {
    fetch: pngResponse(t, []),
    resizeToPng: () => Buffer.from('sized-png'),
  });

  await generate.run();

  const written = fs.readdirSync(files.iconsDir);
  assert.deepEqual(written, ['surveys-intake.png']);
  assert.ok(
    iconSlugCandidates('Surveys/Intake').includes('surveys-intake'),
    'the written slug must be one the resolver actually looks for',
  );
  assert.ok(!written.includes('surveys.png'), 'writing the parent slug steals another project\'s icon');
});

test('a project that already has an icon is left alone, including via a fallback candidate', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(path.join(files.iconsDir, 'harbor.png'), 'existing');
  writeIndex(files, [
    { cwd: 'C:\\dev\\harbor', sessions: 5, spanMs: 8 * HOUR },
    { cwd: 'C:\\dev\\harbor\\app', sessions: 3, spanMs: 8 * HOUR },
  ]);
  const calls = [];
  const generate = generator(files, { fetch: pngResponse(t, calls), resizeToPng: () => Buffer.from('x') });

  const result = await generate.run();

  assert.equal(result.generated, 0, 'harbor has an icon; harbor/app resolves to it by parent fallback');
  assert.equal(calls.length, 0, 'no image was paid for');
});

// Two-sided ON PURPOSE: the bar has to keep scratch directories out AND let a
// real project through, or "never generates" would pass just as well as a
// feature that is simply switched off.
test('a scratch directory never earns an icon, while a real project does', async (t) => {
  const files = fixture(t);
  writeIndex(files, [
    { cwd: 'C:\\tools\\codex-gitprobe', sessions: 3, spanMs: 4 * 60_000 },
    { cwd: 'C:\\dev\\one-shot', sessions: 1, spanMs: 6 * HOUR },
    { cwd: 'C:\\dev\\real-project', sessions: 2, spanMs: 2 * HOUR },
  ]);
  const generate = generator(files, { fetch: pngResponse(t, []), resizeToPng: () => Buffer.from('x') });

  const planned = await generate.plan();

  assert.deepEqual(planned.map((item) => item.label), ['real-project']);
});

test('a drive root is a place, not a project, so it never earns an icon', async (t) => {
  const files = fixture(t);
  writeIndex(files, [
    { cwd: 'C:\\', sessions: 40, spanMs: 900 * HOUR },
    { cwd: 'C:\\dev\\genuine', sessions: 2, spanMs: 3 * HOUR },
  ]);
  const generate = generator(files, { fetch: pngResponse(t, []), resizeToPng: () => Buffer.from('x') });

  assert.deepEqual((await generate.plan()).map((item) => item.label), ['genuine']);
});

test('a foreign-era project is never generated for, because that folder is not on this machine', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: '/home/you/dev/old-linux-thing', sessions: 4, spanMs: 8 * HOUR }]);
  const generate = generator(files, { fetch: pngResponse(t, []), resizeToPng: () => Buffer.from('x') });

  assert.deepEqual(await generate.plan(), []);
});

// Deleting a generated icon is how the user says no. Saying it once is enough.
test('a generated icon that the user deletes is never regenerated', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: 'C:\\dev\\data-mapper-live', sessions: 3, spanMs: 4 * HOUR }]);
  const calls = [];
  const generate = generator(files, { fetch: pngResponse(t, calls), resizeToPng: () => Buffer.from('x') });

  assert.equal((await generate.run()).generated, 1);
  fs.rmSync(path.join(files.iconsDir, 'data-mapper-live.png'));
  const second = await generate.run();

  assert.equal(second.generated, 0);
  assert.equal(calls.length, 1, 'the second pass must not reach the API at all');
});

test('a failure is recorded, retried later, and given up on after three tries', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: 'C:\\dev\\flaky', sessions: 3, spanMs: 4 * HOUR }]);
  let clock = Date.parse('2026-08-12T12:00:00Z');
  const calls = [];
  const generate = generator(files, {
    now: () => clock,
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: false, status: 500, text: async () => 'boom' };
    },
    resizeToPng: () => Buffer.from('x'),
  });

  await generate.run();
  assert.equal(calls.length, 1);
  await generate.run();
  assert.equal(calls.length, 1, 'a fresh failure is not retried immediately');

  clock += 25 * HOUR;
  await generate.run();
  clock += 25 * HOUR;
  await generate.run();
  assert.equal(calls.length, 3);

  clock += 25 * HOUR;
  await generate.run();
  assert.equal(calls.length, 3, 'three failures is enough; it stops asking');
  assert.equal(fs.readdirSync(files.iconsDir).length, 0, 'a failed generation leaves no partial file');
});

test('one pass generates at most its limit, so a first launch is not a bulk order', async (t) => {
  const files = fixture(t);
  writeIndex(files, Array.from({ length: 9 }, (_unused, i) => (
    { cwd: `C:\\dev\\project-${i}`, sessions: 2, spanMs: 3 * HOUR }
  )));
  const calls = [];
  const generate = generator(files, { fetch: pngResponse(t, calls), resizeToPng: () => Buffer.from('x') });

  const result = await generate.run();

  assert.equal(result.candidates, 9);
  assert.equal(result.generated, 3);
  assert.equal(calls.length, 3);
});

test('no key is a supported machine, not an error, and costs no state', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: 'C:\\dev\\data-mapper-live', sessions: 3, spanMs: 4 * HOUR }]);
  const generate = generator(files, {
    env: {},
    fetch: () => { throw new Error('must not be called without a key'); },
  });

  const result = await generate.run();

  assert.equal(result.skipped, 'no-key');
  assert.equal(result.candidates, 1, 'it still says what it WOULD have done');
  assert.equal(fs.existsSync(files.stateFile), false, 'a keyless pass must not burn an attempt');
});

test('the key is read from the image-gen skill env file rather than a second copy of the secret', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.keyFile, '# keys\nFAL_KEY=nope\nOPENAI_API_KEY="sk-from-file"\n');
  writeIndex(files, [{ cwd: 'C:\\dev\\data-mapper-live', sessions: 3, spanMs: 4 * HOUR }]);
  const seen = [];
  const generate = generator(files, {
    env: {},
    fetch: async (_url, options) => {
      seen.push(options.headers.authorization);
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('p').toString('base64') }] }) };
    },
    resizeToPng: () => Buffer.from('x'),
  });

  await generate.run();

  assert.deepEqual(seen, ['Bearer sk-from-file']);
});

test('HARBOR_NO_ICON_GEN stops it dead', async (t) => {
  const files = fixture(t);
  writeIndex(files, [{ cwd: 'C:\\dev\\data-mapper-live', sessions: 3, spanMs: 4 * HOUR }]);
  const generate = generator(files, {
    env: { HARBOR_NO_ICON_GEN: '1', HARBOR_ICON_GEN_KEY: 'k' },
    fetch: () => { throw new Error('must not be called'); },
  });

  assert.deepEqual(await generate.run(), { generated: 0, skipped: 'disabled' });
});

test('the automatic scheduler runs once after startup and again daily', async () => {
  const scheduled = {};
  let passes = 0;
  const handle = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };

  const result = scheduleIconGen({
    env: {},
    run: async () => { passes += 1; return { generated: 0 }; },
    setTimeout(callback, delay) { scheduled.first = { callback, delay }; return handle; },
    setInterval(callback, every) { scheduled.repeat = { callback, every }; return handle; },
  });

  assert.equal(passes, 0, 'scheduling alone must not run a pass synchronously');
  assert.equal(scheduled.first.delay, 90_000);
  assert.equal(scheduled.repeat.every, 24 * 3_600_000);
  await scheduled.first.callback();
  assert.equal(passes, 1, 'the delayed startup pass still runs');
  await scheduled.repeat.callback();
  assert.equal(passes, 2, 'the periodic callback reruns the production pass');
  assert.equal(result.every, 24 * 3_600_000);
  assert.equal(handle.unrefCalls, 2);
});

test('one session resumed under several config homes is still one session', () => {
  const projects = projectsFromIndex({
    files: {
      a: { id: 'same-session', cwd: 'C:\\dev\\thing', start: '2026-08-10T00:00:00Z', last: '2026-08-10T01:00:00Z' },
      b: { id: 'same-session', cwd: 'C:\\dev\\thing', start: '2026-08-10T00:00:00Z', last: '2026-08-10T01:00:00Z' },
    },
  }, { home: HOME, platform: 'win32' });

  assert.deepEqual(projects.map((p) => [p.label, p.sessions]), [['thing', 1]]);
});

test('the prompt describes the house style and never asks for lettering', () => {
  const prompt = promptFor('Loss-Run-Mapper');
  assert.match(prompt, /Loss Run Mapper/u, 'separators become words, not hyphens read aloud');
  assert.match(prompt, /rounded-square/iu);
  assert.match(prompt, /NO text, NO words, NO letters/u);
});

test('an orchestration worktree never becomes an icon candidate', () => {
  const index = { v: 2, files: {
    a: { id: 'a', cwd: 'C:\\dev\\.orch\\batch-7', start: '2026-08-10T00:00:00Z', last: '2026-08-10T02:00:00Z' },
    b: { id: 'b', cwd: 'C:\\dev\\misc-ad-hoc\\.orch\\b1-foundation', start: '2026-08-10T00:00:00Z', last: '2026-08-10T02:00:00Z' },
    c: { id: 'c', cwd: 'C:\\dev\\harbor', start: '2026-08-10T00:00:00Z', last: '2026-08-10T02:00:00Z' },
  } };
  const labels = projectsFromIndex(index, { home: HOME, platform: 'win32' }).map((p) => p.label);
  assert.deepEqual(labels, ['harbor']);
});
