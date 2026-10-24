'use strict';

// CONNECTIONS: Harbor's own surface for Claude Code's /mcp (2026-10-24, Pat,
// after a claude.ai connector showed "needs authentication" and /mcp left him
// at a raw-screen panel whose cursor he could not see: "this probably applies
// to a lot of the like settings and config options that you can do in the
// claude code cli so please review and provide a better interface").
//
// Every fact comes from the CLI itself, run for the SESSION'S config home and
// folder, never from a scraped screen:
//   * the list and each status: `claude mcp list` (it health-checks every
//     server; claude.ai connectors are included only when
//     ENABLE_CLAUDEAI_MCP_SERVERS is not "false", which worker environments
//     set, so the child env drops it);
//   * a sign-in: `claude mcp login --no-browser <server>` through
//     bin/harbor-mcp-login (a pty, because the CLI refuses an OAuth sign-in
//     with a piped stdin); the address it prints opens in the default browser
//     through Harbor's guarded opener. For an HTTP/SSE server the CLI waits for
//     the browser and exits 0 when signed in. For a claude.ai connector it only
//     prints the claude.ai address and exits, so the sign-in is confirmed by
//     polling `claude mcp get <server>` until it reads Connected;
//   * sign-out: `claude mcp logout <server>` (a claude.ai connector's
//     credentials live on claude.ai; the CLI answers with the page to disconnect
//     it, which the panel offers);
//   * the RUNNING session: Claude Code 2.1.303 has inline actions,
//     `/mcp reconnect|enable|disable <server>` (read out of the binary, measured
//     in a live session), which run without opening the CLI's panel and write
//     their result to the transcript as <local-command-stdout>. A sign-in only
//     reaches a running session through a reconnect, so every successful
//     sign-in or sign-out is followed by one, and its result is read back from
//     the transcript.
// Which group a server belongs to (User, Local, Project, claude.ai, built-in)
// is read from the same config files the CLI reads, by name only.

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

// `claude mcp list` status words (2.1.303: "✔ Connected", "! Needs
// authentication", "✗ Failed to connect", "⏸ Pending approval (...)", "✗
// Rejected (...)", "⊘ Disabled for this project (...)"). First match wins.
const STATUS_RULES = [
  ['needs-auth', /needs authentication|needs sign-in/i],
  ['pending-approval', /pending approval/i],
  ['rejected', /rejected/i],
  ['disabled', /disabled/i],
  ['failed', /failed|not connected|error/i],
  ['connecting', /connecting/i],
  ['connected', /connected/i],
];

function classifyStatus(text) {
  const t = stripAnsi(text);
  for (const [status, re] of STATUS_RULES) if (re.test(t)) return status;
  return 'unknown';
}

function serverKind(name) {
  if (/^claude\.ai /.test(name)) return 'claudeai';
  if (/^plugin:/.test(name)) return 'plugin';
  return 'config';
}

// One server per `<name>: <target> - <status>` line. A name never contains
// ": " (plugin servers carry bare colons, `plugin:netlify-skills:netlify`), and
// the status is after the LAST " - ".
function parseMcpList(stdout) {
  const servers = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = stripAnsi(raw).trimEnd();
    const sep = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (sep <= 0 || dash <= sep) continue;
    const name = line.slice(0, sep).trim();
    const target = line.slice(sep + 2, dash).trim();
    const statusText = line.slice(dash + 3).replace(/^[✔✓✗✘!⏸⊘◯○●•]\s*/u, '').trim();
    const status = classifyStatus(statusText);
    if (status === 'unknown' && !/[✔✓✗✘!⏸⊘]/u.test(line.slice(dash))) continue;
    const transport = /\((HTTP|SSE|WS)\)$/.exec(target)?.[1]?.toLowerCase()
      || (/^https?:\/\//.test(target) ? 'http' : 'stdio');
    servers.push({
      name,
      target: target.replace(/\s*\((?:HTTP|SSE|WS)\)$/, ''),
      transport,
      kind: serverKind(name),
      status,
      statusText,
    });
  }
  return servers;
}

// `claude mcp get <name>` prints "  Status: ✔ Connected".
function parseMcpGet(stdout) {
  const line = stripAnsi(stdout).split(/\r?\n/).find((l) => /^\s*Status:/.test(l));
  if (!line) return null;
  const statusText = line.replace(/^\s*Status:\s*/, '').replace(/^[✔✓✗✘!⏸⊘]\s*/u, '').trim();
  return { status: classifyStatus(statusText), statusText };
}

// Group the way the CLI's own /mcp panel does (2.1.303 draws "User MCPs (<the
// home's .claude.json>)", "claude.ai", and "Built-in MCPs (always available)"
// for plugin servers; project and local scopes get their own headings).
const GROUP_ORDER = ['local', 'project', 'user', 'claudeai', 'builtin', 'other'];
function groupServers(servers, scopes = {}) {
  const groups = new Map();
  const add = (key, label, server) => {
    if (!groups.has(key)) groups.set(key, { key, label, servers: [] });
    groups.get(key).servers.push(server);
  };
  for (const server of servers) {
    if (server.kind === 'claudeai') add('claudeai', 'claude.ai', server);
    else if (server.kind === 'plugin') add('builtin', 'Built-in MCPs (always available)', server);
    else if (scopes.local?.has(server.name)) add('local', 'Local MCPs (private to you in this folder)', server);
    else if (scopes.project?.has(server.name)) add('project', 'Project MCPs (.mcp.json)', server);
    else if (scopes.user?.has(server.name)) add('user', scopes.userFile ? `User MCPs (${scopes.userFile})` : 'User MCPs', server);
    else add('other', 'MCP servers', server);
  }
  return GROUP_ORDER.filter((key) => groups.has(key)).map((key) => groups.get(key));
}

// The config files the CLI reads for scopes, by server NAME only (values carry
// secrets and never leave this function).
async function readScopes(home, cwd, readFile = fs.readFile) {
  const json = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
  const userFile = path.join(home, '.claude.json');
  const claudeJson = await json(userFile);
  const keys = (o) => new Set(Object.keys((o && typeof o === 'object' && o) || {}));
  const projects = claudeJson?.projects || {};
  const cwdKeys = cwd ? [cwd, cwd.replace(/\\/g, '/'), cwd.replace(/\//g, '\\')] : [];
  const localEntry = cwdKeys.map((k) => projects[k]).find(Boolean);
  const projectJson = cwd ? await json(path.join(cwd, '.mcp.json')) : null;
  return {
    userFile,
    user: keys(claudeJson?.mcpServers),
    local: keys(localEntry?.mcpServers),
    project: keys(projectJson?.mcpServers),
  };
}

// What each row may offer, from its status and kind alone. `live` is whether
// the window's session is running (the inline actions need its REPL).
function serverActions(server, { live = false } = {}) {
  const remote = server.transport === 'http' || server.transport === 'sse' || server.kind === 'claudeai';
  const actions = [];
  if (remote && server.status === 'needs-auth') actions.push('sign-in');
  if (remote && server.status === 'connected') actions.push('sign-out');
  // Reconnect on a server that still needs a sign-in can only answer
  // "requires authentication", so that row offers Sign in instead.
  if (live && !['disabled', 'pending-approval', 'rejected', 'needs-auth'].includes(server.status)) actions.push('reconnect');
  if (live && server.status === 'disabled') actions.push('enable');
  if (live && server.status !== 'disabled' && server.status !== 'pending-approval' && server.status !== 'rejected') actions.push('disable');
  return actions;
}

// The inline action's result line in the transcript (wording measured on
// 2.1.303; the non-interactive strings in the same binary are accepted too).
function classifyActionResult(action, text) {
  const t = stripAnsi(text);
  if (/not found|There's no MCP server named/i.test(t)) return { ok: false, outcome: 'not-found' };
  if (action === 'reconnect') {
    if (/Successfully reconnected|^Reconnected /i.test(t)) return { ok: true, outcome: 'reconnected' };
    if (/requires authentication|needs authentication/i.test(t)) return { ok: false, outcome: 'needs-auth' };
    if (/already reconnecting/i.test(t)) return { ok: true, outcome: 'reconnecting' };
    return { ok: false, outcome: 'failed' };
  }
  if (action === 'enable') return /enabled/i.test(t) && !/couldn't|failed/i.test(t) ? { ok: true, outcome: 'enabled' } : { ok: false, outcome: 'failed' };
  if (action === 'disable') return /disabled/i.test(t) && !/couldn't|failed/i.test(t) ? { ok: true, outcome: 'disabled' } : { ok: false, outcome: 'failed' };
  return { ok: false, outcome: 'failed' };
}

// The newest inline /mcp result in a transcript tail, written after `since`.
function findActionResult(jsonlText, { args, since = 0 } = {}) {
  const lines = String(jsonlText || '').split('\n');
  let sawCommand = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'user') continue;
    const at = Date.parse(record.timestamp || '') || 0;
    if (at && at < since - 2000) continue;
    const content = record.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b?.text || '').join('') : '';
    if (/<command-name>\/mcp<\/command-name>/.test(text)) {
      const got = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
      sawCommand = got === args;
      continue;
    }
    const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
    if (out && sawCommand) return out[1].trim();
  }
  return null;
}

function defaultRunClaude({ claudeBin, args, home, cwd, timeoutMs = 90_000, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const script = /\.(?:c|m)?js$/i.test(claudeBin);
    const childEnv = { ...env, CLAUDE_CONFIG_DIR: home };
    for (const key of ['ENABLE_CLAUDEAI_MCP_SERVERS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete childEnv[key];
    if (script) childEnv.ELECTRON_RUN_AS_NODE = '1';
    else delete childEnv.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawnImpl(script ? process.execPath : claudeBin, script ? [claudeBin, ...args] : args, {
        cwd: cwd || undefined, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs} ms`, timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// bin/harbor-mcp-login as an event source: 'url', 'exit'. cancel() ends it.
function defaultRunLogin({ loginScript, claudeBin, home, cwd, name, timeoutMs = 10 * 60 * 1000, spawnImpl = spawn, env = process.env }) {
  const events = new EventEmitter();
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  let child;
  try {
    child = spawnImpl(process.execPath, [loginScript, '--claude', claudeBin, '--home', home, '--cwd', cwd || home, '--name', name, '--timeout-ms', String(timeoutMs)], {
      cwd: cwd || home, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    setImmediate(() => events.emit('exit', { code: null, output: error.message }));
    return Object.assign(events, { cancel() {} });
  }
  let buffer = '';
  let exited = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'url') events.emit('url', event.url);
      if (event.event === 'exit') { exited = true; events.emit('exit', event); }
    }
  });
  child.stderr.on('data', () => {});
  child.on('close', (code) => { if (!exited) events.emit('exit', { code: code ?? null, output: 'the sign-in helper ended without a result' }); });
  child.on('error', (error) => { if (!exited) { exited = true; events.emit('exit', { code: null, output: error.message }); } });
  return Object.assign(events, {
    cancel() { try { child.stdin.write('cancel\n'); } catch { /* gone */ } },
    redirect(url) { try { child.stdin.write(`redirect ${url}\n`); } catch { /* gone */ } },
  });
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMcpConnections(deps = {}) {
  const resolveContext = deps.resolveContext;
  if (typeof resolveContext !== 'function') throw new TypeError('mcp connections need resolveContext({ sessionId, cwd, home })');
  const claudeBin = deps.claudeBin || (async () => null);
  const runClaude = deps.runClaude || defaultRunClaude;
  const runLogin = deps.runLogin || defaultRunLogin;
  const loginScript = deps.loginScript || path.join(__dirname, '..', '..', '..', '..', 'bin', 'harbor-mcp-login');
  const openExternal = deps.openExternal || (() => {});
  const sendCommand = deps.sendCommand || (async () => ({ ok: false, reason: 'no session to send to' }));
  const transcriptPathFor = deps.transcriptPathFor || (async () => null);
  const readFile = deps.readFile || fs.readFile;
  const allowRun = deps.allowRun || (() => ({ allowed: true }));
  const sleep = deps.sleep || sleepMs;
  const now = deps.now || Date.now;
  const verifyPollMs = deps.verifyPollMs ?? 4000;
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? 5 * 60 * 1000;
  const resultTimeoutMs = deps.resultTimeoutMs ?? 60_000;
  const resultPollMs = deps.resultPollMs ?? 700;
  const onUpdate = deps.onUpdate || (() => {});
  const jobs = new Map();
  const cancels = new Map();

  const context = async (payload = {}) => {
    const ctx = await resolveContext(payload);
    if (!ctx?.home) throw new Error('This session has no Claude config home Harbor can name, so its connections cannot be read.');
    const bin = await claudeBin();
    if (!bin) throw new Error('The Claude CLI was not found on this machine.');
    const gate = allowRun({ claudeBin: bin });
    if (!gate?.allowed) throw new Error(gate?.reason || 'running the Claude CLI is refused here');
    return { ...ctx, claudeBin: bin };
  };

  const cli = (ctx, args, opts = {}) => runClaude({ claudeBin: ctx.claudeBin, args, home: ctx.home, cwd: ctx.cwd, ...opts });

  const list = async (payload = {}) => {
    const ctx = await context(payload);
    const res = await cli(ctx, ['mcp', 'list'], { timeoutMs: 120_000 });
    if (res.code !== 0 && !String(res.stdout).trim()) {
      throw new Error(stripAnsi(res.stderr || res.stdout).trim().split('\n').pop() || `claude mcp list exited ${res.code}`);
    }
    const servers = parseMcpList(res.stdout);
    const scopes = await readScopes(ctx.home, ctx.cwd, readFile).catch(() => ({}));
    const live = Boolean(payload.pane?.paneId);
    for (const server of servers) server.actions = serverActions(server, { live });
    return {
      home: ctx.home,
      account: ctx.account || null,
      cwd: ctx.cwd || null,
      live,
      checkedAt: now(),
      empty: servers.length === 0,
      note: servers.length === 0 ? stripAnsi(res.stdout).trim().split('\n').filter((l) => !/Checking MCP server health/.test(l)).join(' ').trim() || null : null,
      groups: groupServers(servers, scopes),
    };
  };

  const status = async (ctx, name) => {
    const res = await cli(ctx, ['mcp', 'get', name], { timeoutMs: 60_000 });
    return parseMcpGet(res.stdout) || { status: 'unknown', statusText: stripAnsi(res.stderr || res.stdout).trim().split('\n').pop() || 'no status' };
  };

  // Send an inline /mcp action into the running session and read its result
  // back from the session's transcript.
  const act = async (payload = {}) => {
    const { sessionId, pane, name, action } = payload;
    if (!['reconnect', 'enable', 'disable'].includes(action)) throw new Error(`unknown action: ${action}`);
    if (!name) throw new Error('which server?');
    if (!pane?.paneId) return { ok: false, outcome: 'not-live', message: 'This session is not running, so there is nothing to reconnect. It will load the change when it next starts.' };
    const args = `${action} ${name}`;
    const since = now();
    const sent = await sendCommand({ sessionId, pane, text: `/mcp ${args}` });
    if (!sent?.ok) return { ok: false, outcome: 'not-sent', message: sent?.reason || 'the session did not take the command' };
    const deadline = now() + resultTimeoutMs;
    while (now() < deadline) {
      const file = await transcriptPathFor(sessionId).catch(() => null);
      if (file) {
        let text = '';
        try {
          const handle = await fs.open(file, 'r');
          try {
            const { size } = await handle.stat();
            const start = Math.max(0, size - 256 * 1024);
            const buf = Buffer.alloc(size - start);
            await handle.read(buf, 0, buf.length, start);
            text = buf.toString('utf8');
          } finally { await handle.close(); }
        } catch { /* not yet written */ }
        const line = findActionResult(text, { args, since });
        if (line) return { ...classifyActionResult(action, line), message: line };
      }
      await sleep(resultPollMs);
    }
    return { ok: false, outcome: 'no-result', message: `Sent "/mcp ${args}" to the session; it has not answered yet (it may be busy with a turn).` };
  };

  const publish = (job) => { try { onUpdate({ ...job }); } catch { /* a listener fault is not a job fault */ } };

  const signIn = async (payload = {}) => {
    const { name } = payload;
    if (!name) throw new Error('which server?');
    const ctx = await context(payload);
    for (const job of jobs.values()) {
      if (job.name === name && job.home === ctx.home && !['done', 'failed', 'cancelled'].includes(job.phase)) return { ok: true, jobId: job.id, already: true };
    }
    const kind = serverKind(name);
    const job = { id: randomUUID(), name, kind, home: ctx.home, sessionId: payload.sessionId || null, phase: 'starting', url: null, message: null, startedAt: now() };
    jobs.set(job.id, job);
    publish(job);
    const runner = runLogin({ loginScript, claudeBin: ctx.claudeBin, home: ctx.home, cwd: ctx.cwd, name });
    cancels.set(job.id, () => runner.cancel?.());
    runner.on('url', (url) => {
      job.url = url;
      job.phase = 'waiting';
      job.message = kind === 'claudeai'
        ? 'Finish signing in on claude.ai in your browser. Harbor checks every few seconds.'
        : 'Finish signing in in your browser. Harbor is waiting for the sign-in to come back.';
      publish(job);
      openExternal(url);
    });
    runner.on('exit', async (result) => {
      if (job.phase === 'cancelled') return;
      if (result?.cancelled) { job.phase = 'cancelled'; job.message = 'Sign-in cancelled.'; publish(job); return; }
      const output = String(result?.output || '').trim();
      if (result?.code !== 0) {
        job.phase = 'failed';
        job.message = output.split('\n').filter(Boolean).pop() || (result?.timedOut ? 'The sign-in timed out.' : `claude mcp login exited ${result?.code}`);
        publish(job);
        return;
      }
      if (!job.url && kind === 'claudeai') {
        job.phase = 'failed';
        job.message = output.split('\n').filter(Boolean).pop() || 'The CLI gave no sign-in address.';
        publish(job);
        return;
      }
      job.phase = 'verifying';
      job.message = kind === 'claudeai' ? job.message : 'Signed in. Checking the connection…';
      publish(job);
      // A claude.ai connector is signed in on claude.ai, so its CLI exits at
      // once; poll until the CLI itself reads it as connected.
      const until = now() + (kind === 'claudeai' ? verifyTimeoutMs : 0);
      let state = await status(ctx, name);
      while (state.status !== 'connected' && now() < until && job.phase === 'verifying') {
        await sleep(verifyPollMs);
        state = await status(ctx, name);
      }
      if (job.phase !== 'verifying') return;
      if (state.status !== 'connected') {
        job.phase = 'failed';
        job.message = kind === 'claudeai'
          ? `Still "${state.statusText}" after ${Math.round(verifyTimeoutMs / 60000)} minutes. If you finished on claude.ai, press Check again.`
          : `The CLI signed in, but the server still reads "${state.statusText}".`;
        publish(job);
        return;
      }
      job.signedIn = true;
      if (payload.pane?.paneId) {
        job.phase = 'reconnecting';
        job.message = 'Signed in. Reconnecting the running session…';
        publish(job);
        const live = await act({ sessionId: payload.sessionId, pane: payload.pane, name, action: 'reconnect' });
        job.live = live;
        job.message = live.ok ? 'Signed in, and this session reconnected with the new tools.' : `Signed in. ${live.message}`;
      } else {
        job.message = 'Signed in. New sessions load it; this window has no running session to reconnect.';
      }
      job.phase = 'done';
      publish(job);
    });
    return { ok: true, jobId: job.id };
  };

  const cancel = ({ jobId } = {}) => {
    const job = jobs.get(jobId);
    if (!job || ['done', 'failed', 'cancelled'].includes(job.phase)) return { ok: false };
    job.phase = 'cancelled';
    job.message = 'Sign-in cancelled.';
    cancels.get(jobId)?.();
    publish(job);
    return { ok: true };
  };

  const signOut = async (payload = {}) => {
    const { name } = payload;
    if (!name) throw new Error('which server?');
    const ctx = await context(payload);
    const res = await cli(ctx, ['mcp', 'logout', name], { timeoutMs: 60_000 });
    const message = stripAnsi(`${res.stdout}\n${res.stderr}`).split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    // A claude.ai connector answers with the page to disconnect it on.
    const manageUrl = /(https:\/\/claude\.ai\/[^\s"')]+)/.exec(message)?.[1] || null;
    if (res.code !== 0 && !manageUrl) return { ok: false, message: message || `claude mcp logout exited ${res.code}` };
    if (manageUrl) return { ok: true, manageUrl, message };
    const live = payload.pane?.paneId ? await act({ ...payload, action: 'reconnect' }) : null;
    return { ok: true, message, live };
  };

  const jobsFor = ({ home } = {}) => [...jobs.values()].filter((job) => !home || job.home === home).map((job) => ({ ...job }));

  return { list, signIn, cancel, signOut, act, jobs: jobsFor };
}

module.exports = {
  createMcpConnections,
  parseMcpList,
  parseMcpGet,
  groupServers,
  readScopes,
  serverActions,
  classifyStatus,
  classifyActionResult,
  findActionResult,
  defaultRunClaude,
  defaultRunLogin,
};
