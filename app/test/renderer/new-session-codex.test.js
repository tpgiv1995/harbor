'use strict';

// The session popover's codex controls, rendered for real: the four
// permission modes with the default (full access) lit on a launch, the
// launch-only extras, and the copy that says how Apply reaches an existing
// codex session. Rendered through esbuild + react-dom/server like the
// permission-card spec; the portal renders inline because there is no DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load() {
  const entry = path.resolve(__dirname, '../../src/renderer/NewSessionConfig.jsx');
  const compiled = buildSync({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react', 'react-dom'], loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    // providers.js resolves its logos with new URL(..., import.meta.url).
    define: { 'import.meta.url': '"file:///harbor-fixture/renderer/providers.js"' }, logLevel: 'silent',
  }).outputFiles[0].text;
  const module = { exports: {} };
  const req = createRequire(entry);
  const reactDom = { createPortal: (node) => node };
  new Function('require', 'module', 'exports', compiled)(
    (id) => (id === 'react' ? React : id === 'react-dom' ? reactDom : req(id)),
    module, module.exports,
  );
  return module.exports;
}

global.document = global.document || { body: {} };
const { NewSessionConfig } = load();
const render = (request) => renderToStaticMarkup(React.createElement(NewSessionConfig, {
  request, onClose() {}, onStart() {}, onReconfigure() {},
}));
const pressed = (html, label) => new RegExp(`aria-pressed="true"[^>]*>${label}<`).test(html);

test('a codex launch offers the four modes with full access lit, plus search and extra folders', () => {
  const html = render({ provider: 'codex', folder: '/tmp/fixture' });
  for (const label of ['Auto', 'Ask', 'Read-only', 'Full access']) assert.match(html, new RegExp(`>${label}<`));
  assert.ok(pressed(html, 'Full access'), 'full access is the launch default');
  assert.ok(!pressed(html, 'Auto'));
  assert.match(html, /Web search/);
  assert.match(html, /Add writable folder/);
});

test('claude launches show none of the codex controls', () => {
  const html = render({ provider: 'claude', folder: '/tmp/fixture' });
  assert.doesNotMatch(html, /Codex permissions|Web search|Add writable folder/);
});

test('an existing codex session lights its recorded mode and says how Apply reaches it', () => {
  const session = { id: '01a14000-0000-7000-8000-000000000001', provider: 'codex', cwd: '/tmp/fixture' };
  const header = { model: { id: 'gpt-6-sol' }, effort: 'high', sandboxPolicy: 'danger-full-access', working: false, lastSignal: 'idle' };
  const dormant = render({ session, header, folder: '/tmp/fixture' });
  assert.ok(pressed(dormant, 'Full access'), 'a bypass session reads back as full access');
  assert.match(dormant, /Changes resume this Codex session/);
  // Launch extras cannot survive a resume, so they are not offered here.
  assert.doesNotMatch(dormant, /Web search/);
  const live = render({ session, header, pane: { paneId: 'p1' }, drivable: true, folder: '/tmp/fixture' });
  assert.match(live, /Changes stop this Codex pane and resume/);
  // Workspace-write without a reviewer cannot name auto or ask: nothing lit.
  const unknown = render({ session, header: { ...header, sandboxPolicy: 'workspace-write', approvalPolicy: 'on-request' }, folder: '/tmp/fixture' });
  for (const label of ['Auto', 'Ask', 'Read-only', 'Full access']) assert.ok(!pressed(unknown, label));
  assert.match(unknown, /current mode as recorded/);
});

test('a provisional codex window still launches, and says why', () => {
  const html = render({ session: { id: 'pane:9', provider: 'codex', cwd: '/tmp/fixture' }, pane: { paneId: '9' }, folder: '/tmp/fixture' });
  assert.match(html, /Codex names its session at the first message/);
  assert.ok(pressed(html, 'Full access'));
});
