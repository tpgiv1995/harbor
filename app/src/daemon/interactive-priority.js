'use strict';

// HARBOR'S SESSIONS RUN ABOVE THE BATCH WORK THEY START (2026-11-18, Pat:
// "harbor is absolutely fucked right now"). Every Claude in a Harbor pane was
// found at BELOW NORMAL priority: the live sessiond had been started by
// something that runs below normal (Task Scheduler's default priority is 7,
// below normal), and Windows hands IDLE and BELOW NORMAL down to every child,
// so the daemon, all eleven keepers and every claude.exe under them inherited
// it. Windows schedules strictly by priority, so eight Normal-priority Python
// jobs plus an agent's 48-worker CPU test starved every pane: an idle Claude
// took more than 8 s to draw a typed message, a busy one drew nothing for six
// minutes ("running PreToolUse hook · 4m 11s" on two screens 34 s apart), and
// Harbor's sends gave up on text that was only queued behind the stall.
//
// So the session chain sets its own priority on Windows instead of trusting
// whoever launched it: the daemon and each keeper raise THEMSELVES, and a
// keeper raises the CLI it spawns. Above normal, not high: the chain is mostly
// idle and must win the CPU when it needs it, not take it from everything.
// The CLI's own children (tool commands, Python jobs, MCP servers) start at
// NORMAL, because Windows passes on only idle and below normal, so the work an
// agent launches can never starve the agent that launched it. Elsewhere this
// is a no-op: raising priority needs privileges on Linux and macOS.
function raiseToInteractive(pid = 0, { platform = process.platform, os = require('node:os') } = {}) {
  if (platform !== 'win32') return false;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    return true;
  } catch {
    return false; // a pid that already exited, or a priority we may not set
  }
}

// A LAUNCHER KEEPS THE BOOST TO ITSELF (2026-11-18, Sol's review, then
// measured: a process raised to ABOVE NORMAL starts its children at NORMAL;
// only IDLE and BELOW NORMAL are inherited). Claude's pane runs claude.exe
// directly, but a Codex pane runs the npm shim (node codex.js), which starts
// the real codex.exe, so the keeper's raise reached only the shim. So the
// keeper also raises any DIRECT child of the process it spawned whose program
// is a known agent CLI, and nothing deeper: the CLI's own tools and servers
// stay at NORMAL. A child that predates its parent is a recycled-pid stranger.
const path = require('node:path');
const AGENT_CLI_RE = /^(codex|claude|cursor-agent|agy)\.exe$/i;
function raiseLaunchedCli(rootPid, { table, platform = process.platform, os = require('node:os') } = {}) {
  if (platform !== 'win32' || !table || !table.get) return [];
  const root = table.get(rootPid);
  if (!root) return [];
  const raised = [];
  for (const row of table.values()) {
    if (row.ppid !== rootPid || !AGENT_CLI_RE.test(path.win32.basename(row.name || ''))) continue;
    if (root.created !== undefined && row.created !== undefined && row.created < root.created) continue;
    if (raiseToInteractive(row.pid, { platform, os })) raised.push(row.pid);
  }
  return raised;
}

module.exports = { raiseToInteractive, raiseLaunchedCli };
