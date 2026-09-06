'use strict';

const MAX_LABEL_COUNT = 9;

function normalizedCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countLabel(count) {
  return count > MAX_LABEL_COUNT ? '9+' : String(count);
}

function sessionPhrase(count, state) {
  return `${count} ${count === 1 ? 'session' : 'sessions'} ${state}`;
}

function planTaskbarBadge(counts = {}) {
  const blocked = normalizedCount(counts.blocked);
  const finished = normalizedCount(counts.finished);
  const description = `${sessionPhrase(blocked, 'waiting for your answer')}; ${sessionPhrase(finished, 'finished')}`;

  if (blocked > 0) {
    return { kind: 'amber', count: blocked, label: countLabel(blocked), description };
  }
  if (finished > 0) {
    return { kind: 'accent', count: finished, label: countLabel(finished), description };
  }
  return { kind: 'clear', count: 0, label: '', description };
}

module.exports = { MAX_LABEL_COUNT, planTaskbarBadge };
