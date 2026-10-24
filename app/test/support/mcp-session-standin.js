#!/usr/bin/env node
'use strict';

// A stand-in for a live Claude Code session at its prompt, for drives that
// exercise the Connections panel's inline /mcp actions without a real CLI.
// It draws the prompt box Harbor's send path recognizes (a full-width divider,
// "❯ " plus whatever is typed, a divider, a status line), echoes typed text,
// and on Enter answers `/mcp reconnect|enable|disable <server>` the way Claude
// Code 2.1.303 does: the command and its result as transcript records
// (<command-args> then <local-command-stdout>, measured in a live session)
// appended to the transcript named on the command line, and the result line
// drawn under the echoed command.
// Usage: node mcp-session-standin.js <transcript.jsonl> <session id> [<results.json>]
// results.json maps "reconnect <server>" to the result text; the default is
// "Successfully reconnected to <server>" / MCP server "<server>" enabled|disabled.

const fs = require('node:fs');
const path = require('node:path');

const [, , transcript, sessionId, resultsFile] = process.argv;
const history = [];
let typed = '';
const cols = () => Math.max(40, process.stdout.columns || 100);
const rows = () => Math.max(12, process.stdout.rows || 40);

function render() {
  const divider = '─'.repeat(cols());
  const body = history.slice(-(rows() - 6));
  let out = '\x1b[?25l\x1b[H\x1b[2J';
  body.forEach((line, i) => { out += `\x1b[${i + 1};1H${line}`; });
  const top = rows() - 3;
  out += `\x1b[${top};1H${divider}`;
  out += `\x1b[${top + 1};1H❯ ${typed}`;
  out += `\x1b[${top + 2};1H${divider}`;
  out += `\x1b[${top + 3};1H  ⏵⏵ auto mode on (shift+tab to cycle)`;
  out += `\x1b[${top + 1};${3 + typed.length}H\x1b[?25h`;
  process.stdout.write(out);
}

function record(content) {
  const line = JSON.stringify({ type: 'user', sessionId, timestamp: new Date().toISOString(), uuid: `standin-${Date.now()}-${Math.random().toString(16).slice(2)}`, message: { role: 'user', content } });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, `${line}\n`);
}

function results() {
  try { return JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch { return {}; }
}

function submit(text) {
  history.push(`❯ ${text}`);
  const m = /^\/mcp\s+(reconnect|enable|disable)\s+(.+)$/.exec(text.trim());
  if (m) {
    const [, action, name] = m;
    const args = `${action} ${name}`;
    const answer = results()[args] || (action === 'reconnect' ? `Successfully reconnected to ${name}` : `MCP server "${name}" ${action}d`);
    setTimeout(() => {
      record(`<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args>${args}</command-args>`);
      record(`<local-command-stdout>${answer}</local-command-stdout>`);
      history.push(`  ⎿  ${answer}`);
      render();
    }, 300);
  }
  render();
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const s = chunk.replace(/\x1b\[200~|\x1b\[201~/g, '').replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '');
  for (const ch of s) {
    if (ch === '\r' || ch === '\n') { const t = typed; typed = ''; if (t.trim()) submit(t); else render(); continue; }
    if (ch === '\x7f' || ch === '\b') { typed = typed.slice(0, -1); continue; }
    if (ch === '\x03') process.exit(0);
    if (ch >= ' ') typed += ch;
  }
  render();
});
process.stdout.on('resize', render);
render();
