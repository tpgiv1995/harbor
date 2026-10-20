'use strict';

// Codex outputs in the Files view. Fixtures are SYNTHETIC rollouts
// in the record shapes codex 0.160 writes (FileChange items, apply_patch
// custom_tool_calls, image-generation Extension items, generated_images/), never
// copied transcript content.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  createArtifactsProvider,
  codexRecordOutputs,
  codexHomesFromProfiles,
} = require('../../src/main/providers/artifacts.js');

const THREAD = '01a14044-00e0-7391-b24b-ca59c663338f';
const ARCHIVED = '019f4d0b-373e-7102-969b-2b45933cbdfb';
const line = (obj) => `${JSON.stringify(obj)}\n`;

function rolloutLines({ id, cwd, start, outDir }) {
  return [
    line({ timestamp: start, type: 'session_meta', payload: { session_id: id, id, timestamp: start, cwd, originator: 'codex_cli_rs', base_instructions: { text: 'x'.repeat(20000) } } }),
    line({ timestamp: start, type: 'turn_context', payload: { turn_id: 't1', cwd: outDir, model: 'gpt-6-sol' } }),
    // A FileChange add: the primary signal.
    line({ timestamp: start, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f1', status: 'completed', changes: {
      [path.join(outDir, 'report.html')]: { type: 'add', content: '<h1>r</h1>' },
      [path.join(outDir, 'old-name.png')]: { type: 'update', unified_diff: '', move_path: path.join(outDir, 'chart.png') },
      [path.join(outDir, 'gone.html')]: { type: 'delete', content: '' },
    } } } }),
    // apply_patch with a path RELATIVE to the turn cwd.
    line({ timestamp: start, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', status: 'completed',
      input: '*** Begin Patch\n*** Add File: deck.pdf\n+%PDF\n*** Update File: notes.txt\n@@\n-a\n+b\n*** End Patch\n' } }),
    // A command that merely mentions a viewable file: NOT an output.
    line({ timestamp: start, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'x1', status: 'completed',
      command: `open ${path.join(outDir, 'mentioned.html')}`, aggregated_output: path.join(outDir, 'mentioned.html') } } }),
  ].join('');
}

function makeCodexHome(t) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-artifacts-codex-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, '.codex');
  const outDir = path.join(tmp, 'work', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const name of ['report.html', 'chart.png', 'deck.pdf', 'mentioned.html']) fs.writeFileSync(path.join(outDir, name), 'x');
  const day = path.join(home, 'sessions', '2026', '10', '15');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-10-15T10-52-41-${THREAD}.jsonl`),
    rolloutLines({ id: THREAD, cwd: path.join(tmp, 'work'), start, outDir }));
  // The image-generation store: owned by its thread, found without a mention.
  const images = path.join(home, 'generated_images', THREAD);
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, 'exec-1.png'), 'png');
  fs.writeFileSync(path.join(images, 'notes.txt'), 'not viewable');
  return { tmp, home, outDir, start };
}

test('codexRecordOutputs reads only what codex recorded as written', () => {
  const cwd = path.resolve('/w');
  const fileChange = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: {
    [path.resolve('/w/a.html')]: { type: 'add' },
    [path.resolve('/w/b.png')]: { type: 'update', move_path: path.resolve('/w/c.png') },
    [path.resolve('/w/d.html')]: { type: 'delete' },
    [path.resolve('/w/e.txt')]: { type: 'add' },
    [path.resolve('/w/node_modules/x.html')]: { type: 'add' },
  } } } };
  assert.deepEqual(codexRecordOutputs(fileChange, cwd), [path.resolve('/w/a.html'), path.resolve('/w/c.png')]);
  const patch = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch',
    input: '*** Begin Patch\n*** Add File: sub/r.html\n*** Update File: /abs/s.svg\n*** Move to: moved.pdf\n*** Delete File: z.png\n*** End Patch' } };
  assert.deepEqual(codexRecordOutputs(patch, cwd), [path.resolve('/w/sub/r.html'), path.resolve('/abs/s.svg'), path.resolve('/w/moved.pdf')]);
  assert.deepEqual(codexRecordOutputs(patch, null), [path.resolve('/abs/s.svg')], 'a relative path with no known cwd is dropped, never guessed');
  const image = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', savedPath: path.resolve('/h/.codex/generated_images/t/i.png') } } };
  assert.deepEqual(codexRecordOutputs(image, cwd), [path.resolve('/h/.codex/generated_images/t/i.png')]);
  const command = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'open /w/q.html', aggregated_output: '/w/q.html' } } };
  assert.deepEqual(codexRecordOutputs(command, cwd), [], 'command executions are too fuzzy to mine');
});

test('codex rollouts and generated_images surface as artifacts owned by their thread', async (t) => {
  const { tmp, home, outDir } = makeCodexHome(t);
  const provider = createArtifactsProvider({
    roots: [path.join(tmp, 'no-claude')],
    codexHomes: [home],
    cacheFile: path.join(tmp, 'cache.json'),
  });
  const { artifacts } = await provider.list();
  const byName = new Map(artifacts.map((a) => [a.name, a]));
  assert.deepEqual([...byName.keys()].sort(), ['chart.png', 'deck.pdf', 'exec-1.png', 'report.html']);
  for (const artifact of artifacts) {
    assert.equal(artifact.sessionId, THREAD);
    assert.equal(artifact.provider, 'codex');
    assert.equal(artifact.cwd, path.join(tmp, 'work'), 'grouped under the session cwd, images included');
  }
  assert.equal(byName.get('deck.pdf').path, path.join(outDir, 'deck.pdf'), 'relative patch path resolved against the turn cwd');
  assert.equal(provider.isServable(path.join(outDir, 'report.html')), true);
  // mentioned.html (named only by a command) is absent from the names above;
  // isServable still allows it as a SIBLING asset of report.html, by design.
});

test('a file older than the codex session start is not its output', async (t) => {
  const { tmp, home, outDir } = makeCodexHome(t);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(outDir, 'chart.png'), old, old);
  const provider = createArtifactsProvider({ roots: [path.join(tmp, 'none')], codexHomes: [home], cacheFile: path.join(tmp, 'c.json') });
  const { artifacts } = await provider.list();
  assert.equal(artifacts.some((a) => a.name === 'chart.png'), false);
});

test('compressed and archived rollouts (.jsonl.zst) are read too', { skip: typeof zlib.zstdCompressSync !== 'function' && 'runtime has no zstd' }, async (t) => {
  const { tmp, home, outDir, start } = makeCodexHome(t);
  fs.rmSync(path.join(home, 'sessions'), { recursive: true });
  fs.rmSync(path.join(home, 'generated_images'), { recursive: true });
  const archived = path.join(home, 'archived_sessions');
  fs.mkdirSync(archived, { recursive: true });
  fs.writeFileSync(
    path.join(archived, `rollout-2026-07-10T12-20-08-${ARCHIVED}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from(rolloutLines({ id: ARCHIVED, cwd: path.join(tmp, 'work'), start, outDir }))),
  );
  const provider = createArtifactsProvider({ roots: [path.join(tmp, 'none')], codexHomes: [home], cacheFile: path.join(tmp, 'c.json') });
  const { artifacts } = await provider.list();
  assert.deepEqual(artifacts.map((a) => a.name).sort(), ['chart.png', 'deck.pdf', 'report.html']);
  assert.ok(artifacts.every((a) => a.sessionId === ARCHIVED));
});

test('an isolated provider never reads a codex home it was not handed', async (t) => {
  const { tmp, home } = makeCodexHome(t);
  // Explicit Claude roots with no codexHomes: no codex default.
  const explicit = createArtifactsProvider({ roots: [path.join(tmp, 'none')], cacheFile: path.join(tmp, 'a.json') });
  assert.deepEqual((await explicit.list()).artifacts, []);
  // The harness env relocation outranks a composed codexHomes, like the roots.
  const prior = process.env.HARBOR_ARTIFACTS_ROOTS;
  process.env.HARBOR_ARTIFACTS_ROOTS = path.join(tmp, 'none');
  t.after(() => { if (prior === undefined) delete process.env.HARBOR_ARTIFACTS_ROOTS; else process.env.HARBOR_ARTIFACTS_ROOTS = prior; });
  const isolated = createArtifactsProvider({ codexHomes: [home], cacheFile: path.join(tmp, 'b.json') });
  assert.deepEqual((await isolated.list()).artifacts, []);
});

test('codex homes follow the configured codex profiles, else ~/.codex', () => {
  const home = path.resolve('/u');
  assert.deepEqual(codexHomesFromProfiles([], home, { env: {} }), [path.join(home, '.codex')]);
  assert.deepEqual(codexHomesFromProfiles([
    { id: 'personal', provider: 'claude', configHome: path.join(home, '.claude') },
    { id: 'codex-work', provider: 'codex', configHome: path.join(home, '.codex-work') },
    { id: 'codex-work-2', provider: 'codex', configHome: path.join(home, '.codex-work') },
  ], home, { env: {} }), [path.join(home, '.codex-work')]);
});

// The walk stays cheap: it runs every 60 s while the Files view is open.

const OLD_THREAD = '01a14044-00e0-7391-b24b-0000000000a1';
const LATE_THREAD = '01a14044-00e0-7391-b24b-0000000000b2';
function writeRollout(home, day, id, cwd, start, file) {
  const dir = path.join(home, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(cwd, file);
  fs.writeFileSync(target, 'x');
  fs.writeFileSync(path.join(dir, `rollout-${day.join('-')}T10-00-00-${id}.jsonl`), [
    line({ timestamp: start, type: 'session_meta', payload: { id, timestamp: start, cwd } }),
    line({ timestamp: start, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f', changes: { [target]: { type: 'add', content: '' } } } } }),
  ].join(''));
  return dir;
}

test('old date folders are skipped by name between full sweeps, a resumed rollout in one stays found, listings are cached', async (t) => {
  const { tmp, home, outDir, start } = makeCodexHome(t);
  // A session started in January and resumed today: codex appends to its
  // January rollout, so its folder name is old and its file is not.
  const oldDay = writeRollout(home, ['2026', '01', '05'], OLD_THREAD, outDir, start, 'resumed.html');
  const recentDay = path.join(home, 'sessions', '2026', '10', '15');
  let wall = Date.parse('2026-10-16T12:00:00Z');
  const provider = createArtifactsProvider({
    roots: [path.join(tmp, 'none')], codexHomes: [home], cacheFile: path.join(tmp, 'c.json'),
    now: () => wall, fullSweepMs: 10 * 60 * 1000,
  });
  const reads = [];
  const readdir = fs.promises.readdir;
  fs.promises.readdir = async (dir, ...rest) => { reads.push(String(dir)); return readdir.call(fs.promises, dir, ...rest); };
  t.after(() => { fs.promises.readdir = readdir; });
  const names = async () => (await provider.list()).artifacts.map((a) => a.name).sort();

  await provider._collect(); // the first pass is a full sweep
  assert.ok(reads.includes(oldDay));
  assert.ok((await names()).includes('resumed.html'));

  // Another old-named folder appears; between sweeps it is not walked.
  const lateDay = writeRollout(home, ['2026', '02', '07'], LATE_THREAD, outDir, start, 'late.html');
  reads.length = 0;
  wall += 60_000;
  await provider._collect();
  assert.equal(reads.includes(oldDay) || reads.includes(lateDay), false, 'old folders are skipped by name');
  assert.equal(reads.includes(recentDay), false, 'an unchanged folder is answered from its cached listing');
  const between = await names();
  assert.ok(between.includes('resumed.html'), 'a rollout already in the window stays checked whatever its folder');
  assert.ok(between.includes('report.html'));
  assert.equal(between.includes('late.html'), false);

  wall += 10 * 60 * 1000;
  await provider._collect(); // the next full sweep
  assert.ok((await names()).includes('late.html'));
});

test('the codex homes option may be a function, asked on every collection', async (t) => {
  const { tmp, home } = makeCodexHome(t);
  let homes = [];
  const provider = createArtifactsProvider({ roots: [path.join(tmp, 'none')], codexHomes: () => homes, cacheFile: path.join(tmp, 'c.json') });
  assert.deepEqual((await provider.list()).artifacts, [], 'no codex profile yet');
  homes = [home]; // the wizard saved a codex profile
  await provider._collect();
  assert.ok((await provider.list()).artifacts.some((a) => a.name === 'report.html'));
});

test('codex homes honour an inherited CODEX_HOME when no profile names one', () => {
  const home = path.resolve('/u');
  const env = { CODEX_HOME: path.resolve('/srv/codex') };
  assert.deepEqual(codexHomesFromProfiles([], home, { env }), [path.resolve('/srv/codex')]);
  assert.deepEqual(codexHomesFromProfiles([], home, { env: {} }), [path.join(home, '.codex')]);
  assert.deepEqual(codexHomesFromProfiles([{ id: 'w', provider: 'codex', configHome: path.join(home, '.codex-work') }], home, { env }),
    [path.join(home, '.codex-work')], 'a configured profile outranks it, as in codexHomes()');
});
