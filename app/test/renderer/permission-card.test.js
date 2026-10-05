'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { fixture } = require('../support/permission-dialog-fixtures.js');
function load(file, react = React) {
  const entry = path.resolve(__dirname, '../../src/renderer/stage', file);
  const compiled = buildSync({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'empty' } }).outputFiles[0].text;
  const module = { exports: {} };
  const req = createRequire(entry);
  new Function('require', 'module', 'exports', compiled)(id => id === 'react' ? react : req(id), module, module.exports);
  return module.exports;
}
const { PermissionCard, ScrapedPermissionCard } = load('PermissionCard.jsx');
const { PromptForm } = load('PromptForm.jsx');
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const options = [1, 2, 3].map(index => ({ index, label: index === 3 ? 'No' : 'Yes' }));
for (const kind of ['edit', 'write', 'fetch']) test(`${kind}: native feedback opens inline and dispatches the guarded next-message action`, () => {
  const menu = parseMenu(fixture(kind)); const actions = [];
  const card = ScrapedPermissionCard({ menu, onAction: action => actions.push(action) });
  assert.equal(card.props.feedbackIndex, 3);
  card.props.onChoose(3, 'Keep the red toy.');
  assert.deepEqual(actions.pop(), { type: 'permission-feedback', index: 3, text: 'Keep the red toy.' });
  card.props.onChoose(3, ''); assert.deepEqual(actions.pop(), { type: 'select', index: 3 });
});
test('native display removes only trailing key hints, retaining the original matching label', () => {
  const menu = parseMenu(fixture('edit'));
  const html = render(ScrapedPermissionCard, { menu });
  assert.doesNotMatch(html, /\(esc\)/i);
  assert.match(menu.options[2].label, /\(esc\)$/i);
  assert.match(render(PermissionCard, { options: [{ index: 1, label: 'Yes (for this session)' }] }), /Yes \(for this session\)/);
});
test('plan has an approval eyebrow and no terminal-only instructions in its detail', () => {
  const html = render(ScrapedPermissionCard, { menu: parseMenu(fixture('plan')) });
  assert.match(html, /Plan ready for approval/i);
  assert.doesNotMatch(html, /shift\+tab|ctrl\+g|edit in Notepad/i);
  assert.match(html, /Check that each wheel turns/);
});
test('desktop lists three ordinary digit shortcuts with natural punctuation', () => {
  assert.match(render(PermissionCard, { title: 'Toy', options }), /1, 2 or 3 to choose/);
  assert.match(render(PermissionCard, { title: 'Toy', options, feedbackIndex: 3 }), /1 or 2 to choose · 3 to give feedback · Esc to decline/);
});
test('both phone lanes omit keyboard hints while desktop retains them', () => {
  const ask = { kind: 'permission', prompt: { toolName: 'Edit', toolInput: { file_path: 'C:\\Synthetic\\toy.txt', old_string: 'Red toy', new_string: 'Blue toy' }, persistent: { label: 'Yes, for this session' } } };
  for (const [component, props] of [[ScrapedPermissionCard, { menu: parseMenu(fixture('edit')) }], [PromptForm, { ask }]]) {
    assert.doesNotMatch(render(component, { ...props, device: 'phone' }), /to choose|to give feedback|Esc to decline/);
    assert.match(render(component, { ...props, device: 'desktop' }), /1 or 2 to choose/);
  }
});
test('hook and native edits render identical sign, space and context markup without line numbers', () => {
  const ask = { kind: 'permission', prompt: { toolName: 'Edit', toolInput: { file_path: 'C:\\Synthetic\\toy.txt', old_string: 'Red toy\nKeep the wheels', new_string: 'Blue toy\nKeep the wheels' }, persistent: { label: 'Yes, for this session' } } };
  const diff = html => html.match(/<pre class="prompt-diff[^\"]*">[\s\S]*?<\/pre>/)?.[0];
  const hook = diff(render(PromptForm, { ask }));
  const native = diff(render(ScrapedPermissionCard, { menu: parseMenu(fixture('edit')) }));
  assert.ok(hook); assert.equal(native, hook);
  assert.match(hook, />- <\/span>Red toy/); assert.match(hook, />\+ <\/span>Blue toy/);
  assert.match(hook, /Keep the wheels/);
});
test('hook and native Write previews expose all supplied lines in the same scrolling block', () => {
  const content = Array.from({ length: 15 }, (_, i) => `Toy instruction ${i + 1}`).join('\n');
  const ask = { kind: 'permission', prompt: { toolName: 'Write', toolInput: { file_path: 'C:\\Synthetic\\toy.txt', content }, persistent: { label: 'Yes, for this session' } } };
  const preview = html => html.match(/<pre>[\s\S]*?<\/pre>/)?.[0];
  const hook = preview(render(PromptForm, { ask }));
  assert.equal(hook, preview(render(ScrapedPermissionCard, { menu: parseMenu(fixture('write')) })));
  assert.match(hook, /Toy instruction 15/);
});
for (const [name, file] of [['desktop', 'AskCard.jsx'], ['phone', path.resolve(__dirname, '../../web/src/ask/AskCard.jsx')]]) {
  test(`${name}: a rejected feedback send keeps its text after the native menu disappears`, async () => {
    const values = [parseMenu(fixture('edit'))]; let cursor = 0;
    const react = { ...React, useEffect: () => {}, useMemo: fn => fn(), useRef: current => ({ current }),
      useReducer: (_fn, arg, init) => [init(arg), () => {}],
      useState: initial => { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = value; }]; } };
    const { AskCard } = load(file, react);
    const reason = 'The tool was declined, but feedback was not sent.';
    const props = { pane: { paneId: 'p' }, sessionId: 'toy', client: { call: async method => method === 'session:menu-answer' ? { ok: false, reason } : null } };
    const oldWindow = global.window;
    global.window = { harbor: { session: { answerMenu: async () => ({ ok: false, reason }), menuState: async () => null } } };
    const find = (node, predicate) => {
      if (!node || typeof node !== 'object') return null;
      if (predicate(node)) return node;
      for (const child of React.Children.toArray(node.props?.children)) { const hit = find(child, predicate); if (hit) return hit; }
      return null;
    };
    try {
      const card = find(AskCard(props), node => typeof node.props?.onAction === 'function'); assert.ok(card);
      await card.props.onAction({ type: 'permission-feedback', index: 3, text: 'Keep the red toy.' });
      cursor = 0;
      const recovery = find(AskCard(props), node => node.props?.text === 'Keep the red toy.');
      assert.ok(recovery, 'feedback survives a null menu refresh'); assert.equal(recovery.props.reason, reason);
      recovery.props.onClose(); cursor = 0; assert.equal(AskCard(props), null);
    } finally { global.window = oldWindow; }
  });
}
