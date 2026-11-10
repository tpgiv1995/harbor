'use strict';

// The config-load forensic log lives in the user's real ~/.cache/harbor. Every
// config spec used to append to it (97% of a real 44k-line log was test noise,
// including every "discovery default fired" alarm), so both writers now stay
// silent under the Node test runner. Two-sided on purpose: the SAME script run
// in a child without NODE_TEST_CONTEXT must write the log into its fake home,
// and with NODE_TEST_CONTEXT must leave that home untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { realTmpDir } = require('../support/real-tmpdir.js');

const STORE = path.join(__dirname, '../../src/main/config/store.js');
const CAPABILITIES = path.join(__dirname, '../../src/main/providers/capabilities.js');

function runInFakeHome(t, testContext) {
  const root = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-config-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, '{"profiles":[]}\n');
  const script = `
    (async () => {
      const store = require(${JSON.stringify(STORE)}).createConfigStore({ file: ${JSON.stringify(file)} });
      await store.load();
      require(${JSON.stringify(CAPABILITIES)}).newSessionOptions(undefined, {});
    })().catch((error) => { console.error(error); process.exit(1); });`;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  if (testContext) env.NODE_TEST_CONTEXT = 'child';
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const log = path.join(home, '.cache', 'harbor', 'config-load.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null;
}

test('outside the test runner both config-load writers record into the home they are given', (t) => {
  const log = runInFakeHome(t, false);
  assert.ok(log, 'the forensic log must still be written by a real boot');
  // The fixture config is deliberately minimal (it loads as corrupt-defaults);
  // which branch answered does not matter here, only that a load line exists.
  assert.match(log, /"branch":"(?!newSessionOptions)/);
  assert.match(log, /newSessionOptions-DISCOVERY-DEFAULT/);
});

test('under the Node test runner neither config-load writer touches the home', (t) => {
  assert.equal(runInFakeHome(t, true), null);
});
