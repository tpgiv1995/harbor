'use strict';

// Connections (the native /mcp surface, 2026-10-24): every fact comes from the
// Claude CLI run for the session's own config home and folder, and a sign-in
// reaches the RUNNING session through the CLI's inline `/mcp reconnect`. The
// CLI is stubbed here; scripts/drive-mcp-signin-win.js drives the real one.
// Fixture shapes are the real 2.1.303 output with every name replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const mcp = require('../../src/main/providers/mcp-connections.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'mcp');
const LIST = fs.readFileSync(path.join(FIX, 'mcp-list-2.1.303.txt'), 'utf8');
const GET_OK = fs.readFileSync(path.join(FIX, 'mcp-get-connected-2.1.303.txt'), 'utf8');
const GET_AUTH = fs.readFileSync(path.join(FIX, 'mcp-get-needs-auth-2.1.303.txt'), 'utf8');

test('the list parses every server line with its status, and skips the banner', () => {
  const servers = mcp.parseMcpList(LIST);
  assert.equal(servers.length, 11);
  const by = Object.fromEntries(servers.map((s) => [s.name, s]));
  assert.equal(by['claude.ai Meetings'].status, 'needs-auth');
  assert.equal(by['claude.ai Meetings'].kind, 'claudeai');
  assert.equal(by['plugin:deploy-skills:deploy'].kind, 'plugin', 'a plugin name keeps its colons');
  assert.equal(by['plugin:deploy-skills:deploy'].transport, 'http');
  assert.equal(by['sandbox-api'].target, 'https://mcp.example.com/mcp');
  assert.equal(by.graph.transport, 'stdio');
  assert.equal(by.graph.status, 'connected', 'a command line holding " -- " is not the status separator');
  assert.equal(by.browser.status, 'failed');
  assert.equal(by['team-wiki'].transport, 'sse');
  assert.equal(by['local-notes'].status, 'disabled');
  assert.equal(by['repo-tools'].status, 'pending-approval');
});

test('mcp get reads the one status line', () => {
  assert.deepEqual(mcp.parseMcpGet(GET_OK), { status: 'connected', statusText: 'Connected' });
  assert.equal(mcp.parseMcpGet(GET_AUTH).status, 'needs-auth');
  assert.equal(mcp.parseMcpGet('No MCP server named "x".'), null);
});

test('servers group the way the CLI panel groups them', () => {
  const servers = mcp.parseMcpList(LIST);
  const groups = mcp.groupServers(servers, {
    userFile: 'C:\\home\\.claude\\.claude.json',
    user: new Set(['sandbox-api', 'graph', 'browser']),
    local: new Set(['local-notes']),
    project: new Set(['repo-tools', 'team-wiki']),
  });
  assert.deepEqual(groups.map((g) => g.key), ['local', 'project', 'user', 'claudeai', 'builtin']);
  assert.equal(groups.find((g) => g.key === 'user').label, 'User MCPs (C:\\home\\.claude\\.claude.json)');
  assert.equal(groups.find((g) => g.key === 'builtin').label, 'Built-in MCPs (always available)');
  assert.equal(groups.find((g) => g.key === 'claudeai').servers.length, 4);
});

test('the scopes come from the config files by name, for the cwd in either slash spelling', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mcp-scope-'));
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'sandbox-api': { url: 'secret-ish' } },
    projects: { [cwd.replace(/\\/g, '/')]: { mcpServers: { 'local-notes': {} } } },
  }));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'repo-tools': {} } }));
  const scopes = await mcp.readScopes(home, cwd);
  assert.deepEqual([...scopes.user], ['sandbox-api']);
  assert.deepEqual([...scopes.local], ['local-notes']);
  assert.deepEqual([...scopes.project], ['repo-tools']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('each row offers only what its status and the running session allow', () => {
  const [meetings] = mcp.parseMcpList('claude.ai Meetings: https://x.example/mcp - ! Needs authentication');
  assert.deepEqual(mcp.serverActions(meetings, { live: true }), ['sign-in', 'disable']);
  assert.deepEqual(mcp.serverActions(meetings, { live: false }), ['sign-in'], 'no running session, no inline actions');
  const [stdio] = mcp.parseMcpList('graph: node graph.js - ✔ Connected');
  assert.deepEqual(mcp.serverActions(stdio, { live: true }), ['reconnect', 'disable'], 'a command server has nothing to sign in to');
  const [off] = mcp.parseMcpList('local-notes: node notes.js - ⊘ Disabled for this project (re-enable via /mcp)');
  assert.deepEqual(mcp.serverActions(off, { live: true }), ['enable']);
  const [http] = mcp.parseMcpList('sandbox-api: https://x.example/mcp (HTTP) - ✔ Connected');
  assert.deepEqual(mcp.serverActions(http, { live: false }), ['sign-out']);
});

// The transcript records an inline /mcp action exactly like this (2.1.303,
// measured in a live session): the command, then its stdout.
const commandRecord = (args, at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: `<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args>${args}</command-args>` } });
const stdoutRecord = (text, at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } });

test('the action result is the stdout that follows THIS command, written after it was sent', () => {
  const t = Date.parse('2026-10-24T08:00:00Z');
  const jsonl = [
    commandRecord('reconnect graph', t - 60000), stdoutRecord('Successfully reconnected to graph', t - 59000),
    commandRecord('reconnect claude.ai Meetings', t + 1000), stdoutRecord('Successfully reconnected to claude.ai Meetings', t + 3000),
  ].join('\n');
  assert.equal(mcp.findActionResult(jsonl, { args: 'reconnect graph', since: t }), null, 'an older run of the same kind is not this one');
  assert.equal(mcp.findActionResult(jsonl, { args: 'reconnect claude.ai Meetings', since: t }), 'Successfully reconnected to claude.ai Meetings');
});

test('the measured result lines classify honestly', () => {
  assert.deepEqual(mcp.classifyActionResult('reconnect', 'Successfully reconnected to graph'), { ok: true, outcome: 'reconnected' });
  assert.equal(mcp.classifyActionResult('reconnect', 'claude.ai Meetings requires authentication. Use /mcp to authenticate.').outcome, 'needs-auth');
  assert.equal(mcp.classifyActionResult('reconnect', 'MCP server "nope" not found').outcome, 'not-found');
  assert.equal(mcp.classifyActionResult('disable', 'MCP server "graph" disabled').ok, true);
  assert.equal(mcp.classifyActionResult('enable', 'MCP server "graph" enabled').ok, true);
});

// ---- the flows, with the CLI, the login helper and the session stubbed ----

function rig({ getAnswers = [GET_OK], loginScript = 'oauth-ok', sendOk = true, result = 'Successfully reconnected to team-wiki', live = true } = {}) {
  const calls = { cli: [], opened: [], sent: [], updates: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mcp-flow-'));
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, '');
  let gets = 0;
  const runLogin = () => {
    const events = new EventEmitter();
    events.cancel = () => setImmediate(() => events.emit('exit', { code: null, cancelled: true }));
    setImmediate(() => {
      if (loginScript === 'fails') { events.emit('exit', { code: 1, output: 'Starting authentication…\nCouldn\'t complete authentication for "team-wiki": invalid_grant' }); return; }
      events.emit('url', 'https://auth.example.com/authorize?x=1');
      if (loginScript === 'hangs') return;
      setImmediate(() => events.emit('exit', { code: 0, output: 'Authenticated with "team-wiki". Its tools are now available in Claude Code.' }));
    });
    return events;
  };
  const conn = mcp.createMcpConnections({
    resolveContext: async () => ({ home: 'C:\\home\\.claude', cwd: dir, account: 'personal' }),
    claudeBin: async () => 'claude.exe',
    runClaude: async ({ args }) => {
      calls.cli.push(args.join(' '));
      if (args[1] === 'list') return { code: 0, stdout: LIST, stderr: '' };
      if (args[1] === 'get') { const out = getAnswers[Math.min(gets, getAnswers.length - 1)]; gets += 1; return { code: 0, stdout: out, stderr: '' }; }
      if (args[1] === 'logout') return args[2].startsWith('claude.ai ')
        ? { code: 0, stdout: `"${args[2]}" is a claude.ai connector — its credentials live on claude.ai, not this machine. Disconnect it at https://claude.ai/settings/connectors\n`, stderr: '' }
        : { code: 0, stdout: `Logged out of "${args[2]}".\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    runLogin,
    openExternal: (url) => calls.opened.push(url),
    sendCommand: async ({ text }) => {
      calls.sent.push(text);
      if (!sendOk) return { ok: false, reason: 'asking a question in its window' };
      const args = text.replace(/^\/mcp /, '');
      const at = Date.now();
      setTimeout(() => fs.appendFileSync(transcript, `${commandRecord(args, at)}\n${stdoutRecord(result.replace('team-wiki', args.split(' ').slice(1).join(' ')), at + 5)}\n`), 20);
      return { ok: true };
    },
    transcriptPathFor: async () => transcript,
    onUpdate: (job) => calls.updates.push(job),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    verifyPollMs: 1,
    resultPollMs: 5,
    resultTimeoutMs: 2000,
    verifyTimeoutMs: 500,
  });
  const pane = live ? { paneId: 'p1', workspaceId: 'w1' } : null;
  const finished = () => new Promise((resolve) => {
    const tick = () => {
      const last = calls.updates.at(-1);
      if (last && ['done', 'failed', 'cancelled'].includes(last.phase)) resolve(last); else setTimeout(tick, 5);
    };
    tick();
  });
  return { conn, calls, pane, finished, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('list runs `claude mcp list` for the session and returns groups with actions', async () => {
  const { conn, calls, pane, cleanup } = rig();
  const res = await conn.list({ sessionId: 's1', pane });
  assert.deepEqual(calls.cli, ['mcp list']);
  assert.equal(res.home, 'C:\\home\\.claude');
  assert.equal(res.live, true);
  const meetings = res.groups.flatMap((g) => g.servers).find((s) => s.name === 'claude.ai Meetings');
  assert.deepEqual(meetings.actions, ['sign-in', 'disable']);
  cleanup();
});

test('sign-in on an OAuth server: the address opens in the browser, the CLI confirms, the running session reconnects', async () => {
  const { conn, calls, pane, finished, cleanup } = rig();
  const started = await conn.signIn({ sessionId: 's1', pane, name: 'team-wiki' });
  assert.equal(started.ok, true);
  const job = await finished();
  assert.deepEqual(calls.opened, ['https://auth.example.com/authorize?x=1']);
  assert.deepEqual(calls.updates.map((u) => u.phase).filter((p, i, a) => p !== a[i - 1]), ['starting', 'waiting', 'verifying', 'reconnecting', 'done']);
  assert.deepEqual(calls.cli, ['mcp get team-wiki']);
  assert.deepEqual(calls.sent, ['/mcp reconnect team-wiki']);
  assert.equal(job.live.outcome, 'reconnected');
  assert.match(job.message, /reconnected with the new tools/);
  cleanup();
});

test('sign-in on a claude.ai connector polls the CLI until it reads connected', async () => {
  const { conn, calls, pane, finished, cleanup } = rig({ getAnswers: [GET_AUTH, GET_AUTH, GET_OK] });
  await conn.signIn({ sessionId: 's1', pane, name: 'claude.ai Meetings' });
  const job = await finished();
  assert.equal(job.phase, 'done');
  assert.equal(calls.cli.filter((c) => c === 'mcp get claude.ai Meetings').length, 3);
  assert.deepEqual(calls.sent, ['/mcp reconnect claude.ai Meetings']);
  cleanup();
});

test('a claude.ai sign-in never finished on claude.ai ends as failed and says what to do', async () => {
  const { conn, calls, pane, finished, cleanup } = rig({ getAnswers: [GET_AUTH] });
  await conn.signIn({ sessionId: 's1', pane, name: 'claude.ai Meetings' });
  const job = await finished();
  assert.equal(job.phase, 'failed');
  assert.match(job.message, /Needs authentication/);
  assert.match(job.message, /Check again/);
  assert.deepEqual(calls.sent, [], 'nothing is sent to the session for a sign-in that did not happen');
  cleanup();
});

test('a failed CLI sign-in reports the CLI\'s own last line', async () => {
  const { conn, pane, finished, cleanup } = rig({ loginScript: 'fails' });
  await conn.signIn({ sessionId: 's1', pane, name: 'team-wiki' });
  const job = await finished();
  assert.equal(job.phase, 'failed');
  assert.match(job.message, /invalid_grant/);
  cleanup();
});

test('a sign-in can be cancelled while it waits for the browser', async () => {
  const { conn, calls, pane, finished, cleanup } = rig({ loginScript: 'hangs' });
  const { jobId } = await conn.signIn({ sessionId: 's1', pane, name: 'team-wiki' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(conn.cancel({ jobId }).ok, true);
  const job = await finished();
  assert.equal(job.phase, 'cancelled');
  assert.deepEqual(calls.sent, []);
  cleanup();
});

test('with no running session the sign-in still completes and says the session has nothing to reconnect', async () => {
  const { conn, calls, finished, cleanup } = rig({ live: false });
  await conn.signIn({ sessionId: 's1', pane: null, name: 'team-wiki' });
  const job = await finished();
  assert.equal(job.phase, 'done');
  assert.deepEqual(calls.sent, []);
  assert.match(job.message, /no running session/);
  cleanup();
});

test('a reconnect the session refuses is reported, not assumed', async () => {
  const { conn, pane, cleanup } = rig({ sendOk: false });
  const res = await conn.act({ sessionId: 's1', pane, name: 'graph', action: 'reconnect' });
  assert.deepEqual([res.ok, res.outcome], [false, 'not-sent']);
  assert.match(res.message, /asking a question/);
  cleanup();
});

test('sign-out of a claude.ai connector hands back the CLI\'s page to disconnect it on', async () => {
  const { conn, calls, pane, cleanup } = rig();
  const res = await conn.signOut({ sessionId: 's1', pane, name: 'claude.ai Meetings' });
  assert.equal(res.manageUrl, 'https://claude.ai/settings/connectors');
  assert.deepEqual(calls.sent, [], 'nothing changed on this machine, so nothing to reconnect');
  cleanup();
});

test('sign-out of an OAuth server runs the CLI logout and reconnects the session', async () => {
  const { conn, calls, pane, cleanup } = rig({ result: 'team-wiki requires authentication. Use /mcp to authenticate.' });
  const res = await conn.signOut({ sessionId: 's1', pane, name: 'team-wiki' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.cli, ['mcp logout team-wiki']);
  assert.deepEqual(calls.sent, ['/mcp reconnect team-wiki']);
  assert.equal(res.live.outcome, 'needs-auth');
  cleanup();
});

test('a harness profile refuses to run the real CLI', async () => {
  const conn = mcp.createMcpConnections({
    resolveContext: async () => ({ home: 'C:\\home\\.claude', cwd: 'C:\\x' }),
    claudeBin: async () => 'claude.exe',
    allowRun: () => ({ allowed: false, reason: 'refusing to run the real Claude CLI from an isolated profile' }),
    runClaude: async () => { throw new Error('must not run'); },
  });
  await assert.rejects(conn.list({ sessionId: 's1' }), /isolated profile/);
});
