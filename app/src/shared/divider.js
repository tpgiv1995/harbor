// Synthetic regression fixtures model resize damage measured on 2026-10-03.
// A clipped UTF-8 box edge can contain a replacement character. Only long,
// overwhelmingly intact edges may tolerate it; prose can never be an edge.
export function isDividerLine(value, minimum = 8) {
  const line = String(value ?? '').trim();
  if (!line || /[^\u2500\u2501\u2014_\-\ufffd\ufffc]/u.test(line)) return false;
  const damaged = (line.match(/[\ufffd\ufffc]/gu) || []).length;
  const intact = line.length - damaged;
  if (!damaged) return intact >= minimum;
  return intact >= Math.max(minimum, 16) && damaged <= 3 && intact / line.length >= 0.9;
}

// A named session's prompt carries its name in the top edge (CLI 2.1.316); see
// divider.cjs. Only the composer's edge takes the name.
const NAMED_EDGE_RE = /^[─━]{8,} \S(?:.*\S)? [─━]+$/u;
export function isComposerEdge(value, minimum = 8) {
  return isDividerLine(value, minimum) || NAMED_EDGE_RE.test(String(value ?? '').trim());
}
