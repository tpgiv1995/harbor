'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureEnv, ownedRoot, VERIFY } = require('../scripts/lib/capture-runtime.cjs');

test('capture redirects every home spelling and refuses a foreign provider home before reading it', () => {
  fs.mkdirSync(VERIFY, { recursive: true });
  const root = ownedRoot(fs.mkdtempSync(path.join(VERIFY, 'harbor-guard-test-')));
  const other = ownedRoot(fs.mkdtempSync(path.join(VERIFY, 'harbor-guard-decoy-')));
  try {
    for (const dir of [root, other]) {
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: dir === root ? 'fixture' : 'decoy' }));
    }
    const env = captureEnv(root, { ...process.env, HOME: other, USERPROFILE: other,
      CLAUDE_CONFIG_DIR: path.join(other, '.claude'), CODEX_HOME: path.join(other, '.codex') });
    assert.equal(env.HOME, root);
    assert.equal(env.USERPROFILE, root);
    assert.equal(env.HOMEDRIVE + env.HOMEPATH, root);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(root, '.claude'));
    assert.equal(env.CODEX_HOME, path.join(root, '.codex'));
    const child = spawnSync(process.execPath, ['-e', `
      const fs=require('node:fs'),path=require('node:path');
      const own=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude','settings.json')));
      let refused=false;
      try{fs.readFileSync(process.argv[1]);}catch(e){refused=e.message.startsWith('Capture refused account-home access:');}
      console.log(JSON.stringify({own,refused,home:require('node:os').homedir()}));
    `, path.join(other, '.claude', 'settings.json')], { env, windowsHide: true, timeout: 15000, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { own:{model:'fixture'}, refused:true, home:root });
  } finally {
    fs.rmSync(ownedRoot(root), { recursive:true, force:true });
    fs.rmSync(ownedRoot(other), { recursive:true, force:true });
  }
});
