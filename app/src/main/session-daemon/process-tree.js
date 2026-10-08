'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Harbor depends on a pane's foreground processes in two
// places that matter: worker close captures the pid BEFORE closing so it can
// verify the process actually died (a clean pane close orphans a
// `claude --resume` and its MCP children), and the provider linker reads the
// DEEPEST child's argv to learn which codex/cursor session a pane holds.
//
// sessiond reports only the pty's own pid, so on that backend both features
// silently lost their handle: force-close answered "no shell pid or process
// group found for pane" and refused, and codex panes fell back to a raw
// terminal. The pid is enough to rebuild the rest here, on the same machine.
//
// /proc/<pid>/task/<pid>/children is the cheap authoritative answer on Linux
// (one read per node instead of scanning every /proc/*/stat). Anything else
// returns an empty list rather than a guess, so a caller sees "unknown", not a
// wrong pid.
async function readChildren(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return raw.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  } catch {
    return [];
  }
}

async function describe(pid) {
  const [argv, cwd] = await Promise.all([
    fs.readFile(`/proc/${pid}/cmdline`)
      .then((buf) => buf.toString('utf8').split('\0').filter(Boolean))
      .catch(() => []),
    fs.readlink(`/proc/${pid}/cwd`).catch(() => null),
  ]);
  return { pid, argv, cwd: cwd && path.isAbsolute(cwd) ? cwd : null };
}

function splitWindowsCommandLine(command) {
  const argv = [];
  const pattern = /"((?:\\"|[^"])*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || '')))) argv.push((match[1] ?? match[2]).replace(/\\"/g, '"'));
  return argv;
}

// Root first, deepest last: consumers read `procs[procs.length - 1]` as the
// agent itself, because `node .../bin/codex` spawns the real binary beneath it.
// Depth-limited and count-limited so a fork bomb cannot turn a status read into
// an unbounded walk.
//
// On win32 the chain comes from the daemon's resident process snapshot
// (proc-tree), and it MUST be asked through the caller's own daemon client
// (`request`). A fresh SessionClient resolves its socket from process.env, so
// a client pointed at an isolated store asked the user's REAL sessiond instead
// (2026-10-07: session-daemon-live's processInfo spec passed or failed on
// whether the real daemon's 2s snapshot already held the test shell). With no
// `request`, there is nothing safe to ask: answer [] rather than guess a daemon.
async function foregroundProcesses(rootPid, { maxDepth = 12, maxNodes = 64, request = null } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  if (process.platform === 'win32') {
    if (typeof request !== 'function') return [];
    try {
      const result = await request('proc-tree', { pid: rootPid });
      if (!result) return [];
      // The daemon returns breadth-first rows. Choose one foreground chain,
      // root first/deepest last, matching the Linux consumer contract.
      const rows = result.processes || [];
      const byParent = new Map();
      for (const row of rows) { if (!byParent.has(row.ppid)) byParent.set(row.ppid, []); byParent.get(row.ppid).push(row); }
      const chain = []; let row = rows.find((item) => item.pid === rootPid);
      while (row && chain.length < maxDepth && chain.length < maxNodes) {
        chain.push({ pid: row.pid, argv: splitWindowsCommandLine(row.cmdline), cwd: null, startedMs: row.startedAt ?? null });
        const children = byParent.get(row.pid) || [];
        row = children.length === 1 ? children[0] : children.sort((a, b) => b.pid - a.pid)[0];
      }
      return chain;
    } catch { return []; }
  }
  if (process.platform !== 'linux') return [];
  // A pid that is not there yields NOTHING, not a hollow entry. The provider
  // linker reads the last element and checks only `.pid`, so a placeholder
  // { pid, argv: [], cwd: null } would pass that check and then resolve no
  // session, which is worse than an honest empty list.
  try { await fs.stat(`/proc/${rootPid}`); } catch { return []; }
  const chain = [];
  let pid = rootPid;
  for (let depth = 0; depth < maxDepth && chain.length < maxNodes; depth += 1) {
    chain.push(await describe(pid));
    const children = await readChildren(pid);
    if (children.length === 0) break;
    // A pty runs one foreground job. With more than one child the newest (the
    // highest pid, barring wraparound) is the one just started, which is the
    // job the user is looking at.
    pid = children.length === 1 ? children[0] : Math.max(...children);
  }
  return chain;
}

module.exports = { foregroundProcesses, readChildren, describe, splitWindowsCommandLine };
