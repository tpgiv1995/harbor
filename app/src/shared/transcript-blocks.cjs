'use strict';

// ONE BLOCK KEY IS ONE BUBBLE (2026-10-06, Pat on his phone: "messages appear to
// be sending and receiving twice in harbor", with a screenshot of the same
// queued message rendered twice).
//
// `transcript:update` carries a full `replace` or a delta (`append` new blocks,
// `changed` earlier ones). Every consumer applied an append by concatenating,
// so a block that was ALREADY on screen came back as a second copy whenever an
// append repeated it. The transcript itself was clean (its parser yields one
// bubble per message); the repeat happens in delivery: the phone's send queue
// lets a newer `replace` take an older one's slot, ahead of appends queued
// after that slot, so the client receives the full list (already holding the
// new message) and THEN the append that minted it. The phone opens every chat
// twice and each open broadcasts a replace, so this ordering was routine, not
// rare. server/transport/ws.js now drops the redundant appends at the source;
// this is the consumer-side half, so no ordering of pushes can ever draw one
// block twice: an appended key that is already present updates in place.
function applyTranscriptUpdate(blocks, update) {
  if (Array.isArray(update?.replace)) return update.replace;
  let next = Array.isArray(blocks) ? blocks : [];
  if (update?.changed?.length) {
    const byKey = new Map(update.changed.map((block) => [block.key, block]));
    next = next.map((block) => byKey.get(block.key) || block);
  }
  if (update?.append?.length) {
    const at = new Map(next.map((block, index) => [block.key, index]));
    const merged = next.slice();
    for (const block of update.append) {
      const index = at.get(block.key);
      if (index === undefined) {
        at.set(block.key, merged.length);
        merged.push(block);
      } else {
        merged[index] = block;
      }
    }
    next = merged;
  }
  return next;
}

module.exports = { applyTranscriptUpdate };
