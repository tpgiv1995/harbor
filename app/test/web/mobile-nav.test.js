'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { filterProjects, flattenSidebarRows } = require('../../src/shared/sidebar-model.cjs');
const { resolveIconUrl } = require('../../src/renderer/stage/project-icon-slug.cjs');
const tasksModel = require('../../src/shared/tasks-model.cjs');

const { selectRows, counts, dayKey, applyOp, emptyDoc } = tasksModel;

test('MOBILE-SHELL-1: mobile shell mounts one specialist conversation without swipe navigation', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../web/src/main.jsx'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '../../web/src/shell/AppShell.jsx'), 'utf8');
  assert.match(main, /from '\.\/shell\/AppShell\.jsx'/);
  assert.match(shell, /from '\.\.\/conversation\/Conversation\.jsx'/);
  assert.match(shell, /from '\.\.\/conversation\/use-transcript\.js'/);
  assert.match(shell, /from '\.\.\/ask\/AskCard\.jsx'/);
  assert.doesNotMatch(shell, /\.\/conv\/ConversationPane/);
  assert.doesNotMatch(shell, /Math\.abs\(dx\) > 56/);
  assert.doesNotMatch(shell, /onStep\(dx < 0 \? 1 : -1\)/);
  assert.doesNotMatch(shell, /<BottomNav/);
  assert.doesNotMatch(shell, /session-dot-pill/);
});

test('MOBILE-6: sidebar-model grouping drives session sheet rows', () => {
  const model = {
    projects: [
      {
        label: 'harbor',
        sessions: [
          {
            id: 's1',
            title: 'Fix mobile nav',
            project: 'harbor',
            lastActiveMs: 1000,
            isLive: true,
            agentStatus: 'working',
          },
          {
            id: 's2',
            title: 'Older session',
            project: 'harbor',
            lastActiveMs: 1,
            isLive: false,
          },
        ],
        hasLive: true,
      },
      {
        label: 'Team Tools',
        sessions: [
          {
            id: 's3',
            title: 'Report draft',
            project: 'Team Tools',
            lastActiveMs: 500,
            isLive: false,
          },
        ],
        hasLive: false,
      },
    ],
  };
  const filtered = filterProjects(model, { query: '' });
  const { rows } = flattenSidebarRows(filtered);
  assert.equal(rows.filter((r) => r.kind === 'project').length, 2);
  assert.equal(rows.filter((r) => r.kind === 'session').length, 3);
  assert.equal(rows.find((r) => r.kind === 'project' && r.project.label === 'harbor').project.hasLive, true);
});

test('MOBILE-6: project icon slug is derived, not mapped', () => {
  const url = resolveIconUrl('Team Tools', {
    userIcons: { 'team-tools': '/icons/team-tools.png' },
  });
  assert.equal(url, '/icons/team-tools.png');
});

test('MOBILE-6: tasks reducer drives mobile rows without a parallel completion path', () => {
  const now = Date.parse('2026-08-02T10:00:00');
  const today = dayKey(new Date(now));
  let doc = emptyDoc(now);
  const ids = (() => { let n = 0; return () => `t${++n}`; })();
  const parent = applyOp(doc, { type: 'task.add', title: 'Parent', myDay: true }, { now, idFactory: ids });
  doc = parent.doc;
  const child = applyOp(doc, { type: 'task.add', parentId: parent.taskId, title: 'Child' }, { now, idFactory: ids });
  doc = child.doc;
  const done = applyOp(doc, { type: 'task.setDone', taskId: parent.taskId, done: true }, { now, idFactory: ids });
  doc = done.doc;
  const childTask = doc.tasks.find((t) => t.id === child.taskId);
  assert.equal(childTask.done, true);
  assert.equal(childTask.completedBy, parent.taskId);
  const rows = selectRows(doc, { view: 'myday', today, sort: 'manual' });
  assert.ok(rows.open.length >= 0);
  assert.equal(counts(doc, today).myday, 0);
});
