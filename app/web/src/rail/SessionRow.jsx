import { runStateCue, canQuickAnswer, quickAllowOffered } from '../../../src/shared/session-run-state.cjs';
import React, { useEffect, useState } from 'react';
import { ProjectIcon } from './ProjectIcon.jsx';
import { formatRelative } from './format.js';
import { prettyModelId } from '../shell/model-label.js';

// Allow / Deny from the phone's "Needs your answer" rows while the CLI reports
// a permission prompt (OSC 7501 blocked/permission), without opening the
// session. Same server path as the desktop (session:menu-answer, action
// permission-quick): the tap names the prompt the row showed (`expect`, and the
// keeper's `expectSeq`), and main refuses it when the session has moved on, so
// a list that has not refreshed yet can never approve a request the phone never
// displayed. Allow is the one-time "Yes", Deny is Esc; plan approval gets Deny
// only. Big enough to hit with a thumb.
function PhoneQuickAnswer({ client, session, label }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const expect = session.agentStatusMsg;
  const expectSeq = session.agentStatusSeq ?? null;
  const allowOffered = quickAllowOffered(expect);
  useEffect(() => { setError(null); }, [expect, expectSeq]);
  const answer = async (decision) => {
    if (busy || (decision === 'allow' && !allowOffered)) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await client.call('session:menu-answer', {
        pane: { paneId: session.paneId, workspaceId: session.workspaceId },
        sessionId: session.id,
        action: { type: 'permission-quick', decision, expect, expectSeq },
      });
      if (!res?.ok) setError(res?.reason || 'that answer did not land');
    } catch (e) {
      setError(e?.message || 'that answer did not land');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="session-quick" role="group" aria-label="Answer the permission prompt">
      <span className={`session-quick-label${error ? ' error' : ''}`} title={error || expect || ''}>{error || label}</span>
      {allowOffered ? (
        <button type="button" className="session-quick-btn allow" disabled={Boolean(busy)} onClick={() => answer('allow')}>
          {busy === 'allow' ? '…' : 'Allow'}
        </button>
      ) : null}
      <button type="button" className="session-quick-btn deny" disabled={Boolean(busy)} onClick={() => answer('deny')}>
        {busy === 'deny' ? '…' : 'Deny'}
      </button>
    </div>
  );
}

export function SessionRow({
  row, selected, onSelect, iconUrl, showProject = false, client = null,
}) {
  const { session } = row;
  const cue = runStateCue(session);
  const needsAnswer = cue?.kind === 'blocked';
  const working = cue?.kind === 'running';
  const title = session.childTitle || session.title;
  const quickPane = session.paneId ? { paneId: session.paneId, workspaceId: session.workspaceId } : null;
  const quick = Boolean(client && needsAnswer && canQuickAnswer(session, quickPane));

  const rowButton = (
    <button
      type="button"
      className={[
        'session-row',
        selected ? 'selected' : '',
        needsAnswer ? 'needs-answer' : '',
        row.pinned ? 'pinned' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onSelect(session)}
    >
      <ProjectIcon label={row.project?.label || session.project} url={iconUrl} />
      <span className={`session-dot${session.isLive ? ' live' : ''}${needsAnswer ? ' blocked' : ''}${cue?.kind === 'background' ? ' background' : ''}`} aria-hidden="true" />
      {/* ONE encoding of state per row. This said it three times at once: the
          dot, the word "Idle" under the title, and an "Idle" pill on the
          right, so the loudest thing on a row was the least useful fact about
          it. The dot carries live/blocked, the pill carries only a state worth
          acting on, and the meta line is left for the time. */}
      <span className="session-body">
        <span className="session-title">{title}</span>
        <span className="session-meta">
          {showProject ? (
            <span className="session-project">{row.project?.label || session.project}</span>
          ) : session.subproject ? (
            <span className="session-project">{session.subproject}</span>
          ) : null}
          <span className="session-time">{formatRelative(session.lastActiveMs)}</span>
          {/* Live rows only (2026-10-11): how full the context is, from the
              server's statusline-tee stamp (never a guess), and the model. */}
          {session.isLive && typeof session.contextPct === 'number' ? (
            <span className={`session-ctx${session.contextPct >= 70 ? ' warn' : ''}`}>{session.contextPct}% context</span>
          ) : null}
          {session.isLive && session.model && session.model !== 'default' ? (
            <span className="session-model">{prettyModelId(session.model) || session.model}</span>
          ) : null}
        </span>
      </span>
      {needsAnswer && !quick ? <span className="session-badge">Answer</span> : null}
      {cue?.kind === "background" ? <span className="session-badge background">{cue.label}</span> : null}
      {working ? <span className="session-badge working">Working</span> : null}
    </button>
  );
  if (!quick) return rowButton;
  return (
    <div className="session-row-wrap">
      {rowButton}
      <PhoneQuickAnswer client={client} session={session} label={cue?.label || 'needs your answer'} />
    </div>
  );
}
