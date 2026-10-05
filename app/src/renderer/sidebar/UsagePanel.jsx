import React from 'react';
import { ProfileBadge } from '../providers.js';
import { profileStyle } from '../profiles.cjs';
import { formatRelative } from '../../shared/date-roll.js';
import { resetBadge, resetTooltip } from './usage-reset.cjs';
import './UsagePanel.css';

function UsageWindow({ label, window: period, pct, resetsAt, rolled }) {
  const hasUsage = typeof pct === 'number' && Number.isFinite(pct);
  const fill = hasUsage ? Math.max(0, Math.min(100, pct)) : 0;
  const reset = resetBadge(resetsAt, { window: period });
  const title = resetTooltip({ window: period, pct, resetsAt, rolled });
  return (
    <div className={`usage-window${hasUsage && pct >= 75 ? ' usage-window-warn' : ''}`} title={title}>
      <div className="usage-window-heading">
        <span>{label}</span>
        <strong>{hasUsage ? `${Math.round(pct)}% used` : 'Not reported'}</strong>
      </div>
      {hasUsage ? <div className="usage-track" aria-hidden="true"><span style={{ width: `${fill}%` }} /></div> : null}
      <div className="usage-reset">{reset ? `Resets ${reset}` : hasUsage ? 'Reset time not reported' : 'Usage data unavailable'}</div>
    </div>
  );
}

// A presentation-only view of the same per-profile usage payload. The parent
// owns refresh/subscription, so changing the layout adds no provider requests.
export function UsagePanel({ profiles, usage }) {
  if (!profiles.length) return null;
  return (
    <section className="usage-panel" aria-label="Plan usage">
      <div className="usage-panel-heading">Plan usage</div>
      {profiles.map(profile => {
        const data = usage[profile.id];
        const title = [
          `${profile.label}${data?.email ? `: ${data.email}` : ''}`,
          typeof data?.cost === 'number' ? `last session $${data.cost.toFixed(2)}` : null,
          data?.updatedAt ? `updated ${formatRelative(data.updatedAt)}` : null,
          data?.unavailable ? (data.reason || 'no data yet') : null,
        ].filter(Boolean).join(' · ');
        return (
          <div className="usage-account" key={profile.id} data-account={profile.id} style={profileStyle(profile)} title={title}>
            <div className="usage-account-heading">
              <ProfileBadge profileId={profile.id} profiles={profiles} className="usage-account-badge" title={profile.label} />
              <span className="usage-account-name">{profile.label}</span>
            </div>
            {data?.unavailable && data.reason ? <div className="usage-account-status" role="status">{data.reason}</div> : null}
            {profile.provider !== 'codex' ? <UsageWindow label="5 hours" window="fiveHour" pct={data?.fiveHourPct} resetsAt={data?.fiveHourResetsAt} rolled={data?.fiveHourRolled} /> : null}
            <UsageWindow label="Weekly" window="weekly" pct={data?.weeklyPct} resetsAt={data?.weeklyResetsAt} rolled={data?.weeklyRolled} />
          </div>
        );
      })}
    </section>
  );
}
