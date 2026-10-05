'use strict';

// Documentation-accuracy fixes with no code behavior of their own to
// exercise, so the proof is a content check on the files themselves, the
// same static-assertion style this repo already uses for export.html and
// board-export-runner.cjs (test/providers/board-export.test.js).
//
// token and upload files are written with `mode: 0o600`
// (transport/auth.js, upload.js). NTFS has no POSIX permission bits, so that
// mode is silently a no-op on Windows; the real protection there is the ACL
// the file inherits from the user's own profile directory. docs/SECURITY-MOBILE.md
// and setup/mobile.md used to state the mode alone, which reads as a real
// guarantee on the platform this app actually ships for.
//
// crash minidumps contain process memory (secrets, tokens, transcript
// content can all be resident in it) and none of the public-facing docs said
// so. This checks that a plain warning now exists in each of the places a
// contributor or reporter would be filling in a bug/security report.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('docs/SECURITY-MOBILE.md explains the 0600 mode does nothing on Windows and names the real protection', () => {
  const doc = read('docs/SECURITY-MOBILE.md');
  assert.match(doc, /mode `0600`/, 'the doc should still say what mode the file is created with');
  assert.match(doc, /NTFS has no POSIX permission bits/i, 'the doc must say plainly that NTFS ignores the mode');
  assert.match(doc, /ACL/, 'the doc must name the ACL as the real Windows protection');
  assert.match(doc, /profile directory/i, "the doc must say the ACL is inherited from the user's profile directory");
});

test('setup/mobile.md carries the same correction, not just docs/SECURITY-MOBILE.md', () => {
  const doc = read('setup/mobile.md');
  assert.match(doc, /mode `0600`/, 'the doc should still say what mode the file is created with');
  assert.match(doc, /no-op/i, 'setup/mobile.md must say the mode is a no-op on Windows');
  assert.match(doc, /ACL/, 'setup/mobile.md must name the ACL as the real Windows protection');
});

test('the bug report template warns against attaching a crash dump', () => {
  const template = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.match(template, /crash dump/i);
  assert.match(template, /\.dmp/, 'name the actual file extension a reporter would be tempted to attach');
  assert.match(template, /process memory/i, 'say WHY: it is a memory snapshot, not a log');
});

test('CONTRIBUTING.md warns against attaching a crash dump to a public issue or PR', () => {
  const doc = read('CONTRIBUTING.md');
  assert.match(doc, /crash dump/i);
  assert.match(doc, /\.dmp/);
  assert.match(doc, /process memory/i);
});

test('SECURITY.md warns against a crash dump in both the public request and the private report', () => {
  const doc = read('SECURITY.md');
  assert.match(doc, /crash dump/i);
  assert.match(doc, /\.dmp/);
  // Two-sided within the doc itself: the PUBLIC minimal issue must refuse it
  // outright, and the PRIVATE report must still be told to scrub or avoid it
  // rather than treating "private" as a license to paste raw memory around.
  const publicSection = doc.slice(doc.indexOf('If no private reporting'), doc.indexOf('A private report should include'));
  const privateSection = doc.slice(doc.indexOf('A private report should include'));
  assert.match(publicSection, /crash dump/i, 'the public request paragraph must refuse a crash dump');
  assert.match(privateSection, /crash dump/i, 'the private report paragraph must still caution about a crash dump');
});
