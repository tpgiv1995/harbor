'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {
  assertDaemonCompat,
  parseSecondInstanceArgs,
  archiveBinary,
  EXPECTED_PROTOCOL,
  EXPECTED_SCHEMA_VERSION,
} = require('../../src/main/lifecycle.js');

// --- assertDaemonCompat ----------------------------------------------------

function makeClient({ protocol = EXPECTED_PROTOCOL } = {}) {
  return {
    ping: async () => ({ ok: true }),
    snapshot: async () => ({ snapshot: { protocol } }),
  };
}

test('assertDaemonCompat: matching protocol and schema -> ok', async () => {
  const client = makeClient({ protocol: 16 });
  const result = await assertDaemonCompat(client, {
    expectedProtocol: 16,
    expectedSchemaVersion: 1,
    schemaPath: path.resolve(__dirname, '../../../docs/herdr-api.schema.json'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 16);
  assert.equal(result.schemaVersion, 1);
});

test('assertDaemonCompat: protocol mismatch -> ok false with error', async () => {
  const client = makeClient({ protocol: 99 });
  const result = await assertDaemonCompat(client, {
    expectedProtocol: 16,
    expectedSchemaVersion: 1,
    schemaPath: path.resolve(__dirname, '../../../docs/herdr-api.schema.json'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /protocol_mismatch/);
  assert.equal(result.protocol, 99);
});

test('assertDaemonCompat: null protocol -> ok false', async () => {
  const client = {
    ping: async () => ({ ok: true }),
    snapshot: async () => ({ snapshot: {} }),
  };
  const result = await assertDaemonCompat(client, {
    expectedProtocol: 16,
    expectedSchemaVersion: 1,
    schemaPath: path.resolve(__dirname, '../../../docs/herdr-api.schema.json'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /protocol_mismatch/);
});

test('assertDaemonCompat: schema_version mismatch -> ok false', async () => {
  const client = makeClient({ protocol: 16 });
  const result = await assertDaemonCompat(client, {
    expectedProtocol: 16,
    expectedSchemaVersion: 99,
    schemaPath: path.resolve(__dirname, '../../../docs/herdr-api.schema.json'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /schema_version_mismatch/);
});

test('assertDaemonCompat: missing schema file -> schema_version_mismatch', async () => {
  const client = makeClient({ protocol: 16 });
  const result = await assertDaemonCompat(client, {
    expectedProtocol: 16,
    expectedSchemaVersion: 1,
    schemaPath: '/nonexistent/herdr-api.schema.json',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /schema_version_mismatch/);
});

// --- parseSecondInstanceArgs -----------------------------------------------

test('parseSecondInstanceArgs: empty argv -> focus', () => {
  const result = parseSecondInstanceArgs(['/path/electron', '/path/app']);
  assert.deepEqual(result, { action: 'focus', noFocusSteal: false });
});

test('parseSecondInstanceArgs: --focus flag -> focus', () => {
  const result = parseSecondInstanceArgs(['/path/electron', '/path/app', '--focus']);
  assert.deepEqual(result, { action: 'focus', noFocusSteal: false });
});

test('parseSecondInstanceArgs: --new-session --home team --cwd /foo -> new-session team', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--home', 'team', '--cwd', '/foo/bar'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.home, 'team');
  assert.equal(result.cwd, '/foo/bar');
});

test('parseSecondInstanceArgs: --new-session --home personal --cwd /baz -> new-session personal', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--home', 'personal', '--cwd', '/baz'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.home, 'personal');
  assert.equal(result.cwd, '/baz');
});

test('parseSecondInstanceArgs: --new-session without --home defers the profile default to config', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--cwd', '/some/dir'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.home, null);
  assert.equal(result.cwd, '/some/dir');
});

test('parseSecondInstanceArgs: --new-session without --cwd defaults to homedir', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--home', 'team'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.cwd, os.homedir());
});

// --- archiveBinary ---------------------------------------------------------

test('archiveBinary: skipped when dest already exists', async () => {
  const tmpSrc = path.join(os.tmpdir(), 'herdr-lifecycle-test-src');
  const tmpDest = path.join(os.tmpdir(), 'herdr-lifecycle-test-dest');
  const fs = require('node:fs/promises');
  await fs.writeFile(tmpSrc, 'src');
  await fs.writeFile(tmpDest, 'existing');
  const result = await archiveBinary(tmpSrc, tmpDest);
  assert.equal(result.skipped, true);
  assert.equal(result.dest, tmpDest);
  // dest still has old content
  const content = await fs.readFile(tmpDest, 'utf8');
  assert.equal(content, 'existing');
  await fs.rm(tmpSrc, { force: true });
  await fs.rm(tmpDest, { force: true });
});

test('archiveBinary: copies when dest absent', async () => {
  const tmpSrc = path.join(os.tmpdir(), 'herdr-lifecycle-copy-src');
  const tmpDest = path.join(os.tmpdir(), 'herdr-lifecycle-copy-dest');
  const fs = require('node:fs/promises');
  await fs.writeFile(tmpSrc, 'binary-content');
  await fs.rm(tmpDest, { force: true });
  const result = await archiveBinary(tmpSrc, tmpDest);
  assert.equal(result.skipped, false);
  assert.equal(result.dest, tmpDest);
  const content = await fs.readFile(tmpDest, 'utf8');
  assert.equal(content, 'binary-content');
  await fs.rm(tmpSrc, { force: true });
  await fs.rm(tmpDest, { force: true });
});
