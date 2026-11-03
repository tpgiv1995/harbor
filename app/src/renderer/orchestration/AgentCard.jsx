import React from 'react';
import { providerIdentity } from '../providers.js';
import { CopySessionId } from '../stage/CopySessionId.jsx';
import { StatusIcon, WarnIcon } from './TeamIcons.jsx';
import { effortStep, runModeText, statusText, ago } from './team-text.cjs';

// One agent on the team board (2026-11-02). A short, wide card of one fixed
// size, like a Miro card but a little wider (Pat: "the cards being a little
// more 'horizontal' even than in miro"), so rows line up and a whole team
// fits on screen. The name is a button stretched over the card that opens
// the drawer, so Copy session id beside it stays its own button rather than
// a control nested inside another.

export function PlanMark({ profile, homeId }) {
  if (!homeId) return <span className="tc-plan-none">Not known</span>;
  const color = profile?.color || 'var(--sub)';
  return (
    <span className="tc-plan-mark" style={{ '--plan': color }} title={profile?.label || homeId}>
      <span className="tc-plan-letter" aria-hidden="true">{profile?.letter || homeId.slice(0, 1).toUpperCase()}</span>
      <span className="tc-plan-name">{profile?.label || homeId}</span>
    </span>
  );
}

function usageTitle(usage, now) {
  const rounded = Math.round(usage.weeklyPct);
  const sample = usage.sampledMs ? `sample ${ago(usage.sampledMs, now)} old` : 'sample age unknown';
  return `Weekly limit ${rounded}% used, ${sample}`;
}

function usageTone(pct) {
  return pct >= 90 ? 'high' : pct >= 75 ? 'mid' : 'low';
}

// The drawer's longer form: a bar and the percent side by side.
export function UsageMeter({ usage, now }) {
  const pct = usage?.weeklyPct;
  if (!Number.isFinite(pct)) return <span className="tc-usage-none" title="No usage reading for this plan yet">no reading</span>;
  return (
    <span className={`tc-usage ${usageTone(pct)}${usage.stale ? ' stale' : ''}`} title={usageTitle(usage, now)}>
      <span className="tc-usage-track" aria-hidden="true"><span className="tc-usage-fill" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} /></span>
      <span className="tc-usage-pct">{Math.round(pct)}%</span>
    </span>
  );
}

export function EffortPips({ effort }) {
  const step = effortStep(effort);
  if (!step) return <span className="tc-effort-word">{effort || 'default'}</span>;
  return (
    <span className="tc-effort" title={`Effort: ${effort}`}>
      <span className="tc-pips" aria-hidden="true">{[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= step ? 'on' : ''} />)}</span>
      <span className="tc-effort-word">{effort}</span>
    </span>
  );
}

// Each fact on the card is a label, a value, and (for effort and plan) a thin
// gauge under the value: effort as five steps, plan as its weekly usage.
function Fact({ label, value, title, gauge }) {
  return (
    <div className="tc-fact" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {gauge || <span className="tc-gauge none" aria-hidden="true" />}
    </div>
  );
}

function EffortGauge({ effort }) {
  const step = effortStep(effort);
  if (!step) return null;
  return <span className="tc-gauge steps" aria-hidden="true">{[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= step ? 'on' : ''} />)}</span>;
}

function UsageGauge({ usage }) {
  const pct = usage?.weeklyPct;
  if (!Number.isFinite(pct)) return null;
  return (
    <span className={`tc-gauge usage ${usageTone(pct)}${usage.stale ? ' stale' : ''}`} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
    </span>
  );
}

export function AgentCard({ member, now, profiles, selected, dim, onSelect }) {
  const identity = providerIdentity(member.provider);
  const profile = (profiles || []).find((p) => p.id === member.home);
  const warnings = member.warnings?.length || 0;
  const kind = member.status?.kind || 'idle';
  const usage = member.usage;
  const pct = usage?.weeklyPct;
  const planValue = (
    <span className="tc-plan">
      <PlanMark profile={profile} homeId={member.home} />
      {Number.isFinite(pct) ? <span className={`tc-plan-pct ${usageTone(pct)}`}>{Math.round(pct)}%</span> : member.home ? <span className="tc-usage-none">no reading</span> : null}
    </span>
  );
  return (
    <article className={`tc-card status-${kind}${selected ? ' selected' : ''}${dim ? ' dim' : ''}`} data-member-id={member.id}>
      <header className="tc-card-head">
        <span className="tc-logo"><img src={identity.logo} alt={identity.label} /></span>
        <div className="tc-ident">
          <button type="button" className="tc-open" onClick={() => onSelect(member.id)} aria-expanded={selected} title={member.name}>
            <span className="tc-name">{member.name}</span>
          </button>
          <span className="tc-role">{member.role ? `${member.role} · ${runModeText(member)}` : runModeText(member)}</span>
        </div>
        <div className="tc-marks">
          {warnings ? <span className="tc-warn-count" title={`${warnings} warning${warnings === 1 ? '' : 's'}; open the card to read`}><WarnIcon />{warnings}</span> : null}
          <CopySessionId sessionId={member.sessionId} className="tc-copy" />
        </div>
      </header>
      <dl className="tc-facts">
        <Fact label="Model" value={member.modelLabel || 'Not known yet'} title={member.model || undefined} />
        <Fact label="Effort" value={member.effort || 'default'} gauge={<EffortGauge effort={member.effort} />} />
        <Fact label="Plan" value={planValue} title={Number.isFinite(pct) ? usageTitle(usage, now) : undefined} gauge={<UsageGauge usage={usage} />} />
      </dl>
      <p className={`tc-desc${member.description ? '' : ' pending'}`}>
        <span className={`tc-status ${kind}`}><StatusIcon kind={kind} />{statusText(member.status, now)}</span>
        {member.description
          ? <span className="tc-desc-text">{member.description}</span>
          : member.lastPrompt ? <span className="tc-desc-text"><span className="tc-desc-lead">Latest request: </span>{member.lastPrompt}</span> : null}
      </p>
    </article>
  );
}

// A long-idle agent folded into its project's idle row: one line, still with
// its own Copy session id.
export function AgentChip({ member, now, onSelect, selected }) {
  const identity = providerIdentity(member.provider);
  return (
    <span className={`tc-chip${selected ? ' selected' : ''}`} data-member-id={member.id}>
      <img src={identity.logo} alt={identity.label} />
      <button type="button" className="tc-chip-open" onClick={() => onSelect(member.id)} title={member.name}>
        <span className="tc-chip-name">{member.name}</span>
        <span className="tc-chip-status"><StatusIcon kind={member.status?.kind} />{statusText(member.status, now)}</span>
      </button>
      <CopySessionId sessionId={member.sessionId} className="tc-copy" />
    </span>
  );
}
