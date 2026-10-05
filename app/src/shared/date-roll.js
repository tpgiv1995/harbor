export const DAY_ROLL_HOUR = 6;

export function parseLocalDateTime(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0'] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
}

export function displayDayFor(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() < DAY_ROLL_HOUR) d.setDate(d.getDate() - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function displayDayStart(date = new Date()) {
  const day = displayDayFor(date);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAY_ROLL_HOUR, 0, 0, 0);
}

export function displayDayStartForDateInput(yyyyMmDd) {
  const m = String(yyyyMmDd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), DAY_ROLL_HOUR, 0, 0, 0);
}

export function cutoffForFilter(filter, now = new Date()) {
  if (!filter || filter.kind === 'all') return null;
  if (filter.kind === 'today') return displayDayStart(now);
  if (filter.kind === 'rolling') {
    const days = filter.days;
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }
  if (filter.kind === 'since') {
    return displayDayStartForDateInput(filter.value);
  }
  return null;
}

export function formatRelative(lastActive, now = new Date()) {
  const dt = typeof lastActive === 'string' ? parseLocalDateTime(lastActive) : lastActive;
  if (!dt) return '';
  const diffMs = now.getTime() - dt.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 14) return `${diffDay}d ago`;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
