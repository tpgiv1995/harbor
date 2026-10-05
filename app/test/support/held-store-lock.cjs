'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function holdStoreLock(t, lock) {
  const child = spawn(process.execPath, [path.join(__dirname, 'store-lock-owner.cjs'), lock, 'held'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('release');
    assert.equal((await closed)[0], 0);
    t.diagnostic(`lock owner pid: ${child.pid} confirmed closed`);
  });
  await once(child.stdout, 'data');
}

module.exports = { holdStoreLock };
