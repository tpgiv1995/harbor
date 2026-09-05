'use strict';

function startLagMonitor(processName) {
  let expected = Date.now();
  const samples = [];
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expected - 16);
    samples.push(lag);
    if (samples.length > 600) samples.shift();
    expected = now + 16;
  }, 16);
  timer.unref?.();

  return () => {
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const avg = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
    clearInterval(timer);
    return { process: processName, count: sorted.length, avgMs: avg, p95Ms: p95 };
  };
}

module.exports = { startLagMonitor };
