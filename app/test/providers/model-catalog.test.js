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

test('extracts only launchable dateless ids from the real binary string set', () => {
  const text = REAL_BINARY_STRINGS.join('\0');
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
    Buffer.from('xx claude-opus-6 yy claude-opus-5 zz claude-opus-4-6-fast claude-sonnet-5-20270101'),
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
  await fs.writeFile(fakeBin, Buffer.concat([pad, Buffer.from(' claude-opus-5 ')]));
  const catalog = createModelCatalog({ seedIds: [], cacheFile: path.join(dir, 'cache.json') });
  const result = await catalog.refresh({ env: { HARBOR_CLAUDE_BIN: fakeBin } });
  assert.equal(result.ok, true);
  assert.deepEqual(catalog.ids(), ['claude-opus-5']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('capabilities: Opus 5 is in the seed and leads the opus family', () => {
  const { MODEL_VERSION_SEED, newSessionOptions } = require('../../src/main/providers/capabilities.js');
  const opusSeed = MODEL_VERSION_SEED.filter((m) => m.family === 'opus');
  assert.equal(opusSeed[0].id, 'claude-opus-5');
  assert.equal(opusSeed[0].label, 'Opus 5');
  const options = newSessionOptions();
  const opusRow = options.providers.claude.models.find((m) => m.value === 'opus');
  assert.equal(opusRow.label, 'Opus 5', 'the opus alias row is labeled with the flagship');
});
