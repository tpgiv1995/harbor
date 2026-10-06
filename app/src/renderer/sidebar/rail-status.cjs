'use strict';

// ONE STATUS LIGHT PER RAIL ROW (2026-10-06). Pat: "feels like we should
// somehow combine these into 1 status spot and just have different colors for
// different status", then "we should definitely have a different indication
// for something not running vs something dormant". A row used to carry two
// dots: the run state before the provider logo, and a "needs your look" dot
// before the title (renderer/stage/unseen-completions.cjs), and the
// "finished" dot was the same blue as "working". This decides the ONE state
// the light shows, in the order Pat would act on them: an answer he owes,
// then work in flight, then a finished turn he has not seen, then a session
// that is merely ready, then one Harbor put to sleep, then nothing running.
// The project header's count (`.pg-attn`) still counts blocked and finished.

function railStatus({ runState = null, attention = null, dormant = false } = {}) {
  if (runState?.kind === 'blocked' || attention === 'blocked') {
    return { kind: 'blocked', label: 'Waiting on your answer' };
  }
  if (runState?.kind === 'running') {
    const verb = String(runState.label || '').trim();
    return { kind: 'running', label: verb && verb.toLowerCase() !== 'working' ? `Working: ${verb}` : 'Working' };
  }
  if (runState?.kind === 'background') {
    return { kind: 'background', label: `Running in the background: ${runState.label}`, detail: runState.tooltip || null };
  }
  if (attention === 'finished') return { kind: 'finished', label: 'Finished since you last looked' };
  if (runState?.kind === 'ready') return { kind: 'ready', label: 'Ready' };
  if (dormant) return { kind: 'dormant', label: 'Asleep: Harbor ended it after it sat idle. Open it to resume.' };
  return { kind: 'stopped', label: 'Not running' };
}

module.exports = { railStatus };
