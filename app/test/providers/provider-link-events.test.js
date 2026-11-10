'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { publishProviderLink, restoreProviderLink } = require('../../src/main/providers/provider-link-events.js');
const { createLinkRegistry } = require('../../src/main/session-send.js');
const { mergeSidebarModel } = require('../../src/shared/sidebar-model.cjs');
const A = '019f8250-89cc-73d3-9c1a-30007bced9ff', B = '019f8251-89cc-73d3-9c1a-30007bced9ff';
const pane = id => ({ pane_id: 'pane', workspace_id: 'ws', agent: 'codex', cwd: 'C:\\work\\fixture', agent_session: { kind: 'id', value: id } });

test('a same-pane rebind clears old routing and replaces the old window as well as provisional keys', () => {
  const link = { paneId: 'pane', workspaceId: 'ws', provider: 'codex', sessionId: B, previousSessionId: A, cwd: 'C:\\work\\fixture' };
  const links = createLinkRegistry(), events = [];
  links.set(A, { paneId: 'pane', workspaceId: 'ws' });
  publishProviderLink(link, links, (channel, payload) => events.push({ channel, payload }));
  assert.equal(links.get(A), null); assert.equal(links.get(B).paneId, 'pane');
  assert.deepEqual(events.map(e => e.payload.replacesKey), ['pane:pane', 'live:pane', A]);
  assert(events.every(e => e.channel === 'session:launched' && e.payload.sessionId === B));
  const model = mergeSidebarModel({ historySessions: [A, B].map(id => ({ id, provider: 'codex', cwd: 'C:\\work\\fixture', project: 'fixture', title: id, firstPrompt: 'Synthetic prompt', lastActive: '2026-11-09 12:00' })),
    livePanes: [pane(B)], workspaces: [{ workspace_id: 'ws', cwd: 'C:\\work\\fixture', label: 'fixture' }], now: new Date('2026-11-09T18:00:00Z') });
  const rows = model.projects.flatMap(p => p.sessions);
  assert.equal(rows.find(r => r.id === B).paneId, 'pane');
  assert.equal(Boolean(rows.find(r => r.id === A).isLive), false);
});

test('a first keeper binding replaces both provisional window keys and creates the send link', () => {
  const links = createLinkRegistry(), events = [];
  publishProviderLink({ paneId: 'fresh', sessionId: A, provider: 'codex' }, links, (_, payload) => events.push(payload));
  assert.deepEqual(events.map(e => e.replacesKey), ['pane:fresh', 'live:fresh']);
  assert.equal(links.get(A).paneId, 'fresh');
});

test('a restored route upgrades only stale provisional windows and preserves real-id windows', () => {
  const links = createLinkRegistry(), events = [];
  links.set(A, { paneId: 'fresh' });
  restoreProviderLink({ paneId: 'fresh', sessionId: B, previousSessionId: A, provider: 'codex', cwd: '/fixture', workspaceId: 'ws' }, links,
    (channel, payload) => events.push({ channel, payload }));
  assert.equal(links.get(A), null); assert.equal(links.get(B).paneId, 'fresh');
  assert.deepEqual(events.map(e => e.payload.replacesKey), ['pane:fresh', 'live:fresh']);
  assert(events.every(e => e.channel === 'session:launched' && e.payload.sessionId === B && e.payload.workspaceId === 'ws'));
});

test('the desktop restore handler forwards provisional upgrades to its renderer', () => {
  // Run the actual handler without importing the Electron composition root.
  const file = require('node:path').resolve(__dirname, '../../src/main/index.js');
  const source = require('node:fs').readFileSync(file, 'utf8');
  const body = source.match(/on\('provider-session-restored', link => \{([\s\S]*?)\n\s*\}\);/)?.[1];
  assert.ok(body);
  const links = createLinkRegistry(), events = [];
  const handler = new Function('require', 'paneLinks', 'sendToRenderer', 'link', body);
  handler(require('node:module').createRequire(file), links, (_, payload) => events.push(payload), {
    paneId: 'p', sessionId: B, previousSessionId: A, provider: 'codex',
  });
  assert.deepEqual(events.map(e => e.replacesKey), ['pane:p', 'live:p']);
  assert.equal(links.get(B).paneId, 'p');
});
