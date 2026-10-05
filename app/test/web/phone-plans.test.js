'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const React = require('react');

const profiles = [
  { id: 'oak', label: 'Oak', provider: 'claude', isDefault: true },
  { id: 'maple', label: 'Maple', provider: 'claude' },
  { id: 'birch', label: 'Birch', provider: 'codex', isDefault: true },
  { id: 'cedar', label: 'Cedar', provider: 'codex' },
];
const options = { profiles, defaults: { provider: 'claude', model: 'toy' }, providers: { claude: { models: [{ value: 'toy' }] }, codex: { models: [{ value: 'default' }] } } };
function component(file, name) {
  const states = [], deps = [], pending = []; let cursor = 0;
  const effect = (fn, next) => { const i = cursor++; if (!deps[i] || !next || next.some((x, j) => x !== deps[i][j])) { deps[i] = next; pending.push(fn); } };
  const react = { ...React, useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useEffect: effect, useLayoutEffect: effect, useMemo: fn => fn(), useCallback: fn => fn, useRef: value => { const i = cursor++; return states[i] ||= { current: value }; } };
  const entry = path.resolve(__dirname, '../../web/src', file);
  const code = buildSync({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'empty' }, logLevel: 'silent' }).outputFiles[0].text;
  const module = { exports: {} }, req = createRequire(entry);
  new Function('require', 'module', 'exports', code)(id => id === 'react' ? react : req(id), module, module.exports);
  return { render: props => { cursor = 0; return module.exports[name](props); }, flush: async () => { for (const fn of pending.splice(0)) fn(); await new Promise(r => setImmediate(r)); } };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  // PlanChoices has no hooks. Expand its actual rendered buttons.
  if (typeof tree.type === 'function' && tree.type.name === 'PlanChoices') return nodes(tree.type(tree.props));
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) { if (tree == null || typeof tree === 'boolean') return ''; if (typeof tree !== 'object') return String(tree); if (Array.isArray(tree)) return tree.map(text).join(''); return text(tree.props?.children); }
function client() { const calls = []; return { calls, getState: () => 'connected', onChannel: () => () => {}, call: async (method, payload) => {
  calls.push({ method, payload }); if (method === 'new-session:options') return options;
  if (method === 'new-session:folder') return ['C:\\Toy'];
  if (method === 'capabilities:get') return { ok: true, capabilities: { models: { families: [] } } };
  return { ok: true, sessionId: 'toy' };
} }; }
async function mount(file, name, props) { const c = component(file, name); c.render(props); await c.flush(); c.render(props); await c.flush(); return { ...c, tree: c.render(props) }; }
test('new session puts only Claude plans above folders and marks its default and summary', async () => {
  const rpc = client(), props = { open: true, client: rpc, onClose() {} };
  const c = await mount('newsession/NewSessionSheet.jsx', 'NewSessionSheet', props);
  const all = nodes(c.tree), group = all.find(n => n.props?.['aria-label'] === 'Plan');
  assert.ok(group); assert.equal(text(group), 'OOakMMaple');
  assert.ok(all.indexOf(group) < all.findIndex(n => n.props?.['aria-label'] === 'Project folders'));
  assert.equal(nodes(group).find(n => n.type === 'button' && text(n).includes('Oak')).props['aria-pressed'], true);
  assert.match(text(all.find(n => n.props?.className === 'newsession-summary')), /Claude.*Oak/);
});
test('provider switch selects that provider default, permits another plan, and submits its id', async () => {
  const rpc = client(), props = { open: true, client: rpc, onClose() {} };
  const c = await mount('newsession/NewSessionSheet.jsx', 'NewSessionSheet', props);
  nodes(c.tree).find(n => n.type === 'button' && text(n) === 'Codex').props.onClick();
  let tree = c.render(props); await c.flush(); tree = c.render(props);
  let group = nodes(tree).find(n => n.props?.['aria-label'] === 'Plan'); assert.ok(group);
  assert.equal(text(group), 'BBirchCCedar'); assert.equal(nodes(group).find(n => text(n) === 'BBirch').props['aria-pressed'], true);
  nodes(group).find(n => n.type === 'button' && text(n) === 'CCedar').props.onClick(); tree = c.render(props);
  await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(rpc.calls.find(c => c.method === 'new-session').payload.account, 'cedar');
});
for (const working of [false, true]) test(`plan choice ${working ? 'is disabled while working' : 'requires one explicit confirmation and cancel sends nothing'}`, async () => {
  const rpc = client(), props = { open: true, client: rpc, onClose() {}, session: { id: 'toy', provider: 'claude', home: 'oak', isLive: true, paneId: 'p', agentStatus: working ? 'working' : 'idle' }, header: { working } };
  const c = await mount('capability/CapabilitySheet.jsx', 'CapabilitySheet', props);
  const button = nodes(c.tree).find(n => n.type === 'button' && text(n) === 'MMaple'); assert.ok(button);
  assert.equal(button.props.disabled, working);
  if (working) { assert.match(text(c.tree), /Wait until this session is idle/); return; }
  button.props.onClick(); let tree = c.render(props); assert.match(text(tree), /Continue this session on Maple\? Claude restarts in this window; the conversation carries over/);
  assert.equal(rpc.calls.filter(c => c.method === 'resume-session').length, 0);
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Cancel').props.onClick(); tree = c.render(props);
  assert.equal(nodes(tree).some(n => n.props?.role === 'alertdialog'), false);
  nodes(tree).find(n => n.type === 'button' && text(n) === 'MMaple').props.onClick(); tree = c.render(props);
  await nodes(tree).find(n => n.type === 'button' && text(n) === 'Continue').props.onClick();
  assert.deepEqual(rpc.calls.filter(c => c.method === 'resume-session'), [{ method: 'resume-session', payload: { id: 'toy', detectedHome: 'maple', movePlan: { confirmed: true, fromHome: 'oak', paneId: 'p' } } }]);
});
test('a turn starting while confirmation is open cancels the confirmation', async () => {
  const props = { open: true, client: client(), session: { id: 'toy', provider: 'claude', home: 'oak', isLive: true, paneId: 'p', agentStatus: 'idle' }, header: { working: false } };
  const c = await mount('capability/CapabilitySheet.jsx', 'CapabilitySheet', props);
  const pick = nodes(c.tree).find(n => n.type === 'button' && text(n) === 'MMaple'); assert.ok(pick); pick.props.onClick();
  c.render({ ...props, header: { working: true } }); await c.flush();
  assert.equal(nodes(c.render({ ...props, header: { working: true } })).some(n => n.props?.role === 'alertdialog'), false);
});
test('Codex current plan is named but moving its conversation is not offered', async () => {
  const props = { open: true, client: client(), session: { id: 'toy', provider: 'codex', home: 'birch', isLive: true, paneId: 'p' }, header: { working: false } };
  const c = await mount('capability/CapabilitySheet.jsx', 'CapabilitySheet', props);
  assert.match(text(c.tree), /Current: Birch/); assert.match(text(c.tree), /separate homes/);
  assert.equal(nodes(c.tree).some(n => n.props?.['aria-label'] === 'Plan'), false);
});
test('a late plan-change result cannot relabel another session', async () => {
  const rpc = client(), original = rpc.call; let finish;
  rpc.call = (method, payload) => method === 'resume-session' ? new Promise(resolve => { finish = resolve; }) : original(method, payload);
  const props = { open: true, client: rpc, session: { id: 'toy', provider: 'claude', home: 'oak', isLive: true, paneId: 'p', agentStatus: 'idle' }, header: { working: false } };
  const c = await mount('capability/CapabilitySheet.jsx', 'CapabilitySheet', props);
  nodes(c.tree).find(n => n.type === 'button' && text(n) === 'MMaple').props.onClick();
  const pending = nodes(c.render(props)).find(n => n.type === 'button' && text(n) === 'Continue').props.onClick();
  const next = { ...props, session: { ...props.session, id: 'other', paneId: 'q' } };
  c.render(next); await c.flush(); finish({ ok: true }); await pending;
  const tree = c.render(next); assert.match(text(tree), /Current: Oak/); assert.doesNotMatch(text(tree), /now on Maple/);
});
