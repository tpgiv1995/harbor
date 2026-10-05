'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withPromptSuggestions, sessiondChildEnv } = require('../../../bin/harbor-bin.cjs');

test('Claude sessions Harbor starts get prompt suggestions on', () => {
  assert.equal(withPromptSuggestions({}).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '1');
});

test('an explicit value in the environment is left alone', () => {
  assert.equal(withPromptSuggestions({ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0' }).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '0');
});

test('the flag survives the cleaned env the daemon spawns with', () => {
  const env = sessiondChildEnv(withPromptSuggestions({ CLAUDE_CONFIG_DIR: '/x/.claude-max', SECRET_THING: 'no' }));
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '1');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/x/.claude-max');
});
