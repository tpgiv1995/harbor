'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { scanRows } = require('../../src/main/providers/delegations-worker.js');
const { buildDelegationGroups, ageDelegationGroups, RECENT_DONE_MS } = require('../../src/main/providers/delegations.js');
const now = Date.UTC(2026, 8, 26);
const old = now - 60 * 3600000;
const childId = '10000000-0000-4000-8000-000000000001';
function parent() {
  return { id: 'sample-parent', ownerEvidence: { lastWriteMs: now - 3600000 }, background: { tasks: [
    { id: 'review', kind: 'command', command: `codex exec resume ${childId} "Review sample"`, status: 'running', startedMs: old, lastSignalMs: old, blocking: true },
  ] } };
}
test('linked rollout families are scanned beyond discovery age and cached without reopening', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-linked-age-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, records, ms) => {
    const file = path.join(dir, name + '.jsonl'); fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n'); fs.utimesSync(file, new Date(ms), new Date(ms)); return file;
  };
  const p = parent(); const file = write('parent', [
    { type: 'assistant', timestamp: new Date(old).toISOString(), message: { content: [{ type: 'tool_use', id: 'dispatch', name: 'Bash', input: { command: p.background.tasks[0].command } }] } },
    { type: 'user', timestamp: new Date(old + 1).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'dispatch', content: 'Command running in background with ID: review.' }] } },
  ], now - 3600000);
  const rows = [{ id: p.id, path: file, lastActive: new Date(now - 3600000).toISOString() }];
  const ids = [childId, 'subagent', 'reviewer', 'persisted-child', 'unrelated'];
  for (const [i, id] of ids.entries()) rows.unshift({ id, provider: 'codex', path: write(id, [
    { type: 'event_msg', timestamp: new Date(old + 1000).toISOString(), payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: new Date(old + 10000).toISOString(), payload: { type: 'task_complete' } },
  ], old + 10000), lastWriteMs: old + 10000,
  lineage: { kind: i === 1 ? 'subagent' : i === 2 ? 'guardian' : 'exec', parentThreadId: i === 1 ? childId : i === 2 ? 'subagent' : null },
  delegatedBy: i === 3 ? p.id : null });
  const opens = []; const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => { opens.push(args[0]); return open(...args); });
  const options = { homes: [], contextCacheDir: dir };
  const result = await scanRows(rows, [], now, options);
  const group = result.built.groups[0];
  assert.equal(result.providers.find(r => r.id === childId).signal.outcome, 'done');
  assert.equal(group.agents[0].state, 'done'); assert.equal(group.active, false); assert.equal(group.visible, false);
  for (const id of ids.slice(0, 4)) assert.equal(result.providers.find(r => r.id === id).signal.outcome, 'done', id);
  assert.deepEqual(result.providers.find(r => r.id === 'unrelated').signal, {});
  const count = opens.length; await scanRows(rows, [], now, options);
  assert.equal(opens.length, count, 'unchanged linked evidence is not reopened');
  const child = rows.find(r => r.id === childId);
  fs.appendFileSync(child.path, JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'task_started' } }) + '\n');
  const resumed = await scanRows(rows, [], now, options);
  assert.equal(resumed.built.groups[0].agents[0].state, 'running');
  assert.equal(opens.length, count + 1, 'only the changed linked rollout is reopened');
});
test('dead-parent unknown children end after the done window while live parents stay quiet', () => {
  const p = parent(); const child = { id: childId, provider: 'codex', lastWriteMs: old, signal: {} };
  let group = buildDelegationGroups([p], [child], now).groups[0];
  assert.equal(group.agents[0].state, 'ended'); assert.equal(group.active, false); assert.equal(group.visible, false);
  assert.equal(group.agents[0].rounds[0].outcome, 'ended');
  p.isLive = true;
  group = buildDelegationGroups([p], [child], now).groups[0];
  assert.equal(group.agents[0].state, 'quiet'); assert.equal(group.active, true);
  delete child.lastWriteMs; p.isLive = false;
  group = buildDelegationGroups([p], [child], now).groups[0];
  assert.equal(group.agents[0].state, 'ended'); assert.equal(group.active, false);
});
test('cached independent children expire at the shared bound and can regain live ownership', () => {
  const p = parent(); const child = { id: childId, provider: 'codex', lastWriteMs: now, signal: { working: true, lastSignalMs: now } };
  const groups = buildDelegationGroups([p], [child], now).groups;
  assert.equal(ageDelegationGroups(groups, now + RECENT_DONE_MS - 1, [])[0].active, true);
  const expired = ageDelegationGroups(groups, now + RECENT_DONE_MS + 1, []);
  assert.equal(expired[0].agents[0].state, 'ended'); assert.equal(expired[0].active, false); assert.equal(expired[0].visible, false);
  const owned = ageDelegationGroups(expired, now + RECENT_DONE_MS + 1, [p.id]);
  assert.equal(owned[0].agents[0].state, 'quiet'); assert.equal(owned[0].active, true);
});
test('descendant evidence keeps an independent family fresh and expires each silent subtree', () => {
  const p = parent();
  const providers = [
    { id: childId, provider: 'codex', lastWriteMs: old, signal: { working: true } },
    { id: 'child', provider: 'codex', lastWriteMs: old, lineage: { parentThreadId: childId, kind: 'subagent' }, signal: { working: true } },
    { id: 'review', provider: 'codex', lastWriteMs: now, lineage: { parentThreadId: 'child', kind: 'guardian' }, signal: { working: true } },
    { id: 'silent', provider: 'codex', lastWriteMs: old, lineage: { parentThreadId: childId, kind: 'subagent' }, signal: {} },
  ];
  const groups = buildDelegationGroups([p], providers, now).groups;
  assert.equal(groups[0].active, true); assert.equal(groups[0].agents[0].state, 'running');
  assert.deepEqual(groups[0].agents[0].children.map(c => c.state), ['running', 'ended']);
  const expired = ageDelegationGroups(groups, now + RECENT_DONE_MS + 1, []);
  assert.equal(expired[0].active, false); assert.equal(expired[0].agents[0].children[0].children[0].state, 'ended');
  const owned = ageDelegationGroups(expired, now + RECENT_DONE_MS + 1, [p.id]);
  assert.equal(owned[0].agents[0].children[0].children[0].state, 'quiet');
});
