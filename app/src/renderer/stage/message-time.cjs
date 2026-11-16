'use strict';

// The time on each prompt and reply in a conversation window (2026-11-16, Pat:
// "would love to have time stamps on messages in harbor (from the agents + from
// me) ... needs to be in my timezone"). Every block already carries the
// transcript record's own timestamp (`ts`, UTC ISO from transcript.js); this
// only prints it in the machine's time zone, as short as the date allows:
//
//   today            3:38 PM
//   yesterday        Yesterday 3:38 PM
//   within 6 days    Mon 3:38 PM
//   this year        Nov 9, 3:38 PM
//   older            Nov 9, 2025, 3:38 PM
//
// and the hover title carries the whole thing with the zone
// ("Monday, November 16, 2026 at 3:38:12 PM CST"). `timeZone` and `locale` are
// for tests; the app passes neither, so the system zone and locale apply and a
// laptop that travels shows local time wherever it is.

const DAY_MS = 86_400_000;
const formatters = new Map();

function formatter(locale, timeZone, options) {
  const key = `${locale || ''}|${timeZone || ''}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, timeZone ? { ...options, timeZone } : options);
    formatters.set(key, f);
  }
  return f;
}

// The calendar day a moment falls on in the zone, as a UTC midnight count, so
// two moments compare by whole days whatever the zone's offset or DST.
function dayNumber(ms, locale, timeZone) {
  const parts = formatter('en-US', timeZone, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS);
}

function messageTime(ts, { now = Date.now(), locale, timeZone } = {}) {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const time = formatter(locale, timeZone, { hour: 'numeric', minute: '2-digit' }).format(ms);
  const title = formatter(locale, timeZone, { dateStyle: 'full', timeStyle: 'long' }).format(ms);
  const days = dayNumber(now, locale, timeZone) - dayNumber(ms, locale, timeZone);
  let label;
  if (days === 0) label = time;
  else if (days === 1) label = `Yesterday ${time}`;
  else if (days > 1 && days < 7) label = `${formatter(locale, timeZone, { weekday: 'short' }).format(ms)} ${time}`;
  else {
    const sameYear = formatter('en-US', timeZone, { year: 'numeric' }).format(ms) === formatter('en-US', timeZone, { year: 'numeric' }).format(now);
    const date = formatter(locale, timeZone, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(ms);
    label = `${date}, ${time}`;
  }
  return { label, title, iso: new Date(ms).toISOString() };
}

// A key for the machine's current calendar day; a window re-renders its labels
// when it changes, so "3:38 PM" becomes "Yesterday 3:38 PM" after midnight.
function localDayKey(now = Date.now(), timeZone) {
  return String(dayNumber(now, undefined, timeZone));
}

// One timer for every conversation view (desktop windows and the phone), armed
// for the next local midnight while anyone listens: subscribeDay/currentDay fit
// React's useSyncExternalStore.
const dayListeners = new Set();
let dayKey = null;
let dayTimer = null;
function armDayTimer() {
  clearTimeout(dayTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  dayTimer = setTimeout(() => {
    dayKey = localDayKey();
    for (const listener of dayListeners) listener();
    armDayTimer();
  }, next.getTime() - now.getTime());
}
function subscribeDay(listener) {
  dayListeners.add(listener);
  if (dayListeners.size === 1) armDayTimer();
  return () => {
    dayListeners.delete(listener);
    if (dayListeners.size === 0) clearTimeout(dayTimer);
  };
}
function currentDay() {
  if (dayKey === null || dayListeners.size === 0) dayKey = localDayKey();
  return dayKey;
}

module.exports = { messageTime, localDayKey, subscribeDay, currentDay };
