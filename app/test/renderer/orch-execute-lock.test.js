'use strict';

// After a successful Execute the panel lingers ~900 ms in `done`, and the
// button re-enabled there while the new pane had not reached the mutex yet, so
// a second click started a second orchestrator.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const React = require('react');

function load() {
  const entry = path.resolve(__dirname, '../../src/renderer/orchestration/OrchPanel.jsx');
  const compiled = buildSync({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react'], loader: { '.css': 'empty' }, logLevel: 'silent',
  }).outputFiles[0].text;
  const module = { exports: {} };
  const req = createRequire(entry);
  new Function('require', 'module', 'exports', compiled)(
    (id) => (id === 'react' ? React : req(id)), module, module.exports,
  );
  return module.exports;
}

const { executeLocked } = load();

test('Execute stays locked through done until the panel closes', () => {
  const base = { mutexBlocked: false, sessionId: 's1' };
  assert.equal(executeLocked({ ...base, executeState: 'idle' }), false);
  assert.equal(executeLocked({ ...base, executeState: 'error' }), false, 'a failed kickoff can be retried');
  assert.equal(executeLocked({ ...base, executeState: 'running' }), true);
  assert.equal(executeLocked({ ...base, executeState: 'done' }), true, 'done no longer re-enables the button');
  assert.equal(executeLocked({ ...base, mutexBlocked: true, executeState: 'idle' }), true);
  assert.equal(executeLocked({ ...base, sessionId: null, executeState: 'idle' }), true);
});
