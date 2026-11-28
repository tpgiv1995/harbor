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
//
// 2026-11-27 (Pat: "I keep having mobile harbor overwrite harbor notes"; docs/BACKLOG.md
// "Notes sync"): a field's pending value used to travel alone, so a save replaced whatever
// the store held, and a draft this device kept in storage since last week wrote itself over
// a newer note. Every pending field now also keeps its BASE, the value the editor showed
// before the user typed it (queue's third argument, recorded once per field until that field
// saves), stored beside the drafts under `<key>-base`, and every save sends it, so the
// store merges against what it holds now (shared/edit-merge.cjs) instead of overwriting it.
// A draft stored before bases existed has none: its fields load with a base of null ("not
// known"), which the store keeps only when it already matches, otherwise it keeps both
// versions. After a field saves while newer typing is still pending, that field's base
// becomes the value just sent: the store now holds that value (or that value merged with
// someone else's edit), and the newer typing continues from it.
const STALLED_MS = 4000;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// Loose on purpose: stale() only decides what an editor SHOWS when it opens; the store's
// three-way merge is what keeps the text, so a title's edge spaces or a tag's case must not
// turn a current draft into a stale one.
function looseEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const key = (list) => (Array.isArray(list) ? list : []).map((item) => String(item).trim().toLowerCase()).join('\n');
    return key(a) === key(b);
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b || a.trim() === b.trim();
  return a === b;
}

function createPendingPatches(send, { storage, key, onChange = () => {}, now = () => Date.now() } = {}) {
  const baseKey = `${key}-base`;
  const pending = new Map();
  const bases = new Map();
  const errors = new Map();
  const running = new Map();
  const changedAt = new Map();
  let storedBases = {};
  try { storedBases = plainObject(JSON.parse(storage?.getItem(baseKey) || '{}')) || {}; }
  catch { /* unreadable bases mean every restored field's base is unknown */ }
  try {
    for (const [id, patch] of Object.entries(JSON.parse(storage?.getItem(key) || '{}'))) {
      if (!plainObject(patch)) continue;
      pending.set(id, patch);
      changedAt.set(id, now());
      // A draft saved with this code has a base record (maybe empty: a star or a group move
      // carries none). A draft with NO record predates bases: every field's base is unknown.
      const known = plainObject(storedBases[id]);
      const base = {};
      for (const field of Object.keys(patch)) {
        if (!known) base[field] = null;
        else if (field in known) base[field] = known[field];
      }
      bases.set(id, base);
    }
  } catch { /* an unavailable draft cache does not disable editing */ }
  const changed = () => {
    try {
      storage?.setItem(key, JSON.stringify(Object.fromEntries(pending)));
      storage?.setItem(baseKey, JSON.stringify(Object.fromEntries([...pending.keys()].map((id) => [id, bases.get(id) || {}]))));
    } catch { /* retain the draft in memory if browser storage is full */ }
    onChange();
  };
  const queue = (id, patch, base) => {
    if (!id) return;
    pending.set(id, { ...pending.get(id), ...patch });
    const from = plainObject(base);
    if (from) {
      const known = { ...(bases.get(id) || {}) };
      for (const field of Object.keys(patch)) if (!(field in known) && field in from) known[field] = from[field];
      bases.set(id, known);
    }
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
        const known = bases.get(id) || {};
        const base = {};
        for (const field of Object.keys(patch)) if (field in known) base[field] = known[field];
        let result;
        try { result = await send(id, patch, Object.keys(base).length ? base : undefined); }
        catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
        if (!result?.ok) {
          const failure = { ...result, ok: false, fields: Object.keys(pending.get(id) || patch) };
          errors.set(id, failure); changed();
          return failure;
        }
        const rest = { ...pending.get(id) };
        const nextBase = { ...(bases.get(id) || {}) };
        for (const [field, value] of Object.entries(patch)) {
          if (rest[field] === value) { delete rest[field]; delete nextBase[field]; }
          else if (field in nextBase) nextBase[field] = value;
        }
        if (Object.keys(rest).length) { pending.set(id, rest); bases.set(id, nextBase); }
        else { pending.delete(id); bases.delete(id); }
        errors.delete(id); changed();
      }
      return { ok: true };
    }).finally(() => { running.delete(id); });
    running.set(id, request);
    return request;
  };
  // Is this draft older than the entity it would save over? A draft whose fields all started
  // from what the entity holds now is current: an editor shows it and saves it later. One whose
  // base differs from the entity (someone else saved since), or whose base is not known and
  // whose value differs, is stale: an editor must not show it AS the entity, and sends it
  // through the store's merge as it opens instead. Fields saved without a base (a star, a list)
  // are single decisions and never make a draft stale.
  const stale = (id, current) => {
    const patch = pending.get(id);
    if (!patch || !current) return false;
    const known = bases.get(id) || {};
    return Object.keys(patch).some((field) => field in known && (known[field] === null
      ? !looseEqual(patch[field], current[field])
      : !looseEqual(known[field], current[field])));
  };
  return { queue, flush, stale, pending: id => pending.get(id), base: id => bases.get(id), error: id => errors.get(id),
    needsAttention, STALLED_MS,
    discard(id) { pending.delete(id); bases.delete(id); errors.delete(id); changedAt.delete(id); changed(); } };
}

module.exports = { createPendingPatches };
