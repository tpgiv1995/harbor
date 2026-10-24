'use strict';

// The Connections panel's pure rules (2026-10-24): what /mcp opens, how a
// server's status reads, and what a row says while a sign-in is running. The
// facts themselves come from main/providers/mcp-connections.js, which runs the
// Claude CLI; nothing here guesses a status.

// `/mcp` with nothing after it opens Harbor's own panel. `/mcp reconnect x`,
// `/mcp enable x` and `/mcp disable x` are the CLI's inline actions and still
// go to the session as typed.
function isBareMcpCommand(text) {
  return /^\s*\/mcp\s*$/i.test(String(text || ''));
}

const STATUS_VIEW = {
  connected: { label: 'Connected', tone: 'ok' },
  'needs-auth': { label: 'Needs sign-in', tone: 'warn' },
  failed: { label: 'Failed to connect', tone: 'err' },
  connecting: { label: 'Connecting', tone: 'pending' },
  disabled: { label: 'Disabled', tone: 'off' },
  'pending-approval': { label: 'Waiting for approval', tone: 'pending' },
  rejected: { label: 'Rejected', tone: 'off' },
  unknown: { label: 'Unknown', tone: 'off' },
};

function statusView(server) {
  const view = STATUS_VIEW[server?.status] || STATUS_VIEW.unknown;
  return { ...view, title: server?.statusText || view.label };
}

const ACTION_LABEL = {
  'sign-in': 'Sign in',
  'sign-out': 'Sign out',
  reconnect: 'Reconnect',
  enable: 'Enable',
  disable: 'Disable',
};

// A sign-in job, as the row shows it.
function jobView(job) {
  if (!job) return null;
  switch (job.phase) {
    case 'starting': return { tone: 'pending', busy: true, label: 'Starting the sign-in…', message: null };
    case 'waiting': return { tone: 'pending', busy: true, label: 'Waiting for you in the browser', message: job.message, url: job.url, cancellable: true };
    case 'verifying': return { tone: 'pending', busy: true, label: job.kind === 'claudeai' ? 'Waiting for claude.ai to confirm' : 'Checking the connection', message: job.message, url: job.kind === 'claudeai' ? job.url : null, cancellable: job.kind === 'claudeai' };
    case 'reconnecting': return { tone: 'pending', busy: true, label: 'Reconnecting this session', message: null };
    case 'done': return { tone: job.live && !job.live.ok ? 'warn' : 'ok', busy: false, label: 'Signed in', message: job.message };
    case 'failed': return { tone: 'err', busy: false, label: 'Sign-in failed', message: job.message, retry: true };
    case 'cancelled': return { tone: 'off', busy: false, label: 'Cancelled', message: null, retry: true };
    default: return null;
  }
}

// The newest job per server name for this home.
function latestJobs(jobs, home) {
  const by = new Map();
  for (const job of jobs || []) {
    if (home && job.home !== home) continue;
    const prev = by.get(job.name);
    if (!prev || (job.startedAt || 0) >= (prev.startedAt || 0)) by.set(job.name, job);
  }
  return by;
}

function mergeJob(jobs, update) {
  const list = Array.isArray(jobs) ? jobs.filter((job) => job.id !== update?.id) : [];
  return update ? [...list, update] : list;
}

// Counts for the header line: "20 servers · 3 need sign-in".
function summary(groups) {
  const servers = (groups || []).flatMap((group) => group.servers || []);
  const need = servers.filter((s) => s.status === 'needs-auth').length;
  const failed = servers.filter((s) => s.status === 'failed').length;
  const parts = [`${servers.length} ${servers.length === 1 ? 'server' : 'servers'}`];
  if (need) parts.push(`${need} need${need === 1 ? 's' : ''} sign-in`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

// An action result (reconnect, enable, disable, sign-out) as one status line.
function actionNote(action, result) {
  if (!result) return null;
  if (result.manageUrl) return { tone: 'pending', text: 'A claude.ai connector is signed out on claude.ai.', url: result.manageUrl };
  return { tone: result.ok ? 'ok' : 'warn', text: result.message || (result.ok ? `${ACTION_LABEL[action] || action}: done` : `${ACTION_LABEL[action] || action}: failed`) };
}

module.exports = { isBareMcpCommand, statusView, jobView, latestJobs, mergeJob, summary, actionNote, ACTION_LABEL };
