'use strict';

// The packaged app's commit stamp (scripts/after-pack.js). The version string
// alone cannot tell two builds apart, so the stamp is the only cheap way to
// know which commit an installed app was built from. Proven against real
// throwaway git repos, not a mocked git.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { gitBuildInfo } = require('../../scripts/after-pack.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-stamp-'));
  const git = (...args) => cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'stamp');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  return { dir, git };
}

test('a clean checkout stamps its short commit and branch', () => {
  const { dir, git } = repo();
  try {
    assert.deepEqual(gitBuildInfo(dir), { commit: git('rev-parse', '--short', 'HEAD'), branch: 'stamp' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uncommitted tracked changes mark the stamp -dirty; untracked files do not', () => {
  const { dir, git } = repo();
  try {
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x');
    assert.ok(!gitBuildInfo(dir).commit.endsWith('-dirty'));
    git('add', 'untracked.txt');
    assert.equal(gitBuildInfo(dir).commit, `${git('rev-parse', '--short', 'HEAD')}-dirty`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('outside a git checkout the stamp degrades to unknown instead of failing the build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-nogit-'));
  try {
    assert.deepEqual(gitBuildInfo(dir), { commit: 'unknown', branch: 'unknown' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
