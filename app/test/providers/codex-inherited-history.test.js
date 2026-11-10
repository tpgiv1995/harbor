'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { readCodexInheritedHistory } = require('../../src/main/providers/codex-inherited-history.js');
const { createTranscriptProvider } = require('../../src/main/providers/transcript.js');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const line = value => JSON.stringify(value) + '\n';
const meta = (id, extra = {}) => ({ type: 'session_meta', payload: { id, cwd: '/fixture', source: 'cli', ...extra } });
const message = (text, type = 'UserMessage') => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type, id: text, content: [{ type: type === 'AgentMessage' ? 'Text' : 'text', text }] } } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-fork-'));
  const day = path.join(dir, 'sessions', '2026', '11', '09'); fs.mkdirSync(day, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ids.map(id => path.join(day, `rollout-2026-11-09T12-00-00-${id}.jsonl`));
  const write = (index, rows) => { fs.writeFileSync(files[index], rows.map(line).join('')); return fs.statSync(files[index]).size; };
  const fork = (index, parent, end, extra = {}) => meta(ids[index], { forked_from_id: ids[parent], history_base: { thread_id: ids[parent], end_byte_offset: end }, ...extra });
  return { dir, files, write, fork };
}
function providerFor(t, f, index) {
  const provider = createTranscriptProvider({ home: f.dir, contextCacheDir: path.join(f.dir, 'context'),
    getSessionMeta: () => ({ provider: 'codex', path: f.files[index] }),
    watchFactory: () => ({ on() {}, close() {} }), readProcessCmdline: async () => '' });
  t.after(() => provider.closeAll());
  const updates = []; provider.emitter.on('update', value => updates.push(value));
  return { provider, updates };
}
test('fork opens inherited messages only through its boundary without inheriting pending work', async t => {
  const f = fixture(t);
  const end = f.write(0, [meta(ids[0]), message('original question'), message('original answer', 'AgentMessage'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'pending', name: 'exec_command', arguments: '{"cmd":"echo fixture"}' } }]);
  fs.appendFileSync(f.files[0], line(message('later parent message')));
  f.write(1, [f.fork(1, 0, end), message('fork question')]);
  const { provider, updates } = providerFor(t, f, 1);
  assert.equal((await provider.open(ids[1])).ok, true);
  const first = updates.find(u => u.replace?.length);
  assert.deepEqual(first.replace.filter(b => ['user', 'assistant'].includes(b.kind)).map(b => b.text), ['original question', 'original answer', 'fork question']);
  assert.equal(first.replace.some(b => b.status === 'run'), false);
  assert.equal(new Set(first.replace.map(b => b.key)).size, first.replace.length);
  fs.appendFileSync(f.files[0], line(message('even later parent')));
  await provider.refresh(ids[1]);
  assert.equal(JSON.stringify(updates).includes('later parent'), false);
  assert.equal(updates.filter(u => u.replace?.length).length, 1);
});
test('chained forks are chronological and bounded by the total byte budget', async t => {
  const f = fixture(t), first = f.write(0, [meta(ids[0]), message('first')]);
  const second = f.write(1, [f.fork(1, 0, first), message('second')]);
  f.write(2, [f.fork(2, 1, second)]);
  const all = await readCodexInheritedHistory(f.files[2]);
  assert.deepEqual(all.records.filter(r => r.type === 'event_msg').map(r => r.payload.item.id), ['first', 'second']);
  const bounded = await readCodexInheritedHistory(f.files[2], { maxBytes: 30 });
  assert.equal(bounded.bytes, 30);
  assert.equal(bounded.records.length, 0, 'partial JSON is not rendered');
  assert.equal((await readCodexInheritedHistory(f.files[2], { maxDepth: 1 })).records.some(r => r.payload?.item?.id === 'first'), false);
});
test('missing or invalid fork boundaries produce an honest unavailable note', async t => {
  const f = fixture(t); f.write(1, [f.fork(1, 0, 99)]);
  assert.equal((await readCodexInheritedHistory(f.files[1])).unavailable, true);
  const { provider, updates } = providerFor(t, f, 1); await provider.open(ids[1]);
  assert.match(updates[0].replace[0].text, /unavailable/);
  f.write(0, [meta(ids[0])]); f.write(1, [f.fork(1, 0, Number.MAX_SAFE_INTEGER)]);
  assert.equal((await readCodexInheritedHistory(f.files[1])).unavailable, true);
  f.write(1, [f.fork(1, 0, -1)]);
  assert.equal((await readCodexInheritedHistory(f.files[1])).unavailable, true);
});
test('cycles stop and child-agent history is never treated as a root fork', async t => {
  const f = fixture(t); f.write(0, [f.fork(0, 1, 0)]); f.write(1, [f.fork(1, 0, 0)]);
  assert.equal((await readCodexInheritedHistory(f.files[1])).unavailable, true);
  const end = f.write(0, [meta(ids[0]), message('parent confidential context')]);
  f.write(1, [f.fork(1, 0, end, { source: { subagent: { thread_spawn: { parent_thread_id: ids[0], depth: 1 } } } })]);
  assert.deepEqual((await readCodexInheritedHistory(f.files[1])).records, []);
});
test('a fork file created after open still seeds inheritance exactly once', async t => {
  const f = fixture(t), end = f.write(0, [meta(ids[0]), message('original')]);
  const { provider, updates } = providerFor(t, f, 1); await provider.open(ids[1]);
  f.write(1, [f.fork(1, 0, end)]); await provider.refresh(ids[1]); await provider.refresh(ids[1]);
  const blocks = updates.flatMap(u => u.replace || u.append || []);
  assert.equal(blocks.filter(b => b.text === 'original').length, 1);
});

test('a missing parent is searched only once for the lifetime of a window', async t => {
  const f=fixture(t);f.write(1,[f.fork(1,0,123)]);let searches=0;
  const missingParents=new Set(),findParent=async()=>{searches++;return null;};
  for(let i=0;i<40;i++)assert.equal((await readCodexInheritedHistory(f.files[1],{missingParents,findParent})).unavailable,true);
  assert.equal(searches,1);
  await readCodexInheritedHistory(f.files[1],{missingParents:new Set(),findParent});assert.equal(searches,2,'reopening a window permits a new attempt');
});
