'use strict';

// Sub-projects group under their main parent project (Pat, 2026-10-06): the
// phone's new-session list and side panel showed every sub-folder a session
// ever ran in as a project of its own. See src/shared/project-root.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  projectRoots, groupFolderCandidates, mergeSubprojects, ORCHESTRATION_GROUP,
} = require('../../src/shared/project-root.cjs');
const { isOrchestrationCwd } = require('../../src/shared/sidebar-model.cjs');

const rootOf = (folders, folder) => projectRoots(folders).get(folder).root;

test('a folder under a dev root belongs to its dev project, at any depth', () => {
  const folders = ['C:\\dev\\harbor\\app', 'C:\\dev\\harbor', 'C:\\dev\\Proposal Kit\\build\\video\\_naming'];
  assert.equal(rootOf(folders, 'C:\\dev\\harbor\\app'), 'C:\\dev\\harbor');
  // The parent need not be a known folder itself.
  assert.equal(rootOf(folders, 'C:\\dev\\Proposal Kit\\build\\video\\_naming'), 'C:\\dev\\Proposal Kit');
  assert.equal(rootOf(['/home/pat/dev/site/web'], '/home/pat/dev/site/web'), '/home/pat/dev/site');
  assert.equal(rootOf(['C:\\Users\\pat\\dev\\tool\\src'], 'C:\\Users\\pat\\dev\\tool\\src'), 'C:\\Users\\pat\\dev\\tool');
});

test('posix /dev is the device tree, never a project root', () => {
  assert.equal(rootOf(['/dev/shm/x'], '/dev/shm/x'), '/dev/shm/x');
});

test('elsewhere the shortest known ancestor is the parent', () => {
  const nav = 'C:\\Users\\pat\\Box\\Reports\\Quarterly';
  const reports = 'C:\\Users\\pat\\Box\\Reports';
  assert.equal(rootOf([nav, reports], nav), reports);
  assert.equal(rootOf([nav], nav), nav, 'with no known ancestor a folder is its own parent');
});

test('containers never swallow the projects beneath them', () => {
  const home = 'C:\\Users\\pat';
  const deep = 'C:\\Users\\pat\\Documents\\Wiki';
  const folders = ['C:\\', home, 'C:\\dev', deep, 'C:\\dev\\harbor', '/Users/pat', '/Users/pat/notes/a'];
  assert.equal(rootOf(folders, deep), deep, 'the home directory is not a project');
  assert.equal(rootOf(folders, 'C:\\dev\\harbor'), 'C:\\dev\\harbor', 'the dev root is not a project');
  assert.equal(rootOf(folders, home), home);
  assert.equal(rootOf(folders, 'C:\\'), 'C:\\');
  assert.equal(rootOf(folders, '/Users/pat/notes/a'), '/Users/pat/notes/a');
});

test('two spellings of one Windows folder are one project', () => {
  const groups = groupFolderCandidates(['C:\\dev\\Linux Conversion', 'c:\\dev\\Linux Conversion']);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].folder, 'C:\\dev\\Linux Conversion');
  assert.deepEqual(groups[0].children, []);
});

const PAT_LIKE = [
  'C:\\dev\\harbor\\app',
  'C:\\dev\\sheet-bot',
  'C:\\dev\\.orch\\g4-core',
  'C:\\dev\\harbor',
  'C:\\dev\\misc-ad-hoc\\tiles',
  'C:\\dev\\claims-mapper',
  'C:\\dev\\misc-ad-hoc\\planner',
  'C:\\dev\\.orch\\b2-flow\\sheet-bot',
  'C:\\dev\\Proposal Kit\\build\\video\\_naming',
  'C:\\dev\\misc-ad-hoc\\.orch\\h1-home-board-rank',
];

test('the new-session list groups by parent, in recency order', () => {
  const groups = groupFolderCandidates(PAT_LIKE, { isOrchestration: isOrchestrationCwd });
  assert.deepEqual(groups.map((group) => group.label), [
    'dev/harbor', 'dev/sheet-bot', ORCHESTRATION_GROUP, 'dev/misc-ad-hoc', 'dev/claims-mapper', 'video/_naming',
  ]);
  const harbor = groups[0];
  assert.equal(harbor.folder, 'C:\\dev\\harbor', 'a parent a session ran in is selectable');
  assert.deepEqual(harbor.children, [{ folder: 'C:\\dev\\harbor\\app', label: 'app' }]);
  const misc = groups.find((group) => group.label === 'dev/misc-ad-hoc');
  assert.equal(misc.folder, null, 'a parent nobody worked in only opens its folders');
  assert.deepEqual(misc.children.map((child) => child.label), ['tiles', 'planner']);
  const orch = groups.find((group) => group.label === ORCHESTRATION_GROUP);
  assert.equal(orch.total, 3, 'orchestration workers from every project share one group, as in the side panel');
  // A lone folder under a parent nobody worked in is offered as itself, never
  // under a parent name that would launch somewhere else.
  const proposal = groups.find((group) => group.label === 'video/_naming');
  assert.equal(proposal.folder, 'C:\\dev\\Proposal Kit\\build\\video\\_naming');
  assert.equal(groups.every((group) => group.open === false), true, 'nothing opens on its own without a search');
});

test('a search shows matching parents whole, and opens a group only for matching children', () => {
  const byLabel = (groups) => Object.fromEntries(groups.map((group) => [group.label, group]));
  let groups = byLabel(groupFolderCandidates(PAT_LIKE, { query: 'harbor', isOrchestration: isOrchestrationCwd }));
  assert.deepEqual(Object.keys(groups), ['dev/harbor']);
  assert.equal(groups['dev/harbor'].open, false);
  assert.equal(groups['dev/harbor'].children.length, 1);

  groups = byLabel(groupFolderCandidates(PAT_LIKE, { query: 'tile', isOrchestration: isOrchestrationCwd }));
  assert.deepEqual(Object.keys(groups), ['dev/misc-ad-hoc']);
  assert.equal(groups['dev/misc-ad-hoc'].open, true, 'a child match must be visible without another tap');
  assert.deepEqual(groups['dev/misc-ad-hoc'].children.map((child) => child.label), ['tiles']);
  assert.equal(groups['dev/misc-ad-hoc'].total, 2);

  // Every word must match somewhere, and a backslash path matches with slashes.
  groups = byLabel(groupFolderCandidates(PAT_LIKE, { query: 'harbor app', isOrchestration: isOrchestrationCwd }));
  assert.deepEqual(Object.keys(groups), ['dev/harbor']);
  assert.equal(groups['dev/harbor'].open, true);
  groups = byLabel(groupFolderCandidates(PAT_LIKE, { query: 'dev/claims', isOrchestration: isOrchestrationCwd }));
  assert.deepEqual(Object.keys(groups), ['dev/claims-mapper']);

  assert.deepEqual(groupFolderCandidates(PAT_LIKE, { query: 'nothing-like-this' }), []);
});

const session = (id, project, cwd, lastActiveMs, extra = {}) => ({ id, project, cwd, lastActiveMs, ...extra });
const project = (label, sessions, extra = {}) => ({ label, sessions, sessionCount: sessions.length, lastActiveMs: sessions[0].lastActiveMs, hasLive: sessions.some((s) => s.isLive), ...extra });

test('the side panel folds sub-projects into their parent and names each sub-folder', () => {
  const harbor = project('harbor', [session('h1', 'harbor', 'C:\\dev\\harbor', 50)]);
  const app = project('harbor/app', [session('a1', 'harbor/app', 'C:\\dev\\harbor\\app', 90, { isLive: true })]);
  const studio = project('studio/studio-personal', [session('t1', 'studio/studio-personal', 'C:\\dev\\studio\\studio-personal', 70)]);
  const orch = project('Orchestration', [session('o1', '.orch/x', 'C:\\dev\\.orch\\x', 80)], { isOrchestration: true });
  const era = project('win: old/thing', [session('w1', 'win: old/thing', 'D:\\old\\thing', 60)], { isWindowsEra: true });
  const all = [harbor, app, studio, orch, era].flatMap((p) => p.sessions);

  const merged = mergeSubprojects([app, orch, studio, era, harbor], all);
  assert.deepEqual(merged.map((p) => p.label), ['harbor', 'Orchestration', 'studio', 'win: old/thing']);
  const h = merged[0];
  assert.deepEqual(h.sessions.map((s) => s.id), ['a1', 'h1'], 'newest first across the merged group');
  assert.equal(h.sessions[0].subproject, 'app');
  assert.equal(h.sessions[1].subproject, undefined, 'the parent\'s own sessions carry no tag');
  assert.equal(h.sessionCount, 2);
  assert.equal(h.hasLive, true);
  assert.equal(h.lastActiveMs, 90);
  // A parent with no session of its own still gathers its sub-projects, named
  // by its dev project.
  assert.equal(merged[2].sessions[0].subproject, 'studio-personal');
  // Groups that are not folders keep their own shape.
  assert.equal(merged[1], orch);
  assert.equal(merged[3], era);
});

test('a parent the time filter hid still names its sub-projects', () => {
  const survey = session('s1', 'Shared/Reports', 'C:\\Users\\pat\\Box\\Shared\\Reports', 10);
  const nav = project('Reports/Quarterly', [session('n1', 'Reports/Quarterly', 'C:\\Users\\pat\\Box\\Shared\\Reports\\Quarterly', 99)]);
  const merged = mergeSubprojects([nav], [survey, ...nav.sessions]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, 'Shared/Reports');
  assert.equal(merged[0].sessions[0].subproject, 'Quarterly', 'the tag is the folder below the parent');
});
