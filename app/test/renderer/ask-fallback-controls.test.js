'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const React = require('react');

// Render the real JSX with a fixed poll result. Effects are disabled: this unit
// proof tests the actual buttons and dispatched actions, without a GUI or RPC.
for (const [name, file] of [
  ['desktop', '../../src/renderer/stage/AskCard.jsx'],
  ['phone', '../../web/src/ask/AskCard.jsx'],
]) {
  test(`${name} fallback exposes horizontal navigation without submitting`, async () => {
    const entry = path.resolve(__dirname, file);
    const compiled = buildSync({ entryPoints: [entry], bundle: true, write: false,
      platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'empty' } }).outputFiles[0].text;
    const menu = { fallback: true, screen: ['MCP server "example" wants to open a URL', 'Open in browser   I\'m done, continue   Decline'] };
    let stateIndex = 0;
    const react = { ...React,
      useState: (initial) => [stateIndex++ === 0 ? menu : initial, () => {}],
      useRef: (current) => ({ current }), useEffect: () => {},
      useMemo: (fn) => fn(), useReducer: (_fn, arg, init) => [init(arg), () => {}],
    };
    const module = { exports: {} };
    const req = createRequire(entry);
    new Function('require', 'module', 'exports', compiled)(id => id === 'react' ? react : req(id), module, module.exports);
    const actions = [];
    const previousWindow = global.window;
    global.window = { harbor: { session: {
      answerMenu: async ({ action }) => { actions.push(action); return { ok: true }; },
      menuState: async () => menu,
    } } };
    try {
      const tree = module.exports.AskCard({ pane: { paneId: 'example-pane' }, sessionId: 'example-session',
        client: { call: async (_method, { action }) => {
          if (!action) return menu;
          actions.push(action); return { ok: true };
        } } });
      const buttons = [];
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        if (node.type === 'button') buttons.push(node);
        visit(node.props?.children);
      };
      visit(tree);
      for (const [label, key] of [['←', 'left'], ['→', 'right']]) {
        const button = buttons.find(b => b.props['aria-label'] === `Send ${label} to the prompt`);
        assert.ok(button, `${label} must be reachable in the rendered fallback`);
        button.props.onClick({ stopPropagation() {} });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(actions.at(-1), { type: 'key', key });
      }
      assert.deepEqual(actions.map(a => a.key), ['left', 'right']);
    } finally { global.window = previousWindow; }
  });
}
