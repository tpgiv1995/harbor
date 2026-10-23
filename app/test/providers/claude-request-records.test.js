'use strict';

// Claude Code 2.1.300 stores a copy of every API request in the transcript
// (`api-request`, `api-request-blob`, `api-request-shape`; docs/claude/providers.md,
// CLI review of 2026-10-15). The readers that classify by type already ignore
// them once parsed; these specs pin what parsing them still cost: decoded
// multi-megabyte strings, tail budgets spent on copies, and Files candidates
// lifted from the system prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isApiRequestRecordLine, isApiRequestRecordBytes } = require('../../src/main/providers/claude-request-records.js');
const {
  createTranscriptProvider, readTranscriptTailRecords, MAX_INITIAL_BYTES,
} = require('../../src/main/providers/transcript.js');
const { createArtifactsProvider } = require('../../src/main/providers/artifacts.js');
const { createPendingAskReader } = require('../../src/main/providers/pending-ask.js');

const line = (obj) => `${JSON.stringify(obj)}\n`;
const TS = '2026-10-19T05:00:00.000Z';
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } };

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the three request record types are recognised from the line start; conversation is not', () => {
  for (const type of ['api-request', 'api-request-blob', 'api-request-shape']) {
    const text = JSON.stringify({ type, sessionId: 's', params: { system: 'x'.repeat(50_000) } });
    assert.equal(isApiRequestRecordLine(text), true, type);
    const bytes = Buffer.from(`{"type":"user"}\n${text}\n`);
    assert.equal(isApiRequestRecordBytes(bytes, bytes.indexOf(10) + 1, bytes.length - 1), true, `${type} bytes`);
    assert.equal(isApiRequestRecordBytes(bytes, 0, bytes.indexOf(10)), false, `user before ${type}`);
  }
  assert.equal(isApiRequestRecordLine(JSON.stringify({ type: 'user', message: { content: 'hi' } })), false);
  assert.equal(isApiRequestRecordLine(JSON.stringify({ type: 'ai-title', aiTitle: 'x' })), false);
  // A message that QUOTES the marker carries it escaped, so it never matches.
  assert.equal(isApiRequestRecordLine(JSON.stringify({ type: 'user', message: { content: '{"type":"api-request"}' } })), false);
  assert.equal(isApiRequestRecordLine(''), false);
  assert.equal(isApiRequestRecordLine(null), false);
});

test('resume tail records do not spend their budget on request copies', async (t) => {
  const file = path.join(tmpDir(t, 'harbor-request-tail-'), 'chat.jsonl');
  const rows = [line({ type: 'user', message: { role: 'user', content: 'first' } })];
  for (let i = 0; i < 10; i += 1) rows.push(line({ type: 'api-request', sessionId: 's', n: i }));
  rows.push(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }));
  fs.writeFileSync(file, rows.join(''));
  const records = await readTranscriptTailRecords(file, { maxRecords: 2 });
  assert.deepEqual(records.map((r) => r.type), ['user', 'assistant']);
});

test('no transcript reader decodes a request copy: open, live tail, prefix images, paging and the ask poll', async (t) => {
  const dir = tmpDir(t, 'harbor-request-readers-');
  const file = path.join(dir, 'big.jsonl');
  const blob = (n) => line({ type: 'api-request-blob', hash: `h${n}`, message: { role: 'user', content: [{ type: 'text', text: 'pasted' }, image] } });
  const shape = line({ type: 'api-request-shape', tools: [{ name: 'AskUserQuestion', input_schema: { properties: { summary: {} } } }] });
  let body = line({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'opening' }, image] } });
  body += blob(0) + shape;
  const pad = line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'padding '.repeat(500) }] } });
  body += pad.repeat(Math.ceil((MAX_INITIAL_BYTES + 50_000) / Buffer.byteLength(pad)));
  body += blob(1) + shape + line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'recent' }] } });
  fs.writeFileSync(file, body);

  const realParse = JSON.parse;
  const decoded = [];
  JSON.parse = function spy(text, ...rest) {
    if (typeof text === 'string' && isApiRequestRecordLine(text)) decoded.push(text.slice(0, 40));
    return realParse.call(this, text, ...rest);
  };
  t.after(() => { JSON.parse = realParse; });

  const contextDir = path.join(dir, 'context');
  fs.mkdirSync(contextDir);
  const provider = createTranscriptProvider({ contextCacheDir: contextDir, getSessionMeta: async () => ({ path: file }) });
  t.after(() => provider.closeAll());
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('requests');
  const initial = updates[0].replace;
  assert.ok(initial.some((b) => b.text === 'recent'), 'the tail still renders');
  assert.ok(initial.some((b) => b.images?.length), 'the real prefix image is still recovered');

  fs.appendFileSync(file, blob(2) + line({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'appended' }] } }));
  assert.equal((await provider.refresh('requests')).ok, true);
  assert.ok(updates.some((u) => (u.append || []).some((b) => b.text === 'appended')), 'the live tail still appends');
  const paged = await provider.page('requests', { beforeBlockId: initial[0].key, count: 20 });
  assert.equal(paged.ok, true);

  fs.appendFileSync(file, line({ type: 'api-request-shape', tools: [{ name: 'AskUserQuestion', description: '"tool_result"' }] }));
  assert.equal(createPendingAskReader().read(file), null);

  JSON.parse = realParse;
  assert.deepEqual(decoded, [], 'a request copy was decoded');
});

test('Files ignores paths named only in a request copy (the system prompt)', async (t) => {
  const tmp = tmpDir(t, 'harbor-request-files-');
  const projectDir = path.join(tmp, 'projects', '-home-you-demo');
  fs.mkdirSync(projectDir, { recursive: true });
  const produced = path.join(tmp, 'report.html');
  const promptOnly = path.join(tmp, 'named-in-system-prompt.html');
  fs.writeFileSync(produced, '<h1>report</h1>');
  fs.writeFileSync(promptOnly, '<h1>not an output</h1>');
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(projectDir, 'sess-req.jsonl'), [
    line({ type: 'user', timestamp: start, cwd: '/home/you/demo', message: { content: 'make a report' } }),
    line({ type: 'api-request', sessionId: 'sess-req', timestamp: start, params: { system: `See ${promptOnly} for the house style.` } }),
    line({ type: 'api-request-blob', sessionId: 'sess-req', body: `"${promptOnly}"` }),
    line({ type: 'assistant', timestamp: start, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: produced, content: 'x' } }] } }),
  ].join(''));
  const provider = createArtifactsProvider({ roots: [path.join(tmp, 'projects')], cacheFile: path.join(tmp, 'cache.json') });
  const { artifacts } = await provider.list();
  assert.deepEqual(artifacts.map((a) => a.path), [produced]);
});
