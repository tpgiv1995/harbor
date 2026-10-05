'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../../scripts/install-ask-hook.js');
test('prompt installer installs all lanes idempotently and removes only its own hooks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const other = { type: 'command', command: 'synthetic-other-hook' };
  fs.writeFileSync(file, JSON.stringify({ env: { PRESERVE: 'yes' }, hooks: {
    PermissionRequest: [{ matcher: 'Bash', hooks: [{type:'command',command:'old/harbor-ask-hook'},other] }],
    SessionStart: [{ hooks: [other] }],
  } }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script,'--settings',file,...args], {encoding:'utf8',windowsHide:true});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(file,'utf8'));
  };
  const installed = run();
  assert.deepEqual(run(), installed);
  for (const event of ['PreToolUse','PermissionRequest','Elicitation']) {
    const entries = installed.hooks[event].filter(e => e.hooks.some(h => h.command.includes('harbor-ask-hook')));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].matcher, event === 'PreToolUse' ? 'AskUserQuestion' : undefined);
    assert.equal(entries[0].hooks[0].timeout, 43200);
    assert.ok(entries[0].hooks[0].command.includes(path.resolve(__dirname,'../../../bin/harbor-ask-hook')));
  }
  const removed = run('--remove');
  assert.deepEqual(removed.env, {PRESERVE:'yes'});
  assert.deepEqual(removed.hooks.PermissionRequest, [{matcher:'Bash',hooks:[other]}]);
  assert.deepEqual(removed.hooks.SessionStart, [{hooks:[other]}]);
  assert.deepEqual(removed.hooks.PreToolUse, []);
  assert.deepEqual(removed.hooks.Elicitation, []);
});
