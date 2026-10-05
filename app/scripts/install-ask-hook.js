#!/usr/bin/env node
'use strict';

// Install bin/harbor-ask-hook for AskUserQuestion, permissions and elicitation
// in the MASTER Claude settings (~/.claude/settings.json). sync-plans.mjs
// reconciles hooks into the other config homes, so this is edited once.
//
// Idempotent: replace our entries while preserving neighboring hooks; run with
// --remove to take them out. The 12 hour timeout is deliberate: a question can
// wait all day, and the CLI treats a timed-out hook as no decision, which is
// the same step-aside the hook itself performs when Harbor is absent.
//
// Usage: node scripts/install-ask-hook.js [--remove] [--settings <file>]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HOOK_TIMEOUT_S } = require('../src/shared/ask-protocol.cjs');

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const settingsIndex = args.indexOf('--settings');
const settingsFile = settingsIndex >= 0 ? args[settingsIndex + 1] : path.join(os.homedir(), '.claude', 'settings.json');
const nodeExe = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : 'node';
const hookScript = path.resolve(__dirname, '..', '..', 'bin', 'harbor-ask-hook');
const command = `"${nodeExe}" "${hookScript}"`;

const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
settings.hooks = settings.hooks || {};
// One dispatcher keeps timeout, transport, and step-aside behavior identical.
// Preserve unrelated hooks even when they share an entry with ours.
for (const event of ['PreToolUse', 'PermissionRequest', 'Elicitation']) {
  const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const retained = entries.map(entry => ({
    ...entry,
    hooks: (entry.hooks || []).filter(hook => !/harbor-ask-hook/.test(String(hook.command || ''))),
  })).filter(entry => entry.hooks.length);
  if (!remove) {
    retained.push({
      ...(event === 'PreToolUse' ? { matcher: 'AskUserQuestion' } : {}),
      hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }],
    });
  }
  settings.hooks[event] = retained;
}
fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`${remove ? 'removed' : 'installed'} Harbor question, permission, and elicitation hooks in ${settingsFile}`);
