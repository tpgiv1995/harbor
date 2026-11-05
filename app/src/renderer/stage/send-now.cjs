'use strict';

// How many messages the command bar offers to "Send now": the human messages
// waiting in CLAUDE's own queue (header.queuedPending, mirrored from the
// transcript's queue-operation records), not Harbor's send queue. Offered only
// mid-turn on a pane Harbor drives: at idle Claude drains its queue itself, so
// a count there is a lagging tail, and a read-only or externally controlled
// pane takes no keys. Hidden while Harbor's own send is still typing or holds
// a queued item, because the chord landing mid-type would mix a half draft
// into the composer.
function sendNowCount({ header, provider, drivable, pending, queuedItem } = {}) {
  if (!drivable || !header?.working) return 0;
  if ((provider || 'claude') !== 'claude') return 0;
  if (pending || queuedItem) return 0;
  const count = Number(header.queuedPending);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

module.exports = { sendNowCount };
