'use strict';

// A live agy pane is a Gemini row, never a Claude one (2026-11-23). An unknown agent used to fall through to Claude, so
// every Gemini pane masqueraded as a Claude row whose window could never resolve a transcript. The two twin files
// (sidebar-model.cjs for main and tests, sidebar-model.js for the renderer) must agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { paneProvider } = require('../../src/shared/sidebar-model.cjs');

test('the daemon\'s gemini agent, and the raw agy executable name, map to the gemini provider', () => {
  assert.equal(paneProvider({ agent: 'gemini' }), 'gemini');
  assert.equal(paneProvider({ agent: 'agy' }), 'gemini');
  assert.equal(paneProvider({ agent: 'GEMINI' }), 'gemini');
  assert.equal(paneProvider({ agent: 'cursor-agent' }), 'cursor', 'the older mappings are untouched');
  assert.equal(paneProvider({ agent: 'codex' }), 'codex');
  assert.equal(paneProvider({ agent: 'claude' }), 'claude');
  assert.equal(paneProvider({}), 'claude', 'a pane with no agent is still the old default');
  assert.equal(paneProvider({ agent: 'gemini', provider: 'cursor' }), 'cursor', 'an explicit provider outranks the agent');
});

test('the .js twin names gemini and agy exactly as the .cjs does', () => {
  const dir = path.join(__dirname, '../../src/shared');
  const block = (file) => /const AGENT_PROVIDERS = \{[\s\S]*?\n\};/.exec(fs.readFileSync(path.join(dir, file), 'utf8'))[0];
  assert.equal(block('sidebar-model.js'), block('sidebar-model.cjs'));
  assert.match(block('sidebar-model.js'), /gemini: 'gemini'/);
  assert.match(block('sidebar-model.js'), /agy: 'gemini'/);
});
