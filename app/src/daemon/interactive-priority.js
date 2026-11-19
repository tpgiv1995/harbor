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

module.exports = { raiseToInteractive };
