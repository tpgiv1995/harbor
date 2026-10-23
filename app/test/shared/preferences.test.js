'use strict';

// The opt-in preferences. The property that matters most is the negative one:
// with no preferences block, or any value that is not exactly the opt-in,
// every launch keeps Harbor's own flags.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PREFERENCE_DEFAULTS, normalizePreferences, claudePermissionArgs,
  codexDefaultPermission, codexDefaultPermissionArgs, CODEX_PERMISSION_FLAGS,
} = require('../../src/shared/preferences.cjs');
const { SCHEMA } = require('../../src/main/config/schema.js');

// parseAi resolves binaries from these before it would read any config file.
process.env.HARBOR_CLAUDE_BIN = 'claude';
process.env.HARBOR_CODEX_BIN = 'codex';
const {
  parseAi, resumeArgv, withCodexPaneControls, withPreferredPromptSuggestions, sessiondChildEnv,
} = require('../../../bin/harbor-bin.cjs');

const ON = { claudeAutoMode: true, codexAutoMode: true, promptSuggestions: true, theme: 'reading', usageDebugLog: true };

test('every preference is off by default, and only the exact opt-in turns one on', () => {
  for (const raw of [undefined, null, {}, [], 'yes', { claudeAutoMode: 'true', codexAutoMode: 1, promptSuggestions: 'on', theme: 'neon', usageDebugLog: {} }]) {
    assert.deepEqual(normalizePreferences(raw), PREFERENCE_DEFAULTS);
  }
  assert.deepEqual(normalizePreferences(ON), ON);
  // The config schema ships the same defaults, so the two cannot drift.
  assert.deepEqual(SCHEMA.preferences, { ...PREFERENCE_DEFAULTS });
});

test('Claude launches and resumes keep bypass unless auto mode is opted into', () => {
  assert.deepEqual(claudePermissionArgs(), ['--dangerously-skip-permissions']);
  assert.deepEqual(parseAi([]).argv, ['claude', '--dangerously-skip-permissions']);
  assert.deepEqual(resumeArgv('synthetic-id'), ['claude', '--dangerously-skip-permissions', '--resume', 'synthetic-id']);
  const auto = ['--permission-mode', 'auto', '--allow-dangerously-skip-permissions'];
  assert.deepEqual(parseAi(['--model', 'opus'], { preferences: ON }).argv, ['claude', ...auto, '--model', 'opus']);
  assert.deepEqual(resumeArgv('synthetic-id', 'go on', ON), ['claude', ...auto, '--resume', 'synthetic-id', 'go on']);
});

test('Codex launches and resumes keep full access unless auto is opted into', () => {
  assert.equal(codexDefaultPermission(), 'full');
  assert.deepEqual(parseAi(['--provider', 'codex']).argv, ['codex', '--dangerously-bypass-approvals-and-sandbox']);
  assert.equal(codexDefaultPermission(ON), 'auto');
  assert.deepEqual(codexDefaultPermissionArgs(ON), ['--approve-for-me']);
  assert.deepEqual(parseAi(['--provider', 'codex', '--model', 'gpt-5'], { preferences: ON }).argv, ['codex', '--approve-for-me', '--model', 'gpt-5']);
  assert.deepEqual(parseAi(['--provider', 'codex', '--resume-id', 'synthetic-id'], { preferences: ON }).argv, ['codex', 'resume', '--approve-for-me', 'synthetic-id']);
  // codex refuses --approve-for-me beside the bypass flag, so auto carries it alone.
  assert.ok(!parseAi(['--provider', 'codex'], { preferences: ON }).argv.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('pane controls go straight after whichever Codex permission flag a launch carries', () => {
  const controls = ['--no-daemon', '-c', 'features.cli_daybreak=false'];
  assert.deepEqual([...CODEX_PERMISSION_FLAGS].sort(), ['--approve-for-me', '--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(
    withCodexPaneControls(['codex', 'resume', '--approve-for-me', 'synthetic-id'], controls),
    ['codex', 'resume', '--approve-for-me', ...controls, 'synthetic-id'],
  );
  assert.deepEqual(
    withCodexPaneControls(['codex', '--dangerously-bypass-approvals-and-sandbox', '--model', 'm'], controls),
    ['codex', '--dangerously-bypass-approvals-and-sandbox', ...controls, '--model', 'm'],
  );
});

test('prompt suggestions are set only when opted into, and an explicit value still wins', () => {
  assert.equal(withPreferredPromptSuggestions({}, {}).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, undefined);
  const on = withPreferredPromptSuggestions({ CLAUDE_CONFIG_DIR: '/x/.claude' }, ON);
  assert.equal(on.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '1');
  // The daemon only ever sees the cleaned env; the choice must survive it.
  assert.equal(sessiondChildEnv(on, { agent: 'claude' }).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '1');
  assert.equal(withPreferredPromptSuggestions({ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0' }, ON).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '0');
});

test('the Reading theme stylesheet is inert unless its root attribute is set', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/reading-theme.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  // Every rule's selector list, including those inside @container blocks.
  for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of match[1].split(',')) {
      const trimmed = selector.trim();
      if (trimmed) selectors.push(trimmed);
    }
  }
  assert.ok(selectors.length > 20, `parsed ${selectors.length} selectors`);
  for (const selector of selectors) {
    assert.ok(selector.startsWith(':root[data-harbor-theme="reading"]'), selector);
  }
});
