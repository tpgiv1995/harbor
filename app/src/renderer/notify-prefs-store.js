import { useEffect, useState } from 'react';

// Notification on/off and per-window mute, as main persists them
// (main/notify-prefs.js). One copy for the renderer, shared by the app menu and
// every window header, so a toggle in one place repaints the others.
let prefs = { enabled: true, muted: new Set() };
let loaded = null;
const listeners = new Set();

function apply(next) {
  if (!next) return;
  prefs = { enabled: next.enabled !== false, muted: new Set(next.muted || []) };
  for (const listener of listeners) listener(prefs);
}

function load() {
  if (!loaded) loaded = Promise.resolve(window.harbor?.notify?.getPrefs?.()).then(apply).catch(() => {});
  return loaded;
}

export async function setNotificationsEnabled(enabled) {
  apply(await window.harbor?.notify?.setPrefs?.({ enabled }));
}

export async function setSessionMuted(sessionId, muted) {
  if (!sessionId) return;
  apply(await window.harbor?.notify?.setPrefs?.({ sessionId, muted }));
}

export function useNotifyPrefs() {
  const [value, setValue] = useState(prefs);
  useEffect(() => {
    listeners.add(setValue);
    load().then(() => setValue(prefs));
    return () => listeners.delete(setValue);
  }, []);
  return value;
}
