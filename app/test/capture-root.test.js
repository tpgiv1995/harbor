'use strict';

// The capture-root rule (2026-11-24): a capture owns only harbor-* folders directly inside app/verify or
// ~/harbor-capture, and children see the same base whatever their own home is. ~/harbor-capture exists because a phone
// capture under app/verify (always inside a <drive>:\dev\<name> checkout) drew every demo project as one group, and one
// under a Temp folder drew none (the phone hides those as scratch).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { ownedRoot, captureEnv, VERIFY, OUTSIDE_BASE } = require('../scripts/lib/capture-runtime.cjs');

test('a capture root is a harbor-* folder directly inside app/verify or ~/harbor-capture', () => {
  assert.equal(OUTSIDE_BASE, process.env.CAPTURE_OUTSIDE_BASE || path.join(os.homedir(), 'harbor-capture'));
  assert.equal(ownedRoot(path.join(VERIFY, 'harbor-demo')), path.join(VERIFY, 'harbor-demo'));
  assert.equal(ownedRoot(path.join(OUTSIDE_BASE, 'harbor-demo-phone')), path.join(OUTSIDE_BASE, 'harbor-demo-phone'));
  for (const bad of [
    path.join(OUTSIDE_BASE, 'demo-phone'),
    path.join(OUTSIDE_BASE, 'nested', 'harbor-demo-phone'),
    path.join(os.tmpdir(), 'harbor-demo-phone'),
    path.join(os.homedir(), 'harbor-demo-phone'),
  ]) assert.throws(() => ownedRoot(bad), /capture root must be a harbor-\* directory/, bad);
});

test('a capture child sees the same outside base as its parent, whatever its own home', () => {
  const root = path.join(OUTSIDE_BASE, 'harbor-root-test');
  const fs = require('node:fs');
  try {
    const env = captureEnv(root, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot });
    assert.equal(env.CAPTURE_OUTSIDE_BASE, OUTSIDE_BASE);
    assert.equal(env.HOME, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(OUTSIDE_BASE); } catch { /* not empty, or never made */ }
  }
});
