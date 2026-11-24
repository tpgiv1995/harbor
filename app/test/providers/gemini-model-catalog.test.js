'use strict';

// `agy models` -> families and per-family efforts (2026-11-23). The rows are agy 1.5.14's real output (AGY-FACTS
// section 4, trimmed); only ids that begin `gemini-` are offered, the effort suffix is a family's level, and a refresh
// follows the Cursor/Codex catalogs' rules: windowless, 30 s, a failure keeps the last good cache, off under E2E.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseGeminiModels, geminiFamilies, geminiModelOptions, createGeminiModelCatalog, splitGeminiModel,
  GEMINI_EFFORT_FLOOR,
} = require('../../src/main/providers/gemini-model-catalog.js');

const AGY_MODELS = [
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('only gemini- rows are offered: the Claude and GPT-OSS rows agy lists are not this provider\'s models', () => {
  const rows = parseGeminiModels(`Fetching available models...\n${AGY_MODELS}\n`);
  assert.equal(rows.some((r) => !r.id.startsWith('gemini-')), false);
  assert.equal(rows.length, 11);
  assert.deepEqual(parseGeminiModels('no tabs here\n\n  \n'), []);
  assert.deepEqual(parseGeminiModels('gemini-x\n'), [], 'a row with no label is not a row');
});

test('a family is the id without its effort suffix, with its own levels in reading order', () => {
  const families = geminiFamilies(parseGeminiModels(AGY_MODELS));
  const byId = Object.fromEntries(families.map((f) => [f.value, f]));
  assert.deepEqual(byId['gemini-4-neon'].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(byId['gemini-4-neon'].label, 'Gemini 4 Neon');
  assert.deepEqual(byId['gemini-4-hydrogen'].efforts, ['low', 'medium', 'high']);
  assert.deepEqual(byId['gemini-3.8-flash'].efforts, ['low', 'high']);
  // The orchestrators carry no effort: each is its own family and keeps its whole label (they would collide otherwise).
  assert.deepEqual(byId['gemini-pro-orchestrator-neon'].efforts, []);
  assert.equal(byId['gemini-pro-orchestrator-neon'].label, 'Orchestrator (Neon)');
  assert.equal(byId['gemini-pro-orchestrator'].label, 'Orchestrator (Carbon)');
});

test('a slug is split only when it ends in an effort', () => {
  assert.deepEqual(splitGeminiModel('gemini-4-hydrogen-low'), { family: 'gemini-4-hydrogen', effort: 'low' });
  assert.equal(splitGeminiModel('gemini-4-hydrogen'), null);
  assert.equal(splitGeminiModel('gemini-pro-orchestrator'), null);
  assert.equal(splitGeminiModel(''), null);
});

test('options: Default first, families after it, each model with its own levels; no cache offers only Default and agy\'s default family levels', (t) => {
  const dir = tmp(t);
  const none = geminiModelOptions(path.join(dir, 'gemini-models.json'));
  assert.deepEqual(none.models, [{ value: 'default', label: 'Gemini default' }]);
  assert.deepEqual(none.efforts, GEMINI_EFFORT_FLOOR);
  assert.equal(none.defaultEffort, 'high');
  const file = path.join(dir, 'gemini-models.json');
  fs.writeFileSync(file, JSON.stringify({ rows: parseGeminiModels(AGY_MODELS) }));
  const options = geminiModelOptions(file);
  assert.equal(options.models[0].value, 'default');
  assert.deepEqual(options.models.slice(1, 3).map((m) => m.value), ['gemini-4-neon', 'gemini-4-hydrogen']);
  assert.deepEqual(options.effortsByModel['gemini-4-hydrogen'], ['low', 'medium', 'high']);
  assert.deepEqual(options.effortsByModel.default, ['low', 'medium', 'high', 'xhigh'], 'Default is agy\'s default family, Neon');
  assert.deepEqual(geminiModelOptions(path.join(dir, 'missing.json')).models, [{ value: 'default', label: 'Gemini default' }]);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(geminiModelOptions(file).models, [{ value: 'default', label: 'Gemini default' }], 'a corrupt cache is an absent one');
});

function installed(t) {
  const root = tmp(t);
  const agy = path.join(root, 'agy.exe');
  fs.writeFileSync(agy, '');
  return { root, agy, cacheFile: path.join(root, 'cache', 'gemini-models.json') };
}

test('refresh runs agy models windowless under a 30 s deadline, with no self-update, and writes the cache atomically', async (t) => {
  const { root, agy, cacheFile } = installed(t);
  const calls = [];
  const catalog = createGeminiModelCatalog({
    cacheFile, bin: agy, home: root, env: { PATH: '' }, platform: 'win32',
    execFile: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: AGY_MODELS }; },
  });
  assert.deepEqual(await catalog.refresh(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, agy);
  assert.deepEqual(calls[0].args, ['models']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 30000);
  assert.equal(calls[0].options.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(fs.existsSync(`${cacheFile}.tmp`), false, 'the temp file was renamed into place');
  assert.equal(catalog.models().models.length > 1, true);
});

test('a failed or empty refresh keeps the last good cache; E2E and the discovery switch never spawn; a missing CLI says so', async (t) => {
  const { root, agy, cacheFile } = installed(t);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ rows: [{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' }] }));
  const before = fs.readFileSync(cacheFile, 'utf8');
  const make = (execFile, env = { PATH: '' }, bin = agy) => createGeminiModelCatalog({ cacheFile, bin, home: root, env, platform: 'win32', execFile });
  const failed = await make(async () => { throw new Error('timed out'); }).refresh();
  assert.equal(failed.ok, false);
  assert.equal((await make(async () => ({ stdout: 'only claude-opus-5-5-low\tClaude\n' })).refresh()).ok, false);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), before, 'a failure keeps the last good file');
  let spawned = 0;
  const never = async () => { spawned += 1; return { stdout: AGY_MODELS }; };
  assert.deepEqual(await make(never, { HARBOR_E2E: '1' }).refresh(), { ok: false, reason: 'disabled' });
  assert.deepEqual(await make(never, { HARBOR_NO_MODEL_DISCOVERY: '1' }).refresh(), { ok: false, reason: 'disabled' });
  assert.equal(spawned, 0);
  const missing = await make(never, { PATH: '' }, path.join(root, 'nope', 'agy.exe')).refresh();
  assert.deepEqual(missing, { ok: false, reason: 'Gemini CLI is not installed' });
  assert.equal(spawned, 0);
});

test('two refreshes at once share one agy run', async (t) => {
  const { root, agy, cacheFile } = installed(t);
  let runs = 0;
  const catalog = createGeminiModelCatalog({
    cacheFile, bin: agy, home: root, env: { PATH: '' }, platform: 'win32',
    execFile: async () => { runs += 1; await new Promise((r) => setTimeout(r, 20)); return { stdout: AGY_MODELS }; },
  });
  await Promise.all([catalog.refresh(), catalog.refresh()]);
  assert.equal(runs, 1);
});
