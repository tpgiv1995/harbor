'use strict';

// TEAM.json resolution in main/providers/team.js: a member may name its
// session through a file the team already keeps current. Invented names only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readDeclaration } = require('../../src/main/providers/team.js');

const ROOT = path.resolve('/work/lighthouse');

test('session_file names the member\'s session; a handover is a change to that file', async () => {
  const files = { [path.resolve(ROOT, 'docs/orchestration/run/LEAD.txt')]: 'harbor-7 [abc123] (session 77777777-7777-4777-8777-777777777777, home north) is the lead.\nIt replaces 88888888-8888-4888-8888-888888888888.' };
  const seen = [];
  const parsed = { title: 'Release team', everyone_else_reports_to: 'lead', members: [
    { name: 'chief', session: '99999999-9999-4999-8999-999999999999', top: true },
    { name: 'lead', session_file: 'docs/orchestration/run/LEAD.txt', reports_to: 'chief' },
    { name: 'gone', session_file: 'docs/orchestration/run/MISSING.txt' },
  ] };
  const declaration = await readDeclaration(parsed, { file: 'TEAM.json', root: ROOT, readFile: async (target) => { if (!(target in files)) throw new Error('ENOENT'); return files[target]; }, onSessionFile: (target) => seen.push(target) });
  assert.equal(declaration.everyoneElse, 'lead');
  assert.equal(declaration.members[1].session, '77777777-7777-4777-8777-777777777777', 'the FIRST session id in the file, not the one it replaces');
  assert.equal(declaration.members[0].top, true);
  assert.equal(declaration.members[2].session, undefined, 'a missing file leaves the member unmatched, so it reads as declared but absent');
  assert.equal(seen.length, 2, 'both named files are watched for changes');
});
