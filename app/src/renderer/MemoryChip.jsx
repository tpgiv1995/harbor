import React, { useEffect, useState } from 'react';

// THE MACHINE'S COMMIT METER, IN THE TITLE BAR (2026-09-05; Pat: "put it in
// the top banner where we have tons of real estate"). Windows kills a session
// at the COMMIT limit (RAM plus page file, promised not touched), never at
// "free RAM", and the two disagreed by 30 GB on the night this shipped. Main
// samples Electron's own memory info every 30s (providers/system-memory.js)
// and pushes it here. Amber from 75%, red from 85%, the line main toasts at.

function formatGB(mb) {
  return Number.isFinite(mb) ? `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GB` : '?';
}

export function MemoryChip() {
  const [sample, setSample] = useState(null);
  useEffect(() => {
    let alive = true;
    window.harbor.systemMemory?.get?.().then((s) => { if (alive && s) setSample(s); }).catch(() => {});
    const unsubscribe = window.harbor.systemMemory?.onUpdate?.((s) => { if (alive && s) setSample(s); }) || (() => {});
    return () => { alive = false; unsubscribe(); };
  }, []);
  if (!sample) return null;
  const pct = sample.commitPct;
  const tone = pct >= 85 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  const fill = Math.max(2, Math.min(100, pct));
  const tooltip = [
    `Memory commit: ${formatGB(sample.commitUsedMB)} of ${formatGB(sample.commitLimitMB)} (${Math.round(pct)}%)`,
    sample.physTotalMB ? `RAM in use: ${formatGB(sample.physUsedMB)} of ${formatGB(sample.physTotalMB)}` : null,
    'Commit is what Windows has promised to every process (RAM plus page file). At 100% allocations fail and sessions die silently; free RAM says nothing about it.',
  ].filter(Boolean).join('\n');
  return (
    <span className={`mem-chip tone-${tone}`} title={tooltip} aria-label={`Memory commit ${Math.round(pct)} percent`} data-mem-pct={Math.round(pct)}>
      <span className="mem-donut" style={{ background: `conic-gradient(currentColor ${fill}%, rgba(255,255,255,.12) 0)` }} aria-hidden="true"><span /></span>
      <span className="mem-label">
        <b>{Math.round(pct)}%</b>
        <em>{formatGB(sample.commitUsedMB)} / {formatGB(sample.commitLimitMB)} committed</em>
      </span>
    </span>
  );
}
