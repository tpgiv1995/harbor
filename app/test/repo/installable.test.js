'use strict';

// A FRESH CLONE MUST BE ABLE TO OPEN A SESSION, and this exists because it could
// not (2026-08-06).
//
// The daemon runs under the SYSTEM Node rather than Electron, so its runtime
// dependencies are declared in `src/daemon/package.json`, not the app's. Nothing
// installed them except `pack:daemon-deps`, which only `pack` and the three
// `dist:*` scripts ever invoked. The README tells a reader to run `npm install`
// and then `npm start`, and that path never touched them: `keeper.js` reached
// `require('node-pty')` and died with a bare MODULE_NOT_FOUND into the daemon
// log, so every session silently failed to start on a machine that had followed
// the documented instructions exactly.
//
// The gate is deliberately about the REAL CONDITION (can the module be resolved
// from the directory that requires it) and not about the shape of the fix. A
// test that only asserted "package.json has a postinstall" would have passed on
// a machine where the postinstall silently failed, which is the same class of
// mistake as the bug: proving the plumbing exists rather than proving water
// comes out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '../..');
const DAEMON = path.join(APP, 'src', 'daemon');

function daemonManifest() {
  return JSON.parse(fs.readFileSync(path.join(DAEMON, 'package.json'), 'utf8'));
}

// Bare specifiers only: a relative path needs no declaration, and `node:` is
// built in. Matches both `require('x')` and `require("x")`.
function bareRequires(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = new Set();
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    // A scoped package is `@scope/name`; anything deeper is a subpath import of
    // the same package, so credit the package itself.
    const parts = spec.split('/');
    found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return found;
}

test('every third-party module the daemon requires is declared as a daemon dependency', () => {
  const declared = new Set(Object.keys(daemonManifest().dependencies || {}));
  const undeclared = [];

  for (const entry of fs.readdirSync(DAEMON)) {
    if (!entry.endsWith('.js')) continue;
    for (const spec of bareRequires(path.join(DAEMON, entry))) {
      if (!declared.has(spec)) undeclared.push(`src/daemon/${entry} requires ${spec}`);
    }
  }

  assert.deepEqual(undeclared, [], 'daemon code requires modules that src/daemon/package.json does not declare:\n  '
    + undeclared.join('\n  '));
});

test('every declared daemon dependency actually resolves from src/daemon', () => {
  // THE bug. On a tree where `npm install` ran at the app level and nothing
  // installed the daemon's own dependencies, this is the assertion that fails,
  // and it fails naming the module and the command that fixes it.
  const declared = Object.keys(daemonManifest().dependencies || {});
  assert.ok(declared.length > 0, 'src/daemon/package.json declares no dependencies; that is itself suspicious');

  const missing = [];
  for (const spec of declared) {
    try {
      require.resolve(spec, { paths: [DAEMON] });
    } catch {
      missing.push(spec);
    }
  }

  assert.deepEqual(missing, [], 'the daemon cannot spawn a pty because these declared modules are not installed: '
    + `${missing.join(', ')}. Run \`npm install\` from ${APP} (its postinstall installs them), `
    + 'or `npm run pack:daemon-deps` for just those.');
});

test('a plain `npm install` installs the daemon dependencies', () => {
  // The mechanism that makes the assertion above true for somebody who only ever
  // read the README. Keep it wired to the same script the dist targets use, so
  // there is one installer and not two that can drift.
  const scripts = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).scripts || {};
  assert.ok(scripts.postinstall, 'app/package.json has no postinstall, so `npm install` leaves the daemon without node-pty');
  assert.match(
    scripts.postinstall,
    /pack:daemon-deps/,
    'postinstall must run pack:daemon-deps so the daemon install has exactly one implementation',
  );
});

test('the keeper reports a missing pty module honestly instead of throwing MODULE_NOT_FOUND', () => {
  // A bare require would surface in the daemon log as a stack trace naming an
  // internal loader path, which is what made this bug read as "sessions do not
  // start" rather than "a dependency is missing".
  const text = fs.readFileSync(path.join(DAEMON, 'keeper.js'), 'utf8');
  assert.match(text, /MODULE_NOT_FOUND/, 'keeper.js does not distinguish a missing node-pty from any other load failure');
  assert.match(text, /npm run pack:daemon-deps|npm install/, 'the missing-node-pty error does not name the command that fixes it');
});
