'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('url');

const APP_ROOT = path.join(__dirname, '../..');
const WEB_ROOT = path.join(APP_ROOT, 'web');
const REPO_ROOT = path.join(APP_ROOT, '..');
// Captured by app/scripts/verify-browser.js against a real Harbor instance and
// read back by the two source-level tests below, neither of which drives a
// browser itself. Resolved RELATIVE TO THE REPO, never from the home directory:
// a checkout lives wherever its owner put it, and `~/dev/harbor` is just a
// different hardcoded guess wearing a portable-looking function call.
const FIXTURES_DIR = process.env.HARBOR_MOBILE_FIXTURES_DIR
  || path.join(REPO_ROOT, '.harbor-mobile-fixtures');
const REAL_SIDEBAR_FIXTURE = path.join(FIXTURES_DIR, 'sidebar-get-state.json');

// The capture is gitignored and machine-local, so a fresh clone does not have
// one. That is a SKIP, not a failure: a test that cannot pass on a clean clone
// of a public repo is a broken test, not a finding about the clone.
const NO_FIXTURE = fs.existsSync(REAL_SIDEBAR_FIXTURE)
  ? false
  : `no local capture at ${path.relative(REPO_ROOT, REAL_SIDEBAR_FIXTURE)}; run scripts/verify-browser.js to record one`;

async function loadRows() {
  return import(pathToFileURL(path.join(WEB_ROOT, 'src/browse/rows.js')).href);
}

function readRealSidebarFixture() {
  const payload = JSON.parse(fs.readFileSync(REAL_SIDEBAR_FIXTURE, 'utf8'));
  assert.ok(payload?.model?.projects?.length, 'real sidebar fixture must include grouped projects');
  return payload;
}

test('MOBILE-OVERHAUL-3: real sidebar fixture matches flattenSidebarRows shape', { skip: NO_FIXTURE }, () => {
  const payload = readRealSidebarFixture();
  const sample = payload.model.projects[0].sessions[0];
  assert.ok(sample.id, 'session rows must carry id');
  assert.ok(sample.title !== undefined, 'session rows must carry title');
  assert.ok(sample.lastActiveMs, 'session rows must carry lastActiveMs');
  assert.ok('agentStatus' in sample, 'session rows must carry agentStatus');
  assert.ok('isLive' in sample, 'session rows must carry isLive');
});

test('MOBILE-OVERHAUL-3: needs-answer sessions sort above idle and working ones', async () => {
  const {
    buildBrowserRows,
    compareSessionsForBrowser,
    needsAnswer,
  } = await loadRows();

  const idle = {
    id: 'idle-1',
    title: 'Idle session',
    project: 'harbor',
    lastActiveMs: 5000,
    agentStatus: 'idle',
    isLive: true,
  };
  const working = {
    id: 'work-1',
    title: 'Working session',
    project: 'harbor',
    lastActiveMs: 9000,
    agentStatus: 'working',
    isLive: true,
  };
  const blocked = {
    id: 'block-1',
    title: 'Blocked session',
    project: 'Team Tools',
    lastActiveMs: 1,
    agentStatus: 'blocked',
    isLive: true,
  };

  assert.ok(compareSessionsForBrowser(blocked, idle) < 0);
  assert.ok(compareSessionsForBrowser(blocked, working) < 0);
  assert.ok(compareSessionsForBrowser(working, idle) < 0);

  const model = {
    projects: [
      {
        label: 'harbor',
        sessions: [idle, working],
        hasLive: true,
      },
      {
        label: 'Team Tools',
        sessions: [blocked],
        hasLive: true,
      },
    ],
  };

  const rows = buildBrowserRows(model, { iconUrl: () => null });
  const sessionRows = rows.filter((row) => row.kind === 'session');
  assert.equal(sessionRows[0].session.id, 'block-1');
  assert.ok(needsAnswer(sessionRows[0].session));
  assert.equal(rows[0].kind, 'answer-section');
  assert.equal(rows[1].session.id, 'block-1');
});

test('MOBILE-OVERHAUL-3: filterBrowserRows keeps matching sessions and drops non-matches', async () => {
  const { filterBrowserRows } = await loadRows();
  const rows = [
    {
      kind: 'project',
      key: 'project:harbor',
      project: { label: 'harbor', sessions: [] },
    },
    {
      kind: 'session',
      key: 'session:a',
      project: { label: 'harbor' },
      session: { id: 'a', title: 'Mobile nav polish', project: 'harbor' },
    },
    {
      kind: 'session',
      key: 'session:b',
      project: { label: 'harbor' },
      session: { id: 'b', title: 'Unrelated topic', project: 'harbor' },
    },
  ];

  const filtered = filterBrowserRows(rows, 'mobile');
  const titles = filtered
    .filter((row) => row.kind === 'session')
    .map((row) => row.session.title);
  assert.deepEqual(titles, ['Mobile nav polish']);

  const unchanged = filterBrowserRows(rows, '');
  assert.equal(unchanged.length, rows.length);
});

test('MOBILE-OVERHAUL-3: buildBrowserRows handles the captured real sidebar payload', { skip: NO_FIXTURE }, async () => {
  const { buildBrowserRows } = await loadRows();
  const payload = readRealSidebarFixture();
  const rows = buildBrowserRows(payload.model, { iconUrl: () => '/icon.png' });
  assert.ok(rows.some((row) => row.kind === 'project'));
  assert.ok(rows.filter((row) => row.kind === 'session').length > 10);
  const projectHeaders = rows.filter((row) => row.kind === 'project');
  for (const header of projectHeaders) {
    assert.ok(header.project.label, 'project header must carry label');
    assert.equal(header.iconUrl, '/icon.png');
  }
});
