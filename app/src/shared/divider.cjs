'use strict';

// Synthetic regression fixtures model resize damage measured on 2026-10-03.
// A clipped UTF-8 box edge can contain a replacement character. Only long,
// overwhelmingly intact edges may tolerate it; prose can never be an edge.
function isDividerLine(value, minimum = 8) {
  const line = String(value ?? '').trim();
  if (!line || /[^\u2500\u2501\u2014_\-\ufffd\ufffc]/u.test(line)) return false;
  const damaged = (line.match(/[\ufffd\ufffc]/gu) || []).length;
  const intact = line.length - damaged;
  if (!damaged) return intact >= minimum;
  return intact >= Math.max(minimum, 16) && damaged <= 3 && intact / line.length >= 0.9;
}

module.exports = { isDividerLine };
