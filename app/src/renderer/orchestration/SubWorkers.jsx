import React from 'react';
import { providerIdentity } from '../providers.js';
import { CopySessionId } from '../stage/CopySessionId.jsx';
import { StatusIcon, HelperIcon } from './TeamIcons.jsx';
import { subStatus, subCountText, subSourceText, clockText } from './team-text.cjs';
import './team-subs.css';

// SUB-WORKERS ON THE CHART (Pat, 2026-11-03: "one of the whole points of this
// orchestration diagram ... was to see these little sub workers"). A tray of
// mini cards hangs under the card of the agent that started them: Codex
// sub-agents and approval reviews, headless runs, exec runs and Claude Task
// helpers, running ones first. The tray is part of the card's footprint on the
// board, so reporting lines leave from under it and route around it.
//
// A mini card with a session opens that conversation (read-only, as the
// sub-sessions list did); a Task helper has no session of its own, so it opens
// its parent's drawer, which lists every sub-worker.

export const SUB_TRAY_CAP = 4;

function SubCard({ entry, now, onOpen }) {
  const identity = providerIdentity(entry.provider);
  const status = subStatus(entry, now);
  const tip = [
    entry.name,
    [entry.kindText, entry.modelLabel].filter(Boolean).join(' · '),
    entry.detail,
    subSourceText(entry),
    entry.startedMs ? `Started ${clockText(entry.startedMs)}` : null,
    entry.sessionId ? 'Click to open its conversation' : 'Click to see it in the agent\'s drawer',
  ].filter(Boolean).join('\n');
  return (
    <li className={`tc-sub status-${status.kind}`} data-sub-key={entry.key}>
      <button type="button" className="tc-sub-open" onClick={() => onOpen(entry)} title={tip}>
        <img src={identity.logo} alt={identity.label} />
        <span className="tc-sub-name">{entry.name}</span>
        <span className={`tc-sub-state ${status.kind}`}><StatusIcon kind={status.kind} /><span className="tc-sub-state-text">{status.text}</span></span>
      </button>
      {entry.sessionId ? <CopySessionId sessionId={entry.sessionId} className="tc-copy tc-sub-copy" /> : null}
    </li>
  );
}

export function SubTray({ entries, now, expanded, onToggle, onOpen, loose = false, dim = false }) {
  if (!entries?.length) return null;
  const shown = expanded ? entries : entries.slice(0, SUB_TRAY_CAP);
  const hidden = entries.length - shown.length;
  return (
    <div className={`tc-subs${loose ? ' loose' : ''}${dim ? ' dim' : ''}`}>
      <div className="tc-subs-head" title="Sub-workers active in the last 6 hours, running ones first">
        <HelperIcon />
        <span>{loose ? `${subCountText(entries, now)} whose parent is not on the chart` : subCountText(entries, now)}</span>
      </div>
      <ul className="tc-subs-grid">
        {shown.map((entry) => <SubCard key={entry.key} entry={entry} now={now} onOpen={onOpen} />)}
      </ul>
      {entries.length > SUB_TRAY_CAP ? (
        <button type="button" className="tc-subs-more" aria-expanded={Boolean(expanded)} onClick={onToggle}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

// The drawer's list: every sub-worker, with the same open action.
export function SubWorkerList({ entries, now, onOpen }) {
  return (
    <ul className="tcd-subs">
      {entries.map((entry) => {
        const identity = providerIdentity(entry.provider);
        const status = subStatus(entry, now);
        return (
          <li key={entry.key}>
            <img src={identity.logo} alt={identity.label} />
            <span className="tcd-sub-copy">
              {entry.sessionId
                ? <button type="button" className="tc-link tcd-sub-name" onClick={() => onOpen(entry)} title="Open its conversation">{entry.name}</button>
                : <span className="tcd-sub-name">{entry.name}</span>}
              <span className="tcd-muted">{[entry.kindText, entry.modelLabel, status.text, subSourceText(entry)].filter(Boolean).join(' · ')}</span>
            </span>
            {entry.sessionId ? <CopySessionId sessionId={entry.sessionId} className="tc-copy" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
