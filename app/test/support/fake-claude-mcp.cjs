#!/usr/bin/env node
'use strict';

// A stand-in for `claude mcp list|get|login|logout`, shaped like Claude Code
// 2.1.303's real output (see test/fixtures/mcp/), for drives and specs that
// must never run the real CLI. Its world is one JSON state file
// (HARBOR_FAKE_CLAUDE_STATE, default fake-claude-state.json beside the cwd):
//   { servers: [{ name, target, transport, status }],
//     login: { "<name>": "oauth-ok" | "claudeai" | "fail" | "hang" } }
// status is one of connected | needs-auth | failed | disabled.
// An "oauth-ok" login waits for <state file>.approve to exist (the drive plays
// the browser), then marks the server connected. A "claudeai" login prints the
// address and exits at once, like the real one; the drive flips the status.

const fs = require('node:fs');
const path = require('node:path');

const stateFile = process.env.HARBOR_FAKE_CLAUDE_STATE || path.join(process.cwd(), 'fake-claude-state.json');
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const STATUS = {
  connected: '✔ Connected',
  'needs-auth': '! Needs authentication',
  failed: '✗ Failed to connect',
  disabled: '⊘ Disabled for this project (re-enable via /mcp)',
};
const [, , verb, sub, ...rest] = process.argv;
const out = (s) => process.stdout.write(s);
const nameArg = () => rest.filter((a) => !a.startsWith('--')).join(' ');
const find = (state, name) => state.servers.find((s) => s.name === name);
const targetText = (s) => (s.transport === 'stdio' ? s.target : `${s.target}${s.transport === 'http' && !s.name.startsWith('claude.ai ') ? ' (HTTP)' : s.transport === 'sse' ? ' (SSE)' : ''}`);

if (verb !== 'mcp') { out('fake claude: only `mcp` is modeled\n'); process.exit(2); }
const state = read();
if (sub === 'list') {
  out('Checking MCP server health…\n\n');
  for (const s of state.servers) out(`${s.name}: ${targetText(s)} - ${STATUS[s.status] || s.status}\n`);
  process.exit(0);
}
if (sub === 'get') {
  const s = find(state, nameArg());
  if (!s) { process.stderr.write(`No MCP server named "${nameArg()}".\n`); process.exit(1); }
  out(`${s.name}:\n  Scope: ${s.name.startsWith('claude.ai ') ? 'claude.ai config' : 'User config (available in all your projects)'}\n  Status: ${STATUS[s.status] || s.status}\n`);
  process.exit(0);
}
if (sub === 'logout') {
  const name = nameArg();
  if (name.startsWith('claude.ai ')) {
    out(`"${name}" is a claude.ai connector — its credentials live on claude.ai, not this machine. Disconnect it at https://claude.ai/settings/connectors\n`);
    process.exit(0);
  }
  const s = find(state, name);
  if (s) { s.status = 'needs-auth'; write(state); }
  out(`Signed out of "${name}". Run \`claude mcp login ${name}\` to authenticate again.\n`);
  process.exit(0);
}
if (sub === 'login') {
  const name = nameArg();
  const mode = (state.login || {})[name] || 'oauth-ok';
  const url = name.startsWith('claude.ai ')
    ? `https://claude.ai/api/organizations/org-demo/mcp/start-auth/mcpsrv_demo?product_surface=cli`
    : `https://auth.example.com/authorize?client_id=demo&state=demo`;
  const link = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
  if (mode === 'fail') {
    out(`Starting authentication for "${name}"…\n`);
    setTimeout(() => { process.stderr.write(`Couldn't complete authentication for "${name}": the authorization server answered access_denied\n`); process.exit(1); }, 400);
    return;
  }
  if (mode === 'claudeai') {
    out(`Visit this URL to authorize:\n  ${link}\n\nOnce authorized on claude.ai, the connector will be available the next time you start Claude Code.\n`);
    process.exit(0);
  }
  out(`Starting authentication for "${name}"…\nVisit this URL to authorize:\n  ${link}\n\nWaiting for authorization… (^C to cancel)\n`);
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const tick = setInterval(() => {
    if (!fs.existsSync(`${stateFile}.approve`)) return;
    clearInterval(tick);
    fs.rmSync(`${stateFile}.approve`, { force: true });
    const now = read();
    const s = find(now, name);
    if (s) { s.status = 'connected'; write(now); }
    out(`\nAuthenticated with "${name}". Its tools are now available in Claude Code.\n`);
    process.exit(0);
  }, 200);
  return;
}
out(`fake claude: mcp ${sub} is not modeled\n`);
process.exit(2);
