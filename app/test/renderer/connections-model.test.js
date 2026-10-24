'use strict';

// The Connections panel's pure rules (2026-10-24): which /mcp opens the panel,
// how a status and a running sign-in read on a row, and the header counts.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/renderer/stage/connections-model.cjs');

test('only a bare /mcp opens the panel; the inline actions still go to the session', () => {
  for (const text of ['/mcp', ' /mcp ', '/MCP', '/mcp\n']) assert.equal(model.isBareMcpCommand(text), true, text);
  for (const text of ['/mcp reconnect graph', '/mcp enable claude.ai Meetings', '/mcpx', 'run /mcp', '', null]) assert.equal(model.isBareMcpCommand(text), false, String(text));
});

test('every status the provider reports has a label and a tone; anything else reads Unknown', () => {
  for (const status of ['connected', 'needs-auth', 'failed', 'connecting', 'disabled', 'pending-approval', 'rejected']) {
    const view = model.statusView({ status });
    assert.ok(view.label && view.label !== 'Unknown', status);
    assert.ok(['ok', 'warn', 'err', 'pending', 'off'].includes(view.tone), status);
  }
  assert.equal(model.statusView({ status: 'something new' }).label, 'Unknown');
  assert.equal(model.statusView({ status: 'needs-auth', statusText: '! Needs authentication' }).title, '! Needs authentication', 'the CLI wording is the hover text');
});

test('a sign-in job reads busy until it ends, and offers the page again only while waiting', () => {
  const waiting = model.jobView({ phase: 'waiting', url: 'https://auth.example.com/a', message: 'm' });
  assert.equal(waiting.busy, true);
  assert.equal(waiting.url, 'https://auth.example.com/a');
  assert.equal(waiting.cancellable, true);
  const claudeai = model.jobView({ phase: 'verifying', kind: 'claudeai', url: 'https://claude.ai/x' });
  assert.equal(claudeai.label, 'Waiting for claude.ai to confirm');
  assert.equal(claudeai.url, 'https://claude.ai/x');
  const oauth = model.jobView({ phase: 'verifying', kind: 'oauth', url: 'https://auth.example.com/a' });
  assert.equal(oauth.url, null, 'an OAuth sign-in that came back has no page to reopen');
  assert.equal(model.jobView({ phase: 'reconnecting' }).busy, true);
  const done = model.jobView({ phase: 'done', message: 'ok', live: { ok: true } });
  assert.deepEqual([done.busy, done.tone], [false, 'ok']);
  assert.equal(model.jobView({ phase: 'done', live: { ok: false } }).tone, 'warn', 'signed in but the session did not reconnect');
  const failed = model.jobView({ phase: 'failed', message: 'access_denied' });
  assert.deepEqual([failed.busy, failed.tone, failed.retry, failed.message], [false, 'err', true, 'access_denied']);
  assert.equal(model.jobView({ phase: 'cancelled' }).retry, true);
  assert.equal(model.jobView(null), null);
});

test('the newest job per server for this home wins, and an update replaces its job', () => {
  const jobs = [
    { id: 'a', name: 'graph', home: 'H1', startedAt: 1, phase: 'failed' },
    { id: 'b', name: 'graph', home: 'H1', startedAt: 2, phase: 'waiting' },
    { id: 'c', name: 'graph', home: 'H2', startedAt: 3, phase: 'done' },
  ];
  assert.equal(model.latestJobs(jobs, 'H1').get('graph').id, 'b');
  assert.equal(model.latestJobs(jobs, 'H2').get('graph').id, 'c', 'another plan\'s job never shows on this one');
  const merged = model.mergeJob(jobs, { id: 'b', name: 'graph', home: 'H1', startedAt: 2, phase: 'done' });
  assert.equal(merged.length, 3);
  assert.equal(merged.find((j) => j.id === 'b').phase, 'done');
});

test('the footer counts servers, sign-ins needed and failures', () => {
  const groups = [{ servers: [{ status: 'connected' }, { status: 'needs-auth' }] }, { servers: [{ status: 'needs-auth' }, { status: 'failed' }] }];
  assert.equal(model.summary(groups), '4 servers · 2 need sign-in · 1 failed');
  assert.equal(model.summary([{ servers: [{ status: 'needs-auth' }] }]), '1 server · 1 needs sign-in');
  assert.equal(model.summary([]), '0 servers');
});

test('an action result reads as one line; a claude.ai sign-out points at claude.ai', () => {
  assert.deepEqual(model.actionNote('reconnect', { ok: true, message: 'Successfully reconnected to graph' }), { tone: 'ok', text: 'Successfully reconnected to graph' });
  assert.equal(model.actionNote('disable', { ok: false }).text, 'Disable: failed');
  const out = model.actionNote('sign-out', { ok: true, manageUrl: 'https://claude.ai/settings/connectors' });
  assert.equal(out.url, 'https://claude.ai/settings/connectors');
  assert.equal(model.actionNote('reconnect', null), null);
});
