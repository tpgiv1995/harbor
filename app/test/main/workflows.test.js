'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORKFLOW_PRESETS,
  workflowPresets,
  resolveWorkflowLaunch,
} = require('../../src/main/workflows.js');
const { extractHandoffPath } = require('../../src/main/providers/transcript.js');

// Workflows are the user's, not the app's. Harbor used to SHIP four of them,
// carrying absolute paths into one specific notes vault and one specific
// checkout, which is somebody's folder layout compiled into a product. They now
// come from config, so this asserts the resolution rules against a supplied set
// instead of a built-in one.
const CONFIG = {
  profiles: [
    { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: '/home/testuser/.claude', email: null, isDefault: true },
    { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', provider: 'claude', configHome: '/home/testuser/.claude-team', email: null, isDefault: false },
  ],
  workflows: [
    { id: 'acclimate', label: '/acclimate', command: '/acclimate', cwd: 'current', profile: 'current', provider: 'current', model: 'current', effort: 'current' },
    { id: 'notes', label: '/notes', command: '/notes-pipeline', cwd: '/home/testuser/Documents/Notes', profile: 'current', provider: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'backfill', label: 'backfill', command: '/log-backfill', cwd: '/home/testuser/dev/example-app', profile: 'team', provider: 'claude', model: 'claude-sonnet-5', effort: 'high' },
  ],
};

test('no workflow ships with the app', () => {
  assert.deepEqual(Object.keys(WORKFLOW_PRESETS), [], 'a default workflow would be somebody folder layout');
});

test('workflow presets map launch context and commands', () => {
  const current = {
    cwd: '/work/current',
    account: 'personal',
    provider: 'claude',
    model: 'claude-opus-4-8[1m]',
    effort: 'xhigh',
  };

  assert.deepEqual(Object.keys(workflowPresets(CONFIG)), ['acclimate', 'notes', 'backfill']);
  assert.deepEqual(resolveWorkflowLaunch('acclimate', current, CONFIG), {
    account: 'personal',
    cwd: '/work/current',
    provider: 'claude',
    model: 'claude-opus-4-8',
    effort: 'xhigh',
    command: '/acclimate',
  });
  // A pinned cwd, model and effort override the current context; the label and
  // the command differ, and the command is what is sent.
  assert.deepEqual(resolveWorkflowLaunch('notes', current, CONFIG), {
    account: 'personal',
    cwd: '/home/testuser/Documents/Notes',
    provider: 'claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    command: '/notes-pipeline',
  });
  // A pinned profile is NOT inherited from the current session.
  assert.deepEqual(resolveWorkflowLaunch('backfill', current, CONFIG), {
    account: 'team',
    cwd: '/home/testuser/dev/example-app',
    provider: 'claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    command: '/log-backfill',
  });
});

test('handoff path capture finds the generated absolute path in transcript output', () => {
  const tail = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Done. Handoff written to:\\n/home/testuser/dev/harbor/.claude/handoffs/handoff-2026-07-19-1432.md"}]}}',
    '{"type":"progress","data":"ignored"}',
  ].join('\n');

  assert.equal(
    extractHandoffPath(tail),
    '/home/testuser/dev/harbor/.claude/handoffs/handoff-2026-07-19-1432.md',
  );
});
