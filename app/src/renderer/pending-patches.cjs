'use strict';

// Keep fields until their exact value is acknowledged. A newer field must not
// erase an older failed field, and an older success must not erase newer typing.
//
// 2026-09-20 ("typing in notes gives a flash of a message about 'unsaved changes'... on
// like every key you type"): "has a pending edit" is true from every keystroke until its
// debounced save lands 400 ms later, so a banner keyed on it flashed a sentence and a
// Retry button on each key. needsAttention is the banner's rule instead: a save that was
// REFUSED shows at once, and an edit still unsaved STALLED_MS after its LAST change is
// stuck (a hung save, or a draft restored from storage that nothing flushed). Ordinary
// typing restarts the window on every change, so it never trips it.
const STALLED_MS = 4000;

function createPendingPatches(send, { storage, key, onChange = () => {}, now = () => Date.now() } = {}) {
  const pending = new Map();
  const errors = new Map();
  const running = new Map();
  const changedAt = new Map();
  try {
    for (const [id, patch] of Object.entries(JSON.parse(storage?.getItem(key) || '{}'))) {
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) { pending.set(id, patch); changedAt.set(id, now()); }
    }
  } catch { /* an unavailable draft cache does not disable editing */ }
  const changed = () => {
    try { storage?.setItem(key, JSON.stringify(Object.fromEntries(pending))); }
    catch { /* retain the draft in memory if browser storage is full */ }
    onChange();
  };
  const queue = (id, patch) => {
    if (!id) return;
    pending.set(id, { ...pending.get(id), ...patch });
    changedAt.set(id, now());
    changed();
  };
  const needsAttention = (id) => {
    if (errors.has(id)) return true;
    if (!pending.has(id)) return false;
    return now() - (changedAt.get(id) ?? now()) >= STALLED_MS;
  };
  const flush = (id) => {
    if (running.has(id)) return running.get(id).then(result => result.ok ? flush(id) : result);
    const request = Promise.resolve().then(async () => {
      while (pending.has(id)) {
        const patch = { ...pending.get(id) };
        let result;
        try { result = await send(id, patch); }
        catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
        if (!result?.ok) {
          const failure = { ...result, ok: false, fields: Object.keys(pending.get(id) || patch) };
          errors.set(id, failure); changed();
          return failure;
        }
        const rest = { ...pending.get(id) };
        for (const [field, value] of Object.entries(patch)) if (rest[field] === value) delete rest[field];
        if (Object.keys(rest).length) pending.set(id, rest); else pending.delete(id);
        errors.delete(id); changed();
      }
      return { ok: true };
    }).finally(() => { running.delete(id); });
    running.set(id, request);
    return request;
  };
  return { queue, flush, pending: id => pending.get(id), error: id => errors.get(id), needsAttention, STALLED_MS,
    discard(id) { pending.delete(id); errors.delete(id); changedAt.delete(id); changed(); } };
}

module.exports = { createPendingPatches };
