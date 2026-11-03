import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { providerIdentity } from '../providers.js';
import { CopySessionId } from '../stage/CopySessionId.jsx';
import { StatusIcon, WarnIcon, CloseIcon, OpenIcon } from './TeamIcons.jsx';
import { PlanMark, EffortPips } from './AgentCard.jsx';
import { SubWorkerList } from './SubWorkers.jsx';
import { ago, clockText, statusText, runModeText, warningText, resetText } from './team-text.cjs';

// The side drawer: everything Harbor knows about one agent, read-only (Pat,
// section 8 item 2). It sits over the right edge so the chart does not reflow,
// renders through a portal (a backdrop-filter ancestor would trap a fixed
// element), closes on Escape, and hands focus back to the card it came from.

const SOURCE_TEXT = {
  launch: 'launch record',
  declared: 'TEAM.json',
  delegation: 'a command it ran',
  process: 'the process tree',
};

function Row({ label, children }) {
  if (children == null || children === '' || children === false) return null;
  return <div className="tcd-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function MemberLink({ id, team, onSelect }) {
  const member = team.members[id];
  if (!member) return <span className="tcd-muted">an agent that is no longer running</span>;
  return <button type="button" className="tcd-link" onClick={() => onSelect(id)}>{member.name}</button>;
}

export function AgentDrawer({ member, team, now, profiles, onClose, onSelect, onOpenSession, onOpenSub, returnFocusTo }) {
  const panel = useRef(null);
  useEffect(() => {
    panel.current?.querySelector('h2')?.focus();
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const card = returnFocusTo && document.querySelector(`[data-member-id="${CSS.escape(returnFocusTo)}"] .tc-open, [data-member-id="${CSS.escape(returnFocusTo)}"] .tc-chip-open`);
      card?.focus?.();
    };
  }, [member?.id]);
  if (!member) return null;
  const identity = providerIdentity(member.provider);
  const profile = (profiles || []).find((p) => p.id === member.home);
  const warnings = (team.warnings || []).filter((w) => (w.memberIds || []).includes(member.id));
  const usage = member.usage;
  const open = member.openTools || [];
  const reviewers = (team.edges || []).filter((e) => e.kind === 'reviews' && e.to === member.id).map((e) => e.from);
  const reviews = (team.edges || []).filter((e) => e.kind === 'reviews' && e.from === member.id).map((e) => e.to);
  return createPortal(
    <aside className="tc-drawer" ref={panel} role="dialog" aria-modal="false" aria-label={`${member.name}, details`}>
      <header className="tcd-head">
        <span className="tc-logo"><img src={identity.logo} alt={identity.label} /></span>
        <div className="tcd-title">
          <h2 tabIndex={-1}>{member.name}</h2>
          <span className="tc-role">{member.role ? `${member.role} · ${runModeText(member)}` : runModeText(member)}</span>
        </div>
        <CopySessionId sessionId={member.sessionId} className="tc-copy" />
        <button type="button" className="tcd-icon" onClick={onClose} aria-label="Close details" title="Close (Esc)"><CloseIcon /></button>
      </header>

      <div className="tcd-body">
        <section className="tcd-now">
          <span className={`tc-status ${member.status?.kind || 'idle'}`}><StatusIcon kind={member.status?.kind} /><span>{statusText(member.status, now)}</span></span>
          {member.description ? <p className="tcd-desc">{member.description}</p> : <p className="tcd-desc tcd-muted">No description yet.</p>}
          {member.description && member.descriptionAtMs ? <span className="tcd-muted tcd-small">Described {ago(member.descriptionAtMs, now)} ago</span> : null}
          {member.sessionId && onOpenSession ? (
            <button type="button" className="tcd-open" onClick={() => onOpenSession(member.sessionId)}><OpenIcon />Open conversation</button>
          ) : null}
        </section>

        {warnings.length ? (
          <section className="tcd-section">
            <h3>Warnings</h3>
            <ul className="tcd-warnings">
              {warnings.map((w) => <li key={w.id}><WarnIcon /><span>{warningText(w, team.members, profiles, now)}</span></li>)}
            </ul>
          </section>
        ) : null}

        {open.length ? (
          <section className="tcd-section">
            <h3>Open now</h3>
            <ul className="tcd-actions">
              {open.map((tool) => <li key={tool.id}><span className="tcd-time">{ago(tool.startedMs, now)}</span><span className="tcd-tool">{tool.name}</span><span className="tcd-summary">{tool.summary}</span></li>)}
            </ul>
          </section>
        ) : null}

        {member.lastPrompt ? (
          <section className="tcd-section">
            <h3>Latest request</h3>
            <p className="tcd-quote">{member.lastPrompt}</p>
          </section>
        ) : null}

        {member.actions?.length ? (
          <section className="tcd-section">
            <h3>Last {member.actions.length} action{member.actions.length === 1 ? '' : 's'}</h3>
            <ul className="tcd-actions">
              {[...member.actions].reverse().map((action, index) => (
                <li key={`${action.atMs}-${index}`}><span className="tcd-time">{clockText(action.atMs)}</span><span className="tcd-tool">{action.name}</span><span className="tcd-summary">{action.summary}</span></li>
              ))}
            </ul>
          </section>
        ) : null}

        {member.lastText ? (
          <section className="tcd-section">
            <h3>Latest reply</h3>
            <p className="tcd-quote">{member.lastText}</p>
          </section>
        ) : null}

        {member.subWorkers?.length ? (
          <section className="tcd-section">
            <h3>Sub-workers in the last 6 hours ({member.subWorkers.length})</h3>
            <SubWorkerList entries={member.subWorkers} now={now} onOpen={(entry) => onOpenSub?.(entry)} />
          </section>
        ) : null}

        <section className="tcd-section">
          <h3>Reporting</h3>
          <dl className="tcd-grid">
            <Row label="Reports to">{member.parent ? <><MemberLink id={member.parent} team={team} onSelect={onSelect} /><span className="tcd-muted"> (from {SOURCE_TEXT[member.parentSource] || member.parentSource})</span></> : member.launchedBy ? <span className="tcd-muted">launched by a session that is no longer running</span> : member.parentUnknown ? <span className="tcd-muted">not on record: it started before launches were recorded, and the session that launched it has restarted since</span> : <span className="tcd-muted">nobody; it was opened directly</span>}</Row>
            <Row label="Runs inside">{member.processParent && member.processParent !== member.parent ? <><MemberLink id={member.processParent} team={team} onSelect={onSelect} /><span className="tcd-muted">'s pane</span></> : null}</Row>
            <Row label="Directs">{member.children?.length ? member.children.map((id, i) => <React.Fragment key={id}>{i ? ', ' : ''}<MemberLink id={id} team={team} onSelect={onSelect} /></React.Fragment>) : null}</Row>
            <Row label="Depend on its pane">{member.dependents?.length ? `${member.dependents.length} worker${member.dependents.length === 1 ? '' : 's'}` : null}</Row>
            <Row label="Reviewed by">{reviewers.length ? reviewers.map((id, i) => <React.Fragment key={id}>{i ? ', ' : ''}<MemberLink id={id} team={team} onSelect={onSelect} /></React.Fragment>) : null}</Row>
            <Row label="Reviews">{reviews.length ? reviews.map((id, i) => <React.Fragment key={id}>{i ? ', ' : ''}<MemberLink id={id} team={team} onSelect={onSelect} /></React.Fragment>) : null}</Row>
            <Row label="Run">{member.batch ? `${member.batch.title}${member.batch.run ? ` (${member.batch.run})` : ''}` : null}</Row>
            <Row label="Team">{member.declaredTeam}</Row>
          </dl>
        </section>

        {member.rounds?.length ? (
          <section className="tcd-section">
            <h3>Rounds</h3>
            <ol className="tcd-rounds">
              {member.rounds.map((round) => <li key={round.id}><span>{round.description}</span><span className="tcd-muted">{clockText(round.startedMs)} · {round.outcome}</span></li>)}
            </ol>
          </section>
        ) : null}

        <section className="tcd-section">
          <h3>Model and plan</h3>
          <dl className="tcd-grid">
            <Row label="Model">{member.model ? <span className="tcd-mono">{member.model}</span> : 'Not known yet'}</Row>
            <Row label="Effort"><EffortPips effort={member.effort} /></Row>
            <Row label="Plan"><PlanMark profile={profile} homeId={member.home} /></Row>
            <Row label="Weekly">{Number.isFinite(usage?.weeklyPct) ? `${Math.round(usage.weeklyPct)}% used${resetText(usage.weeklyResetsAt) ? `, resets ${resetText(usage.weeklyResetsAt)}` : ''}` : null}</Row>
            <Row label="5-hour">{Number.isFinite(usage?.fiveHourPct) ? `${Math.round(usage.fiveHourPct)}% used${resetText(usage.fiveHourResetsAt) ? `, resets ${resetText(usage.fiveHourResetsAt)}` : ''}` : null}</Row>
            <Row label="Sample">{usage?.sampledMs ? `${ago(usage.sampledMs, now)} old${usage.stale ? ', too old to count as current' : ''}` : usage ? 'age unknown' : null}</Row>
          </dl>
        </section>

        <section className="tcd-section">
          <h3>Where it runs</h3>
          <dl className="tcd-grid">
            <Row label="Project">{member.teamProject || member.project}</Row>
            <Row label="Folder">{member.cwd ? <span className="tcd-mono tcd-path">{member.cwd}</span> : null}</Row>
            <Row label="Lane">{member.lane}</Row>
            <Row label="Process">{member.pid ? <span className="tcd-mono">{member.pid}</span> : null}</Row>
            <Row label="Started">{member.createdMs ? `${clockText(member.createdMs)} (${ago(member.createdMs, now)} ago)` : null}</Row>
            <Row label="Last activity">{member.lastEventMs ? `${clockText(member.lastEventMs)} (${ago(member.lastEventMs, now)} ago)` : null}</Row>
            <Row label="Session">{member.sessionId ? <span className="tcd-mono">{member.sessionId}</span> : <span className="tcd-muted">none recorded (Cursor records no session id)</span>}</Row>
          </dl>
        </section>
      </div>
    </aside>,
    document.body,
  );
}
