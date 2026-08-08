'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AI = path.resolve(__dirname, '../../../bin/ai');

function parse(...argv) {
  return spawnSync(AI, argv, { encoding: 'utf8', env: { ...process.env, HARBOR_AI_DRY_RUN: '1' } });
}

test('ai dry parse preserves legacy commands and quotes provider configuration', () => {
  assert.equal(parse().stdout.trim(), 'claude --dangerously-skip-permissions');
  // --home selects the config home (applied as CLAUDE_CONFIG_DIR, not an argv
  // flag), so it does not change the printed command line either.
  assert.equal(parse('--home', 'team').stdout.trim(), 'claude --dangerously-skip-permissions');
  // The legacy per-account flags, one literal flag per account, are gone: bin/ai takes
  // --home <PROFILE|CONFIG_HOME> only, for every account.
  assert.match(parse('--team').stderr, /unknown option: --team/);
  assert.equal(parse('--model', 'opus').stdout.trim(), 'claude --dangerously-skip-permissions --model opus');
  // Non-claude providers default to full permission bypass (matching claude's
  // own --dangerously-skip-permissions) so new sessions come up ready to run.
  assert.equal(parse('--provider', 'codex', '--model', 'gpt-5.6-sol', '--effort', 'xhigh').stdout.trim(), 'codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol -c model_reasoning_effort=xhigh');
  assert.equal(parse('--provider', 'cursor', '--model', 'default').stdout.trim(), 'cursor-agent --force --model default');
});

test('ai rejects missing values and unknown providers', () => {
  assert.notEqual(parse('--model').status, 0);
  assert.match(parse('--provider', 'other').stderr, /unknown provider/);
});

test('ai --resume-id builds provider resume argv and rejects it for claude', () => {
  assert.equal(
    parse('--provider', 'codex', '--resume-id', '019f-abc').stdout.trim(),
    'codex resume --dangerously-bypass-approvals-and-sandbox 019f-abc',
  );
  assert.equal(
    parse('--provider', 'cursor', '--resume-id', 'uuid-1').stdout.trim(),
    'cursor-agent --force --resume uuid-1',
  );
  // A resumed session keeps its own model/effort; presets must not leak in.
  assert.equal(
    parse('--provider', 'codex', '--model', 'gpt-5.6-sol', '--effort', 'high', '--resume-id', 'x').stdout.trim(),
    'codex resume --dangerously-bypass-approvals-and-sandbox x',
  );
  assert.match(parse('--resume-id', 'x').stderr, /codex\/cursor only/);
});
