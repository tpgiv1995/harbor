'use strict';

// When a usage window resets, in the two forms the rail needs: the compact
// inline badge and the full hover tooltip.
//
// Pat asked for the weekly reset TIME (2026-07-27): the meters showed a bare
// date ("7/31"), so a weekly window that reset at 8pm looked like it reset at
// some unknown moment on the 31st, and planning a long run around it meant
// guessing. The reset instant was never missing from the data: usage.js has
// carried `weeklyResetsAt` as full epoch seconds all along (the statusline tee
// and the OAuth endpoint both supply date AND time), and only the renderer
// threw the time away. So this is a formatting fix, not a plumbing one.
//
// Label and tooltip are built HERE, together, for the same reason the slash
// colouring and its badge share one classifier: two formatters drift, and a
// badge that disagrees with its own tooltip is worse than either alone.

const MS = 1000;

// "8pm", "3:30pm" — minutes only when they carry information, lowercase
// meridiem, no space. The rail clips its own content (it is deliberately
// overflow-proof), so every character has to earn its place.
function clockText(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const meridiem = hours < 12 ? 'am' : 'pm';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const mm = minutes ? `:${String(minutes).padStart(2, '0')}` : '';
  return `${hour12}${mm}${meridiem}`;
}

function dateText(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// How far out the reset is, in the coarsest unit that is still honest. Used in
// the tooltip only: "in 4d 2h" answers "can I start a long run?" faster than a
// wall-clock time the reader has to subtract from.
function relativeText(resetsAtMs, nowMs) {
  const deltaMs = resetsAtMs - nowMs;
  if (deltaMs <= 0) return 'now';
  const minutes = Math.floor(deltaMs / (60 * MS));
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `in ${hours}h ${restMinutes}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `in ${days}d ${restHours}h` : `in ${days}d`;
}

// The inline badge. A 5-hour window always resets today or tomorrow, so its
// time alone is unambiguous; a weekly window is days out, so it needs the date
// AND the time, which is the whole point of this module.
function resetBadge(resetsAt, { window = 'weekly', nowMs = Date.now() } = {}) {
  if (!resetsAt) return '';
  const date = new Date(resetsAt * MS);
  if (Number.isNaN(date.getTime())) return '';
  const clock = clockText(date);
  if (window === 'fiveHour') {
    // Past midnight the 5-hour reset is on a different DAY, and a bare "1am"
    // reads as thirteen hours ago instead of an hour from now.
    const sameDay = new Date(nowMs).toDateString() === date.toDateString();
    return sameDay ? clock : `${dateText(date)} ${clock}`;
  }
  return `${dateText(date)} ${clock}`;
}

const WINDOW_LABEL = { fiveHour: '5-hour window', weekly: 'weekly window' };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The hover text: the same instant spelled out, plus how far away it is. Never
// invents a percentage; when the percent is unknown the tooltip says so rather
// than implying zero.
function resetTooltip({
  window = 'weekly',
  pct = null,
  resetsAt = null,
  rolled = false,
  nowMs = Date.now(),
} = {}) {
  const parts = [WINDOW_LABEL[window] || WINDOW_LABEL.weekly];
  parts.push(typeof pct === 'number' && Number.isFinite(pct)
    ? `${Math.round(pct)}% used`
    : 'usage not reported yet');
  if (resetsAt) {
    const date = new Date(resetsAt * MS);
    if (!Number.isNaN(date.getTime())) {
      const when = `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} at ${clockText(date)}`;
      parts.push(`resets ${when} (${relativeText(date.getTime(), nowMs)})`);
    }
  }
  if (rolled) parts.push('window already reset; nothing used since');
  return parts.join(' · ');
}

module.exports = { resetBadge, resetTooltip, clockText, relativeText };
