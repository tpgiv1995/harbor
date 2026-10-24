import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import model from './connections-model.cjs';
import './connections.css';

const { statusView, jobView, latestJobs, mergeJob, summary, actionNote, ACTION_LABEL } = model;

// CONNECTIONS: Harbor's own /mcp (2026-10-24). Every MCP server and claude.ai
// connector for THIS session's plan and folder, with its status read from the
// Claude CLI, a Sign in that opens the browser and waits for the sign-in to
// come back, and the CLI's inline Reconnect / Enable / Disable for the running
// session. Portaled to body: the stage's glass layers set backdrop-filter,
// which would trap a fixed overlay. No animation anywhere (a busy row says so
// in words).
// "User MCPs (<home>/.claude.json)": the heading is small caps, the file it
// names is a path and keeps its own spelling.
function groupHeading(label) {
  const m = /^(.*?)\s*\(([^()]*[\\/][^()]*)\)$/.exec(label || '');
  if (!m) return label;
  return <>{m[1]} <span className="conn-group-path">{m[2]}</span></>;
}

export function ConnectionsPanel({ session, pane, planLabel, onClose }) {
  const [view, setView] = useState({ loading: true, error: null, data: null });
  const [jobs, setJobs] = useState([]);
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState({});
  const [copied, setCopied] = useState(null);
  const panelRef = useRef(null);
  const live = Boolean(pane?.paneId);
  const payload = useMemo(() => ({
    sessionId: session?.id,
    cwd: session?.cwd || null,
    home: session?.home || null,
    pane: live ? { paneId: pane.paneId, workspaceId: pane.workspaceId || null } : null,
  }), [session?.id, session?.cwd, session?.home, live, pane?.paneId, pane?.workspaceId]);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  const load = async ({ quiet = false } = {}) => {
    if (!quiet) setView((prev) => ({ ...prev, loading: true, error: null }));
    const res = await window.harbor.connections.list(payloadRef.current).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    setView((prev) => (res?.ok
      ? { loading: false, error: null, data: res }
      : { loading: false, error: res?.reason || 'the Claude CLI did not answer', data: quiet ? prev.data : null }));
  };

  useEffect(() => {
    load();
    window.harbor.connections.jobs({}).then((res) => { if (res?.ok) setJobs(res.jobs || []); }).catch(() => {});
    const off = window.harbor.connections.onUpdate((job) => {
      setJobs((current) => mergeJob(current, job));
      if (job.phase === 'done' || job.phase === 'failed') load({ quiet: true });
    });
    panelRef.current?.focus();
    return off;
    // One panel per open; the payload ref carries the latest session facts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Esc closes from anywhere while the panel is open: a button disabled while
  // it works drops focus to the page body, out of the panel's own handlers.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const byName = latestJobs(jobs, view.data?.home);

  const run = async (server, action) => {
    const name = server.name;
    setNotes((current) => ({ ...current, [name]: null }));
    setBusy((current) => ({ ...current, [name]: action }));
    let res;
    try {
      if (action === 'sign-in') res = await window.harbor.connections.signIn({ ...payloadRef.current, name });
      else if (action === 'sign-out') res = await window.harbor.connections.signOut({ ...payloadRef.current, name });
      else res = await window.harbor.connections.act({ ...payloadRef.current, name, action });
    } catch (error) {
      res = { ok: false, reason: String(error?.message || error) };
    }
    setBusy((current) => ({ ...current, [name]: null }));
    if (action === 'sign-in') {
      if (!res?.ok) setNotes((current) => ({ ...current, [name]: { action, result: { ok: false, message: res?.reason } } }));
      return;
    }
    setNotes((current) => ({ ...current, [name]: { action, result: res?.ok === false && res?.reason ? { ok: false, message: res.reason } : res } }));
    load({ quiet: true });
  };

  const copy = async (url) => {
    try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard refused */ }
  };

  const folder = view.data?.cwd || session?.cwd || null;
  const groups = view.data?.groups || [];

  return createPortal(
    <div className="new-session-backdrop conn-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="conn-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conn-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="conn-head">
          <div className="conn-head-text">
            <span className="conn-eyebrow">CONNECTIONS</span>
            <h2 id="conn-title">MCP servers and connectors</h2>
            <div className="conn-sub" title={folder || ''}>
              {[planLabel ? `${planLabel} plan` : null, folder].filter(Boolean).join(' · ') || 'this session'}
            </div>
          </div>
          <div className="conn-head-ctl">
            <button type="button" className="conn-btn" onClick={() => load()} disabled={view.loading} title="Ask the Claude CLI again">
              {view.loading ? 'Checking…' : 'Check again'}
            </button>
            <button type="button" className="new-session-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="conn-scroll">
          {view.loading && !view.data ? (
            <div className="conn-empty">Asking the Claude CLI. It checks every server, which takes a few seconds.</div>
          ) : null}
          {view.error ? <div className="conn-error">Could not read the connections: {view.error}</div> : null}
          {view.data?.empty ? <div className="conn-empty">{view.data.note || 'No MCP servers are configured for this plan and folder.'}</div> : null}
          {groups.map((group) => (
            <section key={group.key} className="conn-group" aria-label={group.label}>
              <div className="conn-group-h" title={group.label}>{groupHeading(group.label)}</div>
              {group.servers.map((server) => {
                const job = jobView(byName.get(server.name));
                const status = job?.busy ? { label: 'Signing in', tone: 'pending', title: job.label } : statusView(server);
                const note = notes[server.name] ? actionNote(notes[server.name].action, notes[server.name].result) : null;
                const working = busy[server.name] || (job?.busy ? 'sign-in' : null);
                const actions = (server.actions || []).filter((a) => !(a === 'sign-in' && job?.busy));
                return (
                  <div key={server.name} className={`conn-row tone-${status.tone}`} data-server={server.name}>
                    <div className="conn-row-main">
                      <span className={`conn-dot tone-${status.tone}`} aria-hidden="true" />
                      <div className="conn-id">
                        <div className="conn-name" title={server.name}>{server.name}</div>
                        <div className="conn-target" title={server.target}>{server.target}</div>
                      </div>
                      <span className={`conn-status tone-${status.tone}`} title={status.title}>{status.label}</span>
                      <div className="conn-acts">
                        {actions.map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={`conn-btn${action === 'sign-in' ? ' primary' : ''}`}
                            disabled={Boolean(working)}
                            onClick={() => run(server, action)}
                            title={action === 'reconnect' ? 'Runs /mcp reconnect in this session' : action === 'sign-in' ? 'Opens the sign-in page in your browser' : undefined}
                          >
                            {working === action ? `${ACTION_LABEL[action]}…` : ACTION_LABEL[action]}
                          </button>
                        ))}
                      </div>
                    </div>
                    {job ? (
                      <div className={`conn-job tone-${job.tone}`} role="status">
                        <span className="conn-job-label">{job.label}</span>
                        {job.message ? <span className="conn-job-msg">{job.message}</span> : null}
                        <span className="conn-job-ctl">
                          {job.url ? <button type="button" className="conn-link" onClick={() => window.harbor.connections.openUrl({ url: job.url })}>Open the page again</button> : null}
                          {job.url ? <button type="button" className="conn-link" onClick={() => copy(job.url)}>{copied === job.url ? 'Copied' : 'Copy link'}</button> : null}
                          {job.cancellable ? <button type="button" className="conn-link" onClick={() => window.harbor.connections.cancel({ jobId: byName.get(server.name).id })}>Cancel</button> : null}
                          {job.retry && server.actions?.includes('sign-in') ? <button type="button" className="conn-link" onClick={() => run(server, 'sign-in')}>Try again</button> : null}
                        </span>
                      </div>
                    ) : null}
                    {note ? (
                      <div className={`conn-job tone-${note.tone}`} role="status">
                        <span className="conn-job-msg">{note.text}</span>
                        {note.url ? <span className="conn-job-ctl"><button type="button" className="conn-link" onClick={() => window.harbor.connections.openUrl({ url: note.url })}>Open claude.ai</button></span> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <div className="conn-foot">
          {view.data ? <span>{summary(groups)}</span> : <span />}
          <span className="conn-foot-note">
            {live
              ? 'Sign in uses the Claude CLI for this plan; Reconnect, Enable and Disable apply to this running session.'
              : 'This session is not running: sign-ins apply when it next starts.'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
