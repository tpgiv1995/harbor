'use strict';

const fs = require('node:fs');
const path = require('node:path');

// NOTIFICATION CONTROLS. With OSC 7501 statuses flowing, the notifier fires
// for real (a window that finishes or needs you while you look elsewhere), so
// it gets an off switch (the app menu) and a per-window mute (the window
// header's bell). Kept in Harbor's cache dir, not config.json, which the setup
// wizard rewrites wholesale:
//   { "enabled": true, "muted": ["<session id>", ...] }
const MAX_MUTED = 500;

function createNotifyPrefs({ file, fsImpl = fs } = {}) {
  let enabled = true;
  let muted = new Set();
  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    enabled = raw?.enabled !== false;
    if (Array.isArray(raw?.muted)) muted = new Set(raw.muted.filter((id) => typeof id === 'string' && id).slice(-MAX_MUTED));
  } catch { /* first run, or unreadable: defaults */ }

  const snapshot = () => ({ enabled, muted: [...muted] });
  const save = () => {
    if (!file) return;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temporary, `${JSON.stringify(snapshot())}\n`);
      fsImpl.renameSync(temporary, file);
    } catch { /* a lost preference write is not worth a crash */ }
  };

  return {
    get: snapshot,
    enabled: () => enabled,
    isMuted: (sessionId) => Boolean(sessionId && muted.has(sessionId)),
    set({ enabled: on, sessionId, muted: mute } = {}) {
      if (typeof on === 'boolean') enabled = on;
      if (typeof sessionId === 'string' && sessionId && typeof mute === 'boolean') {
        if (mute) muted.add(sessionId); else muted.delete(sessionId);
        if (muted.size > MAX_MUTED) muted = new Set([...muted].slice(-MAX_MUTED));
      }
      save();
      return snapshot();
    },
  };
}

module.exports = { createNotifyPrefs, MAX_MUTED };
