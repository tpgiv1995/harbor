'use strict';

/**
 * Where a manual reorder actually lands.
 *
 * The rows on screen are NOT the sequence they are stored in: a star pins its
 * task to the top of My order (`starFirst` in tasks-model), so the rendered run
 * and the order run interleave. Two callers, and they know different things:
 *
 * - a DROP already names the row it landed on, so it only needs the index
 *   translating out of screen space into order space;
 * - an ALT+ARROW names a DIRECTION, so it has to resolve the visible neighbour
 *   FIRST. Stepping one slot in order space was right while the rendered
 *   sequence WAS the order; with a pin in play it can move a task past a row
 *   that is somewhere else on screen, which reads as nothing happening.
 *
 * A move ACROSS the pin is refused, both ways round. Nothing can be dragged
 * above a pinned row while it is pinned, and a pinned row cannot be pushed
 * below an ordinary one, so accepting either would write an order the screen
 * cannot show: the row would snap back, or (worse, and the reason this is a
 * rule rather than a nicety) travel the OPPOSITE way, because "before C" in
 * stored order is not "above C" on screen. The star is the pin; unstarring is
 * how a task comes back down.
 *
 * Returns `{ toIndex }` for `task.reorder`, or null for every move that is a
 * no-op: the end of the run, across the pin, a target in another branch (a drop
 * across branches is refused rather than becoming a surprise re-parent), or a
 * destination the task is already at.
 */
function planMove(options = {}) {
  const order = Array.isArray(options.order) ? options.order : [];
  const shown = Array.isArray(options.shown) && options.shown.length ? options.shown : order;
  const pinned = new Set(Array.isArray(options.pinned) ? options.pinned : []);
  const { taskId } = options;
  const from = order.indexOf(taskId);
  if (from < 0) return null;

  let targetId = options.targetId;
  let side = options.position;
  if (side === 'up' || side === 'down') {
    const at = shown.indexOf(taskId);
    if (at < 0) return null;
    targetId = shown[at + (side === 'up' ? -1 : 1)];
    if (!targetId) return null;
    side = side === 'up' ? 'before' : 'after';
  }
  if (pinned.has(taskId) !== pinned.has(targetId)) return null;

  const target = order.indexOf(targetId);
  if (target < 0) return null;
  let to = target + (side === 'after' ? 1 : 0);
  if (from < to) to -= 1;
  if (to === from || to < 0 || to >= order.length) return null;
  return { toIndex: to };
}

module.exports = { planMove };
