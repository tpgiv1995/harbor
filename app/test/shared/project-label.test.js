'use strict';

// shared/project-label.cjs exists because two labellers for one directory split
// that directory into two rail groups (2026-08-05, sessiond adapter vs the
// history index). It then spent months with no test of its own while
// main/index.js and server/compose.js each kept a hand-copied version anyway,
// and compose.js never passed one to its sidebar bridge at all, so on the phone
// a codex session in demo/site landed under `site` while the claude sessions in
// the same folder sat under `demo/site`. Both callers delegate here now, and
// this pins the rule so the next copy has something to fail against.
//
// Platform is EXPLICIT in every spec. The rule is host-keyed since 2026-08-12
// (native paths get the friendly rules, the OTHER OS's paths get an era
// prefix), and a spec that inherits the runner's platform describes the CI box
// rather than the code: the original posix specs built their paths with
// path.join, so on a Windows runner they quietly asserted the win32 branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { projectLabelForCwd } = require('../../src/shared/project-label.cjs');

const HOME = '/home/user';
const WHOME = 'C:\\Users\\user';

test('linux host: a cwd under ~/dev is named by its path below dev', () => {
  assert.equal(projectLabelForCwd(`${HOME}/dev/harbor`, HOME, 'linux'), 'harbor');
  assert.equal(projectLabelForCwd(`${HOME}/dev/work/harbor`, HOME, 'linux'), 'work/harbor');
  assert.equal(projectLabelForCwd(`${HOME}/dev`, HOME, 'linux'), 'dev');
});

test('linux host: a cwd elsewhere under home keeps its last two segments, and home itself is ~', () => {
  assert.equal(projectLabelForCwd(`${HOME}/demo/site`, HOME, 'linux'), 'demo/site');
  assert.equal(projectLabelForCwd(`${HOME}/notes`, HOME, 'linux'), 'notes');
  assert.equal(projectLabelForCwd(HOME, HOME, 'linux'), '~');
});

test('linux host: a cwd outside home keeps its last two segments', () => {
  assert.equal(projectLabelForCwd('/dev/shm/harbor-demo/demo/harbor', HOME, 'linux'), 'demo/harbor');
  assert.equal(projectLabelForCwd('/srv/build', HOME, 'linux'), 'srv/build');
});

// The era rule, both directions. A Windows path seen from Linux is the old
// machine's history; a POSIX path seen from Windows is the Linux install's
// history. The same path flips category when the host does, which is the
// whole 2026-08-12 incident: the unconditional `win: ` branch, written when
// the host was Linux, branded every CURRENT project on the Windows install
// and isWindowsEra disabled all of them.
test('linux host: a Windows path is era-labelled, whatever the home is', () => {
  assert.equal(projectLabelForCwd('C:\\Users\\dev\\harbor', HOME, 'linux'), 'win: dev/harbor');
  assert.equal(projectLabelForCwd('D:\\harbor', HOME, 'linux'), 'win: harbor');
});

test('windows host: a native path gets the friendly rules, never the era prefix', () => {
  assert.equal(projectLabelForCwd('C:\\dev\\harbor', WHOME, 'win32'), 'harbor');
  assert.equal(projectLabelForCwd('C:\\dev\\work\\harbor', WHOME, 'win32'), 'work/harbor');
  assert.equal(projectLabelForCwd('C:\\dev', WHOME, 'win32'), 'dev');
  assert.equal(projectLabelForCwd(WHOME, WHOME, 'win32'), '~');
  assert.equal(projectLabelForCwd('C:\\Users\\user\\dev\\thing', WHOME, 'win32'), 'thing');
  assert.equal(projectLabelForCwd('C:\\Users\\user\\demo\\site', WHOME, 'win32'), 'demo/site');
  assert.equal(projectLabelForCwd('C:\\Users\\user\\notes', WHOME, 'win32'), 'notes');
  assert.equal(projectLabelForCwd('C:\\Program Files\\Nimbalyst', WHOME, 'win32'), 'Program Files/Nimbalyst');
});

test('windows host: NTFS is case-insensitive, so the home comparison is too', () => {
  assert.equal(projectLabelForCwd('c:\\users\\USER', WHOME, 'win32'), '~');
  assert.equal(projectLabelForCwd('c:\\USERS\\user\\demo\\site', WHOME, 'win32'), 'demo/site');
});

// Two-sided ON PURPOSE. A drive root must NAME ITS DRIVE (the old '?' merged
// every drive into one rail group, because the rail groups by label), and a
// path with no drive to name must still refuse to invent one.
test('windows host: a bare drive root is named for its drive, and drives stay apart', () => {
  assert.equal(projectLabelForCwd('C:\\', WHOME, 'win32'), 'C:');
  assert.equal(projectLabelForCwd('C:', WHOME, 'win32'), 'C:');
  assert.equal(projectLabelForCwd('c:\\', WHOME, 'win32'), 'C:');
  assert.equal(projectLabelForCwd('D:\\', WHOME, 'win32'), 'D:');
  assert.notEqual(
    projectLabelForCwd('C:\\', WHOME, 'win32'),
    projectLabelForCwd('D:\\', WHOME, 'win32'),
    'two drive roots sharing a label merge their sessions into one rail group',
  );
});

test('windows host: a rootless path with no drive to name keeps ?', () => {
  assert.equal(projectLabelForCwd('\\\\', WHOME, 'win32'), '?');
});

test('windows host: a POSIX path is the Linux era', () => {
  assert.equal(projectLabelForCwd('/home/user/dev/harbor', WHOME, 'win32'), 'linux: dev/harbor');
  assert.equal(projectLabelForCwd('/srv/build', WHOME, 'win32'), 'linux: srv/build');
});

test('an absent cwd is null rather than a guess', () => {
  assert.equal(projectLabelForCwd('', HOME, 'linux'), null);
  assert.equal(projectLabelForCwd(null, HOME, 'linux'), null);
});

// THE INVARIANT, stated as itself: every production caller must answer
// identically for the same directory, because a disagreement is the incident.
// history-index.js joined the list on 2026-08-12, when its own hand-copy (the
// third) was deleted in the era-rule change instead of being edited in step a
// third time.
test('the desktop, server and history labellers agree, because all are this one', () => {
  const sources = [
    ['main/index.js', fs.readFileSync(require.resolve('../../src/main/index.js'), 'utf8')],
    ['server/compose.js', fs.readFileSync(require.resolve('../../src/server/compose.js'), 'utf8')],
    ['main/providers/history-index.js', fs.readFileSync(require.resolve('../../src/main/providers/history-index.js'), 'utf8')],
  ];
  for (const [name, source] of sources) {
    assert.match(source, /shared\/project-label\.cjs/, `${name} no longer delegates to the shared rule`);
    assert.doesNotMatch(
      source,
      /win: \$\{parts/,
      `${name} has grown its own copy of the era rule again`,
    );
  }
});
