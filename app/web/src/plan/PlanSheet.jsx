import React from 'react';
import resetFormat from '../../../src/renderer/sidebar/usage-reset.cjs';
import { useUsage } from './use-usage.js';
import './plan.css';

const { resetBadge, resetTooltip } = resetFormat;
// Labels for the profile ids Harbor has historically shipped. A machine can
// carry any profile id at all (they are DISCOVERED from the config homes that
// exist, see main/config/homes.js), so this is a display courtesy and never the
// list of accounts: an id with no entry renders under its own name.
const LABELS = { personal: 'Personal', team: 'Team' };
const titleCase = (id) => String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (value) => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—';

function Meter({ label, value, resetsAt, rolled, kind }) {
  return <div className="plan-meter" title={resetTooltip({ window: kind, pct: value, resetsAt, rolled })}>
    <span>{label}</span><strong>{pct(value)}</strong><time>{resetBadge(resetsAt, { window: kind }) || (rolled ? 'reset' : 'reset unavailable')}</time>
  </div>;
}

export function PlanSheet({ open, onClose, client, session }) {
  const { usage, emails, error } = useUsage(client, open);
  if (!open) return null;
  const current = session?.home || session?.account || session?.detectedHome || null;
  // ONLY accounts this machine actually reports. Seeding a fixed trio here drew
  // a "Team" and a "Third" card with empty meters and "Email unavailable" for
  // every user who has one config home, which is most of them: phantom accounts
  // that read as broken meters rather than as absent accounts.
  const ids = [...new Set([...Object.keys(usage), ...Object.keys(emails)])];
  return <div className="mobile-sheet-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <section className="mobile-sheet plan-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-title">
      <header className="mobile-sheet-head"><div><span>ACCOUNTS</span><h2 id="plan-title">Plans</h2></div><button type="button" onClick={onClose} aria-label="Close">×</button></header>
      <div className="mobile-sheet-scroll">
        {error ? <p className="sheet-error" role="alert">{error}</p> : null}
        <div className="plan-list">{ids.map((id) => { const data = usage[id] || {}; const active = current === id; return <article className={`plan-card${active ? ' active' : ''}`} key={id}>
          <header><div><strong>{LABELS[id] || titleCase(id)}</strong>{active ? <span>THIS SESSION</span> : null}</div><small>{data.email || emails[id] || 'Email unavailable'}</small></header>
          <Meter label="5 hour" value={data.fiveHourPct} resetsAt={data.fiveHourResetsAt} rolled={data.fiveHourRolled} kind="fiveHour" />
          <Meter label="Weekly" value={data.weeklyPct} resetsAt={data.weeklyResetsAt} rolled={data.weeklyRolled} kind="weekly" />
        </article>; })}</div>
        <p className="plan-footnote">Choose a plan when starting a session. A live session stays attached to the account that owns it.</p>
      </div>
    </section>
  </div>;
}
