'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLoginPath, parseShellPath, mergePaths, MARK } = require('../../src/main/login-path.js');

const BARE = '/usr/bin:/bin:/usr/sbin:/sbin';

test('a Finder launch adopts the login shell PATH, ignoring rc-file noise', () => {
  const exec = () => `welcome banner\n${MARK}/opt/homebrew/bin:/usr/bin:/bin${MARK}`;
  const r = resolveLoginPath({ env: { PATH: BARE, SHELL: '/bin/zsh' }, platform: 'darwin', exec });
  assert.equal(r.path.split(':')[0], '/opt/homebrew/bin');
  assert.ok(r.path.split(':').includes('/usr/sbin'), 'keeps the inherited dirs');
  assert.match(r.source, /login shell/);
});

test('a terminal launch that already has Homebrew is left alone and never runs a shell', () => {
  const r = resolveLoginPath({ env: { PATH: `/opt/homebrew/bin:${BARE}` }, platform: 'darwin', exec: () => { throw new Error('must not run'); } });
  assert.equal(r.path, `/opt/homebrew/bin:${BARE}`);
});

test('a shell that fails or prints no PATH falls back to the Homebrew dirs', () => {
  for (const exec of [() => { throw new Error('timeout'); }, () => 'no sentinel here']) {
    const r = resolveLoginPath({ env: { PATH: BARE }, platform: 'darwin', exec });
    assert.ok(r.path.split(':').includes('/opt/homebrew/bin'));
    assert.equal(r.source, 'fallback dirs');
  }
});

test('other platforms are untouched', () => {
  assert.equal(resolveLoginPath({ env: { PATH: BARE }, platform: 'linux', exec: () => { throw new Error('no'); } }).path, BARE);
});

test('parse and merge helpers', () => {
  assert.equal(parseShellPath(`x${MARK}/a:/b${MARK}y`), '/a:/b');
  assert.equal(parseShellPath(`${MARK}${MARK}`), null);
  assert.equal(mergePaths('/a:/b', '/b:/c', ''), '/a:/b:/c');
});
