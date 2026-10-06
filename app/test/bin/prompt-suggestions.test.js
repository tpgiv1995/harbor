'use strict';

// Claude's prompt suggestions are an extra model request per turn, so Harbor
// never turns them on by itself; a user who sets the variable in Harbor's own
// environment gets it carried through the cleaned env the daemon spawns with.
// Two-sided: carried when set, absent when not.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sessiondChildEnv } = require('../../../bin/harbor-bin.cjs');

test('a user-set suggestion flag survives the cleaned env the daemon spawns with', () => {
  const env = sessiondChildEnv({ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '1', CLAUDE_CONFIG_DIR: '/x/.claude-max', SECRET_THING: 'no' });
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '1');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/x/.claude-max');
  assert.equal(env.SECRET_THING, undefined);
});

test('Harbor does not turn suggestions on when nobody asked', () => {
  assert.equal(sessiondChildEnv({ CLAUDE_CONFIG_DIR: '/x/.claude' }).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, undefined);
});
