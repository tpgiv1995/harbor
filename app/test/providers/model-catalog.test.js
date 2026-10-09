'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createModelCatalog,
  extractIdsFromText,
  isLaunchableId,
  labelForId,
  compareVersionsDesc,
  buildVersions,
  buildFamilies,
  resolveClaudeBinary,
} = require('../../src/main/providers/model-catalog.js');

// The exact string population extracted from the real Claude CLI 2.1.219
// binary on 2026-07-24 (the day Opus 5 shipped). The filter must keep only
// launchable dateless first-party ids out of this noise.
const REAL_BINARY_STRINGS = [
  'claude-fable-', 'claude-fable-5', 'claude-fable-5.md', 'claude-fable-5-mythos-5',
  'claude-haiku-', 'claude-haiku-4', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-20251001-v1:0', 'claude-mythos-', 'claude-mythos-5', 'claude-mythos-preview',
  'claude-opus-4', 'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-1-20250805',
  'claude-opus-4-1-20250805-v1:0', 'claude-opus-4-20250514', 'claude-opus-4-20250514-v1:0',
  'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-5-20251101-v1:0',
  'claude-opus-4-6', 'claude-opus-4-6-20251101', 'claude-opus-4-6-fast', 'claude-opus-4-6-v1',
  'claude-opus-4-7', 'claude-opus-4-7-fast', 'claude-opus-4-8', 'claude-opus-5',
  'claude-sonnet-4', 'claude-sonnet-4-0', 'claude-sonnet-4-20250514',
  'claude-sonnet-4-20250514-v1:0', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-6', 'claude-sonnet-4-6-20251114',
  'claude-sonnet-5',
];

// Discovery reads the ids as the CLI's embedded JavaScript writes them: as
// complete quoted string literals (every real id in 2.1.293 and 2.1.295 has
// at least one). The same filter still has to throw out the noise around them.
test('extracts only launchable dateless ids from the real binary string set', () => {
  const text = REAL_BINARY_STRINGS.map((s) => JSON.stringify(s)).join('\0');
  const ids = [...extractIdsFromText(text)].sort();
  assert.deepEqual(ids, [
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-opus-4-0',
    'claude-opus-4-1',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-0',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
  ]);
});

test('launchable filter: rejects dated, fast, bedrock, doc-slug, bare-major, mythos ids', () => {
  assert.equal(isLaunchableId('claude-opus-5'), true);
  assert.equal(isLaunchableId('claude-opus-4-8'), true);
  assert.equal(isLaunchableId('claude-fable-5'), true);
  assert.equal(isLaunchableId('claude-haiku-4-5'), true);
  assert.equal(isLaunchableId('claude-opus-4'), false, 'bare gen-4 major is an alias, not a model');
  assert.equal(isLaunchableId('claude-opus-4-5-20251101'), false, 'dated snapshot');
  assert.equal(isLaunchableId('claude-opus-4-6-fast'), false, 'fast-mode routing id');
  assert.equal(isLaunchableId('claude-opus-4-6-v1'), false, 'bedrock variant');
  assert.equal(isLaunchableId('claude-fable-5.md'), false, 'doc slug');
  assert.equal(isLaunchableId('claude-fable-5-mythos-5'), false, 'doc slug');
  assert.equal(isLaunchableId('claude-mythos-5'), false, 'invitation-only: never a menu row');
  assert.equal(isLaunchableId('claude-mythos-preview'), false);
});

test('labels derive from the id, never a table', () => {
  assert.equal(labelForId('claude-opus-5'), 'Opus 5');
  assert.equal(labelForId('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(labelForId('claude-sonnet-4-6'), 'Sonnet 4.6');
  assert.equal(labelForId('claude-fable-5'), 'Fable 5');
  assert.equal(labelForId('claude-opus-6'), 'Opus 6', 'a future model needs no code change');
});

// CLI 2.1.295 (2026-10-09): the compiled string pool stores each string as a
// 4-byte length word (high bit set), a 4-byte hash, the bytes, and padding to
// 4. "claude-haiku-3-5" is 16 bytes, so it needs no padding, and the next
// entry is 53 bytes long: its length word starts with 0x35, the digit "5".
// A raw substring scan read "claude-haiku-3-55" and offered "Haiku 3.55", a
// model that does not exist. Synthetic bytes in exactly that layout.
function poolEntry(text, hash = [0x11, 0x22, 0x33, 0x00]) {
  const body = Buffer.from(text, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32LE((body.length | 0x80000000) >>> 0);
  const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
  return Buffer.concat([len, Buffer.from(hash), body, pad]);
}

test('a string-pool length word after an id never becomes a model row', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-pool-'));
  try {
    const bin = path.join(dir, 'claude');
    const next = 'x'.repeat(53);
    await fs.writeFile(bin, Buffer.concat([
      poolEntry('haiku-3-5'),
      poolEntry('claude-haiku-3-5'),
      poolEntry(next),
      Buffer.from(' var t=[["haiku-3-5","claude-haiku-3-5"],["opus-5","claude-opus-5"]];'),
    ]));
    assert.equal((await fs.readFile(bin)).includes(Buffer.from('claude-haiku-3-55')), true, 'the raw bytes do read as the phantom id');
    const catalog = createModelCatalog({ seedIds: [] });
    assert.equal((await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: bin } })).ok, true);
    assert.deepEqual(catalog.ids().sort(), ['claude-haiku-3-5', 'claude-opus-5']);
    assert.equal(catalog.versions().some((v) => v.label === 'Haiku 3.55'), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// A cache written by the old raw scan, for the SAME binary, would otherwise
// keep the phantom row after the fix lands: the running Harbor rescans the new
// CLI the moment the update chip installs it, before Harbor itself restarts.
test('a cache written by an older scan is rescanned, not trusted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-old-cache-'));
  try {
    const bin = path.join(dir, 'claude');
    const cacheFile = path.join(dir, 'models.json');
    await fs.writeFile(bin, '"claude-haiku-3-5"');
    const stat = await fs.stat(bin);
    await fs.writeFile(cacheFile, JSON.stringify({ binPath: await fs.realpath(bin), size: stat.size,
      mtimeMs: stat.mtimeMs, ids: ['claude-haiku-3-5', 'claude-haiku-3-55'] }));
    const catalog = createModelCatalog({ seedIds: [], cacheFile });
    const result = await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: bin } });
    assert.equal(result.cacheHit, false);
    assert.deepEqual(catalog.ids(), ['claude-haiku-3-5']);
    const second = await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: bin } });
    assert.equal(second.cacheHit, true, 'the rewritten cache is trusted again');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('version ordering: opus 5 outranks every 4.x; flagship leads the family', () => {
  const ids = ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-4-1'];
  assert.deepEqual(ids.sort(compareVersionsDesc), ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-1']);
  const versions = buildVersions(new Set(['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5']));
  assert.equal(versions[0].id, 'claude-fable-5', 'family order: fable first');
  const opus = versions.filter((v) => v.family === 'opus');
  assert.deepEqual(opus.map((v) => v.id), ['claude-opus-5', 'claude-opus-4-8']);
  const families = buildFamilies(versions);
  assert.deepEqual(families.find((f) => f.family === 'opus'), { alias: 'opus', label: 'Opus 5', family: 'opus' });
});

test('catalog: seed stands alone, discovery merges over it, cache short-circuits rescans', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-catalog-'));
  const fakeBin = path.join(dir, 'claude');
  // A fake binary carrying a FUTURE model id the seed does not know.
  await fs.writeFile(fakeBin, Buffer.concat([
    Buffer.from([0, 1, 2, 3]),
    Buffer.from('xx "claude-opus-6" yy \'claude-opus-5\' zz `claude-opus-4-6-fast` "claude-sonnet-5-20270101" claude-opus-7'),
    Buffer.from([0xff, 0xfe]),
  ]));
  const cacheFile = path.join(dir, 'cache.json');
  const catalog = createModelCatalog({
    seedIds: ['claude-opus-5', 'claude-sonnet-5'],
    cacheFile,
  });

  // Before any refresh: the seed is the whole catalog.
  assert.deepEqual(catalog.ids().sort(), ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(catalog.families().find((f) => f.family === 'opus').label, 'Opus 5');

  const env = { HARBOR_CLAUDE_BIN: fakeBin };
  const first = await catalog.refresh({ env });
  assert.equal(first.ok, true);
  assert.equal(first.cacheHit, false);
  assert.deepEqual(first.added, ['claude-opus-6']);
  assert.deepEqual(catalog.ids().sort(), ['claude-opus-5', 'claude-opus-6', 'claude-sonnet-5']);
  assert.equal(catalog.families().find((f) => f.family === 'opus').label, 'Opus 6', 'flagship follows discovery');

  // Second refresh: same binary -> cache hit, nothing new.
  const second = await catalog.refresh({ env });
  assert.equal(second.ok, true);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.added, []);

  // Binary vanishes: refresh fails HONESTLY and the catalog keeps its list.
  const third = await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: path.join(dir, 'nowhere') } });
  assert.equal(third.ok, false);
  assert.deepEqual(catalog.ids().sort(), ['claude-opus-5', 'claude-opus-6', 'claude-sonnet-5']);

  await fs.rm(dir, { recursive: true, force: true });
});

test('an id split across chunk boundaries still extracts (overlap guard)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-catalog-split-'));
  const fakeBin = path.join(dir, 'claude');
  // Force the id to straddle the 8MB chunk boundary.
  const pad = Buffer.alloc(8 * 1024 * 1024 - 10, 0x20);
  await fs.writeFile(fakeBin, Buffer.concat([pad, Buffer.from(' "claude-opus-5" ')]));
  const catalog = createModelCatalog({ seedIds: [], cacheFile: path.join(dir, 'cache.json') });
  const result = await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: fakeBin } });
  assert.equal(result.ok, true);
  assert.deepEqual(catalog.ids(), ['claude-opus-5']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('capabilities: Opus 5.5 is in the seed and leads the opus family', () => {
  const { MODEL_VERSION_SEED, newSessionOptions } = require('../../src/main/providers/capabilities.js');
  const opusSeed = MODEL_VERSION_SEED.filter((m) => m.family === 'opus');
  assert.equal(opusSeed[0].id, 'claude-opus-5-5');
  assert.equal(opusSeed[0].label, 'Opus 5.5');
  const options = newSessionOptions({ profiles: [] }, { env: {}, homedir: () => '/harbor-test-no-home' });
  const opusRow = options.providers.claude.models.find((m) => m.value === 'opus');
  assert.equal(opusRow.label, 'Opus 5.5', 'the opus alias row is labeled with the flagship');
});

test('capabilities: Sonnet 5.5 survives a failed discovery and leads the sonnet family', async () => {
  const { MODEL_VERSION_SEED, newSessionOptions } = require('../../src/main/providers/capabilities.js');
  const sonnetSeed = MODEL_VERSION_SEED.filter((m) => m.family === 'sonnet');
  assert.equal(sonnetSeed[0].id, 'claude-sonnet-5-5');
  assert.equal(sonnetSeed[0].label, 'Sonnet 5.5');
  const catalog = createModelCatalog({ seedIds: MODEL_VERSION_SEED.map((m) => m.id) });
  const missing = path.join(os.tmpdir(), 'harbor-missing-sonnet-binary', 'claude');
  assert.equal((await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: missing } })).ok, false);
  assert.deepEqual(catalog.families().find((m) => m.family === 'sonnet'), {
    alias: 'sonnet', label: 'Sonnet 5.5', family: 'sonnet',
  });
  const options = newSessionOptions({ profiles: [] }, { env: {}, homedir: () => '/harbor-test-no-home' });
  assert.equal(options.providers.claude.models.find((m) => m.value === 'sonnet').label, 'Sonnet 5.5');
  assert.equal(labelForId('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.ok(extractIdsFromText('"claude-sonnet-5-5"').has('claude-sonnet-5-5'));
});

// Haiku 5.5 shipped with CLI 2.1.293 (2026-10-07). The seed carries it so a
// failed or disabled scan, or a CLI older than 2.1.293, still offers it and
// labels the haiku family with it, the same posture as Sonnet 5.5.
test('capabilities: Haiku 5.5 survives a failed discovery and leads the haiku family', async () => {
  const { MODEL_VERSION_SEED, newSessionOptions } = require('../../src/main/providers/capabilities.js');
  const haikuSeed = MODEL_VERSION_SEED.filter((m) => m.family === 'haiku');
  assert.equal(haikuSeed[0].id, 'claude-haiku-5-5');
  assert.equal(haikuSeed[0].label, 'Haiku 5.5');
  assert.ok(haikuSeed.some((m) => m.id === 'claude-haiku-4-5'), 'Haiku 4.5 stays offered');
  const catalog = createModelCatalog({ seedIds: MODEL_VERSION_SEED.map((m) => m.id) });
  const missing = path.join(os.tmpdir(), 'harbor-missing-haiku-binary', 'claude');
  assert.equal((await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: missing } })).ok, false);
  assert.deepEqual(catalog.families().find((m) => m.family === 'haiku'), {
    alias: 'haiku', label: 'Haiku 5.5', family: 'haiku',
  });
  const options = newSessionOptions({ profiles: [] }, { env: {}, homedir: () => '/harbor-test-no-home' });
  assert.equal(options.providers.claude.models.find((m) => m.value === 'haiku').label, 'Haiku 5.5');
  assert.equal(labelForId('claude-haiku-5-5'), 'Haiku 5.5');
  assert.ok(extractIdsFromText('"claude-haiku-5-5"').has('claude-haiku-5-5'));
});

// Fable 5.1 shipped 2026-09-01. The installed CLI predated it, so discovery (which
// scans the binary) could not surface it; the seed floor carries it until the CLI
// catches up, the same reason Opus 5 was seeded the day it shipped.
test('capabilities: Fable 5.1 is in the seed and leads the fable family', () => {
  const { MODEL_VERSION_SEED } = require('../../src/main/providers/capabilities.js');
  const fableSeed = MODEL_VERSION_SEED.filter((m) => m.family === 'fable');
  assert.equal(fableSeed[0].id, 'claude-fable-5-1');
  assert.equal(fableSeed[0].label, 'Fable 5.1');
  const families = buildFamilies(buildVersions(new Set(MODEL_VERSION_SEED.map((m) => m.id))));
  assert.deepEqual(
    families.find((f) => f.family === 'fable'),
    { alias: 'fable', label: 'Fable 5.1', family: 'fable' },
    'the fable alias row is labeled with the flagship',
  );
});

// The resolver's third Windows bug, one hop past the two its own comment
// records: PATH resolves to claude.cmd, an npm SHIM of a few hundred bytes,
// and a shim scans to zero ids, so the catalogue silently lived on the seed
// forever ("model catalog: scan found no model ids", every boot on the
// Legion). Three sides: a shim with the npm package beside it resolves into
// the package's real binary; a shim alone resolves to itself, because an
// honest zero-id scan beats returning null; and the HARBOR_CLAUDE_BIN pin is
// never unwrapped, because a pin means scan THIS file.
test('an npm shim resolves through to the packaged binary, and a pin never does', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-shim-'));
  try {
    const binDir = path.join(root, 'npm');
    await fs.mkdir(binDir, { recursive: true });
    const shimName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const packagedName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const shim = path.join(binDir, shimName);
    await fs.writeFile(shim, '@echo off\n');
    const env = { PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    const alone = await resolveClaudeBinary(env);
    assert.strictEqual(alone.path, await fs.realpath(shim));

    const pkgBin = path.join(binDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    await fs.mkdir(pkgBin, { recursive: true });
    const packaged = path.join(pkgBin, packagedName);
    await fs.writeFile(packaged, Buffer.alloc(2 * 1024 * 1024));
    const unwrapped = await resolveClaudeBinary(env);
    assert.strictEqual(unwrapped.path, await fs.realpath(packaged));

    const pinned = await resolveClaudeBinary({ ...env, HARBOR_CLAUDE_BIN: shim });
    assert.strictEqual(pinned.path, await fs.realpath(shim));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
