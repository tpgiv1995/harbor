'use strict';

const { resetBadge, resetTooltip, relativeText } = require('./sidebar/usage-reset.cjs');
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function ago(value, nowMs = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'time unknown';
  const minutes = Math.max(0, Math.floor((nowMs - time) / 60000));
  if (minutes < 1) return '<1m ago';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function percentage(value) {
  if (!finite(value)) return 'unknown';
  if (value > 0 && value < 1) return '<1%';
  return `${Math.round(value)}%`;
}

function formatWindow(w, nowMs = Date.now()) {
  let label = { fiveHour: '5h', weekly: 'Week', monthly: 'Month' }[w.kind]
    || (finite(w.windowMinutes) ? `${w.windowMinutes}m` : 'Usage');
  if (finite(w.includedPct)) label = 'Included';
  const pct = percentage(w.usedPct);
  // Share the rail's compact clock text so reset times agree in both places.
  const instant = resetBadge(w.resetsAt, { window: w.kind, nowMs });
  let prefix = '';
  if (w.kind !== 'fiveHour' && w.resetsAt) {
    prefix = `${new Date(w.resetsAt * 1000).toLocaleDateString('en-US', { weekday: 'short' })} `;
  }
  let reset = w.rolled ? 'window reset' : 'reset unknown';
  if (instant) reset = `resets ${prefix}${instant}`;
  let tooltip;
  if (w.kind === 'fiveHour' || w.kind === 'weekly') {
    tooltip = resetTooltip({ window: w.kind, pct: w.usedPct, resetsAt: w.resetsAt, rolled: w.rolled, nowMs });
    // Keep the shared reset wording while preserving nonzero usage below 1%.
    if (w.usedPct > 0 && w.usedPct < 1) tooltip = tooltip.replace(`${Math.round(w.usedPct)}% used`, `${pct} used`);
  } else {
    const relative = instant ? ` (${relativeText(w.resetsAt * 1000, nowMs)})` : '';
    tooltip = `${label}: ${pct} used; ${reset}${relative}`;
  }
  if (finite(w.includedPct)) {
    const breakdown = [`Included ${percentage(w.includedPct)} used`];
    if (finite(w.autoPct)) breakdown.push(`Auto ${percentage(w.autoPct)} used`);
    if (finite(w.apiPct)) breakdown.push(`API ${percentage(w.apiPct)} used`);
    tooltip = `${breakdown.join('; ')}; ${reset}`;
    if (instant) tooltip += ` (${relativeText(w.resetsAt * 1000, nowMs)})`;
  }
  let color = 'var(--fnt)';
  if (finite(w.usedPct)) color = w.usedPct >= 75 ? 'var(--warn)' : 'var(--accent)';
  // CURSOR'S TWO POOLS (2026-11-24, OO 695): the blended "Included 8%" read as room while the frontier pool was
  // spent and every Opus, Sonnet, GPT, Gemini and Fable call refused. The row names both pools and the bar shows the
  // fuller one; a spent pool says "spent", never a small number.
  if (finite(w.apiPct) || finite(w.autoPct)) {
    const frontierSpent = finite(w.apiPct) && w.apiPct >= 100;
    const fuller = Math.max(finite(w.apiPct) ? w.apiPct : 0, finite(w.autoPct) ? w.autoPct : 0);
    const frontierText = frontierSpent ? 'Frontier spent' : `Frontier ${percentage(w.apiPct)}`;
    const relative = instant ? ` (${relativeText(w.resetsAt * 1000, nowMs)})` : '';
    return {
      label: `${frontierText} · Auto ${percentage(w.autoPct)}`,
      reset,
      tooltip: `Frontier models (Opus, Sonnet, GPT, Gemini, Fable) ${percentage(w.apiPct)} used${frontierSpent ? ', spent' : ''}; Auto and Composer ${percentage(w.autoPct)} used; ${reset}${relative}`,
      width: Math.max(0, Math.min(100, fuller)),
      color: fuller >= 75 ? 'var(--warn)' : 'var(--accent)',
    };
  }
  return {
    label: `${label} ${pct}`,
    reset,
    tooltip,
    // Keep the reported percentage in text even if the visual bar is full.
    width: finite(w.usedPct) ? Math.max(0, Math.min(100, w.usedPct)) : 0,
    color,
  };
}

function formatResets(resets) {
  if (!Number.isSafeInteger(resets?.available) || resets.available < 0) return 'Resets left: unknown';
  const date = resets.nextExpiresAt ? new Date(resets.nextExpiresAt * 1000) : null;
  let expiry = '';
  if (date && Number.isFinite(date.getTime())) {
    expiry = ` (next expires ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
  }
  return `Resets left: ${resets.available}${expiry}`;
}

module.exports = { ago, formatWindow, formatResets };
