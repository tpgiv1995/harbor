import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import patches from './pending-patches.cjs';

export function usePendingPatches(kind, id, mutate) {
  const [, render] = useState(0);
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const edits = useMemo(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* memory still retains edits */ }
    return patches.createPendingPatches((entityId, patch) => mutateRef.current({
      type: `${kind}.update`, [`${kind}Id`]: entityId, patch,
    }), { storage, key: `harbor-pending-${kind}-edits`, onChange: () => render(value => value + 1) });
  }, [kind]);
  const queue = useCallback(fields => edits.queue(id, fields), [edits, id]);
  const flush = useCallback(() => edits.flush(id), [edits, id]);
  const failure = edits.error(id);
  const labels = { starred: 'importance', myDay: 'My Day', dueDate: 'due date', listId: 'list', groupId: 'group' };
  const error = failure ? `Unsaved ${failure.fields.map(field => labels[field] || field).join(', ')}: ${failure.reason || 'the change was refused'}` : null;
  // The save banner asks needsAttention, never hasPending (see pending-patches.cjs: every
  // keystroke is "pending" for its 400 ms debounce, and a banner keyed on that flashed on
  // each key). A stuck edit becomes visible by time alone, so ONE timer per change looks
  // again once the stall window has passed. queue() replaces the pending object, so its
  // identity restarts the wait on every keystroke and a save clears it. It is a one-shot,
  // not a loop: nothing is armed while nothing is pending.
  const pendingNow = edits.pending(id);
  useEffect(() => {
    if (!pendingNow) return undefined;
    const timer = setTimeout(() => render(value => value + 1), edits.STALLED_MS + 50);
    return () => clearTimeout(timer);
  }, [edits, pendingNow]);
  return { queue, flush, draft: pendingNow || {}, error, hasPending: Boolean(pendingNow),
    needsAttention: edits.needsAttention(id),
    pending: entityId => edits.pending(entityId), discard: entityId => edits.discard(entityId) };
}
