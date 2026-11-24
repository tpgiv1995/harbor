'use strict';

// The screenshot corpus plants a Gemini (Antigravity) conversation the way the
// other providers' are planted: in the real store layout, inside the fixture
// HOME, where the real scanner finds it. Words and folders are invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('./support/real-tmpdir.js');
const { SESSIONS, ARTIFACTS, buildConfig, writeGeminiSession } = require('../scripts/lib/demo-corpus.cjs');
const { createProviderHistory } = require('../src/main/providers/provider-history.js');
const { TranscriptParser } = require('../src/main/providers/transcript.js');

test('the stage opens claude, codex, cursor, gemini first, and still six windows', () => {
  assert.deepEqual(SESSIONS.slice(0, 4).map((session) => session.provider), ['claude', 'codex', 'cursor', 'gemini']);
  assert.equal(SESSIONS.length, 6, 'the grid shot is a 3x2 of six windows');
  assert.equal(SESSIONS.filter((session) => session.provider === 'gemini').length, 1);
});

test('no artifact is attributed to a session that is not Claude (the Files scan reads Claude transcripts only)', () => {
  const claude = new Set(SESSIONS.filter((session) => session.provider === 'claude').map((session) => session.key));
  for (const artifact of ARTIFACTS) assert.ok(claude.has(artifact.session), `${artifact.name} comes from ${artifact.session}`);
});

test('the fixture config enables Gemini beside the other three providers', () => {
  const config = buildConfig('root', { projectsDir: 'p', home: 'h', cacheDir: 'c', userData: 'u' });
  assert.deepEqual(Object.keys(config.providers).sort(), ['claude', 'codex', 'cursor', 'gemini']);
  assert.equal(config.providers.gemini.enabled, true);
});

test('a planted Gemini conversation is found by the real scanner as a typed, titled, located session and parses to rows', async (t) => {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-gemini-corpus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = SESSIONS.find((entry) => entry.provider === 'gemini');
  const cwd = path.join(dir, 'demo', 'notes-api');
  fs.mkdirSync(cwd, { recursive: true });
  const id = '00000003-1111-4222-8333-444444444443';
  const file = writeGeminiSession(session, { home: dir, cwd, id, startMs: Date.now() - 4 * 3600_000 });
  assert.equal(file, path.join(dir, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'));
  const history = createProviderHistory({ homedir: dir, metadataFile: path.join(dir, 'm.json'), debounceMs: 60_000, projectLabelForCwd: (value) => path.basename(value) });
  t.after(() => history.close());
  const [row] = await history.listSessions();
  assert.equal(row.provider, 'gemini');
  assert.equal(row.title, session.blocks[0][1]);
  assert.equal(row.headless, false, 'it has what only a typed conversation has');
  assert.equal(row.cwd, cwd);
  assert.equal(row.project, 'notes-api');
  const parser = new TranscriptParser('gemini');
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) parser.applyLine(JSON.parse(line));
  assert.deepEqual(parser.blocks.map((block) => block.verb || block.kind), ['user', 'assistant', 'Read', 'assistant', 'Edited', 'Ran', 'assistant']);
  assert.ok(parser.blocks.filter((block) => block.kind === 'action').every((block) => block.status === 'ok'));
  assert.equal(parser.header.model.name, 'Gemini 4 Neon');
  // Every word is invented: nothing in the store names this machine's real profile folder.
  const all = fs.readdirSync(path.join(dir, '.gemini', 'antigravity-cli'), { recursive: true }).join('\n').toLowerCase();
  const realUser = path.basename(require('node:os').homedir()).toLowerCase();
  assert.ok(!all.includes(realUser), `the demo store names the real profile folder ${realUser}`);
});
