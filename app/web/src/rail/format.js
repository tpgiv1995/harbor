export function formatRelative(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

