'use strict';

// shared/project-label.cjs exists because two labellers for one directory split
// that directory into two rail groups (2026-08-05, sessiond adapter vs the
// history index). It then spent months with no test of its own while
// main/index.js and server/compose.js each kept a hand-copied version anyway,
// and compose.js never passed one to its sidebar bridge at all, so on the phone
// a codex session in demo/site landed under `site` while the claude sessions in
// the same folder sat under `demo/site`. Both callers delegate here now, and
// this pins the rule so the next copy has something to fail against.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { projectLabelForCwd } = require('../../src/shared/project-label.cjs');

const HOME = '/home/user';

test('a cwd under ~/dev is named by its path below dev', () => {
  assert.equal(projectLabelForCwd(path.join(HOME, 'dev', 'harbor'), HOME), 'harbor');
  assert.equal(projectLabelForCwd(path.join(HOME, 'dev', 'work', 'harbor'), HOME), 'work/harbor');
  assert.equal(projectLabelForCwd(path.join(HOME, 'dev'), HOME), 'dev');
});

test('a cwd elsewhere under home keeps its last two segments, and home itself is ~', () => {
  assert.equal(projectLabelForCwd(path.join(HOME, 'demo', 'site'), HOME), 'demo/site');
  assert.equal(projectLabelForCwd(path.join(HOME, 'notes'), HOME), 'notes');
  assert.equal(projectLabelForCwd(HOME, HOME), '~');
});

test('a cwd outside home keeps its last two segments', () => {
  assert.equal(projectLabelForCwd('/dev/shm/harbor-demo/demo/harbor', HOME), 'demo/harbor');
  assert.equal(projectLabelForCwd('/srv/build', HOME), 'srv/build');
});

// The branch neither hand-copied version had, which is the whole reason a
// divergent copy is a bug rather than a duplication.
test('a Windows path is labelled as one, whatever the home is', () => {
  assert.equal(projectLabelForCwd('C:\\Users\\dev\\harbor', HOME), 'win: dev/harbor');
  assert.equal(projectLabelForCwd('D:\\harbor', HOME), 'win: harbor');
});

test('an absent cwd is null rather than a guess', () => {
  assert.equal(projectLabelForCwd('', HOME), null);
  assert.equal(projectLabelForCwd(null, HOME), null);
});

// THE INVARIANT, stated as itself: the two production callers must answer
// identically for the same directory, because a disagreement is the incident.
test('the desktop and the server labellers agree, because both are this one', () => {
  const indexSource = require('node:fs').readFileSync(require.resolve('../../src/main/index.js'), 'utf8');
  const composeSource = require('node:fs').readFileSync(require.resolve('../../src/server/compose.js'), 'utf8');
  for (const [name, source] of [['main/index.js', indexSource], ['server/compose.js', composeSource]]) {
    assert.match(source, /shared\/project-label\.cjs/, `${name} no longer delegates to the shared rule`);
    assert.doesNotMatch(
      source,
      /function projectLabelForCwd\(cwd\)\s*\{\s*\n\s*if \(!cwd\) return null;/,
      `${name} has grown its own copy of the rule again`,
    );
  }
});
