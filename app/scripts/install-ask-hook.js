#!/usr/bin/env node
'use strict';

// Install bin/harbor-ask-hook as a PreToolUse hook (matcher AskUserQuestion)
// in the MASTER Claude settings (~/.claude/settings.json). sync-plans.mjs
// reconciles hooks into the other config homes, so this is edited once.
//
// Idempotent: an entry naming harbor-ask-hook is left alone; run with
// --remove to take it out. The 12 hour timeout is deliberate: a question can
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
const entries = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
const isOurs = (entry) => (entry.hooks || []).some((h) => /harbor-ask-hook/.test(String(h.command || '')));
const present = entries.some(isOurs);

if (remove) {
  settings.hooks.PreToolUse = entries.filter((entry) => !isOurs(entry));
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(present ? `removed the AskUserQuestion hook from ${settingsFile}` : 'nothing to remove');
} else if (present) {
  console.log(`already installed in ${settingsFile}`);
} else {
  entries.push({
    matcher: 'AskUserQuestion',
    hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }],
  });
  settings.hooks.PreToolUse = entries;
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`installed: PreToolUse AskUserQuestion -> ${command} (timeout ${HOOK_TIMEOUT_S}s) in ${settingsFile}`);
  console.log('now run: node C:\\tools\\claude-sync\\sync-plans.mjs --apply');
}
