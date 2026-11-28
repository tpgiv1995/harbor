'use strict';

// THREE-WAY MERGE FOR AN EDIT THAT STARTED FROM AN OLDER VALUE (2026-11-27, Pat: "I keep having
// mobile harbor overwrite harbor notes").
//
// A note or task edit used to carry only its new value, so a save replaced whatever the store held
// with no check that the field had changed since the edit began: a draft a phone had kept in its
// browser storage since Nov 23 wrote itself back over a live board note an agent keeps, and a
// phone editor that loaded the note once and saved the whole body on close dropped an edit made
// elsewhere while it was open (docs/BACKLOG.md, "Notes sync", 2026-11-25). An edit now also carries
// BASE, the value it started from. The reducer compares three values per field:
//   base:   what the editor showed before the user typed;
//   mine:   what the user wants now;
//   theirs: what the store holds now.
// theirs === base: nobody else changed it, mine wins. mine === base: the user did not change it,
// theirs stays. Both changed: text merges line by line when the two edits touch different lines;
// a set (tags) always merges; anything else is a conflict, and the caller keeps BOTH versions
// (a note keeps the user's version as its own note) rather than choosing one to lose.
//
// A base of null means "not known" (a draft stored before bases existed): it merges only when mine
// already equals theirs, otherwise it is a conflict. Pure and total: no input throws.

const EDIT_BASE_VERSION = 1;

// The line diff is an LCS table over the lines left after the common prefix and suffix are
// trimmed. Above this many cells the merge gives up and reports a conflict: a conflict keeps both
// versions, so giving up can never lose text, and the table stays under 16 MB.
const MAX_CELLS = 4000000;

function lines(text) {
  return String(text ?? '').split('\n');
}

// The hunks that turn base into side: base[start, end) is replaced by `lines`. Hunks from one diff
// never touch: each is followed by at least one line both sides share. null when too big to diff.
function diffHunks(base, side) {
  const n = base.length;
  const m = side.length;
  let pre = 0;
  while (pre < n && pre < m && base[pre] === side[pre]) pre += 1;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && base[n - 1 - suf] === side[m - 1 - suf]) suf += 1;
  const a = base.slice(pre, n - suf);
  const b = side.slice(pre, m - suf);
  if (!a.length && !b.length) return [];
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;
  const cols = b.length + 1;
  // t[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const t = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      t[i * cols + j] = a[i] === b[j]
        ? t[(i + 1) * cols + j + 1] + 1
        : Math.max(t[(i + 1) * cols + j], t[i * cols + j + 1]);
    }
  }
  const hunks = [];
  let open = null;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (open) { hunks.push(open); open = null; }
      i += 1; j += 1;
      continue;
    }
    if (!open) open = { start: pre + i, end: pre + i, lines: [] };
    if (j < b.length && (i >= a.length || t[i * cols + j + 1] >= t[(i + 1) * cols + j])) {
      open.lines.push(b[j]); j += 1;
    } else {
      i += 1; open.end = pre + i;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

/**
 * Merge two edits of one text. Changes that overlap OR TOUCH (no unchanged line between them, the
 * same rule git uses) merge only when both sides made the identical change; otherwise
 * { ok: false }. Returns { ok: true, text, merged } where merged says the result is neither input.
 */
function mergeText(baseText, mineText, theirsText) {
  const mine = String(mineText ?? '');
  const theirs = String(theirsText ?? '');
  if (mine === theirs) return { ok: true, text: mine, merged: false };
  if (baseText === null || baseText === undefined) return { ok: false };
  const baseStr = String(baseText);
  if (mine === baseStr) return { ok: true, text: theirs, merged: false };
  if (theirs === baseStr) return { ok: true, text: mine, merged: false };
  const base = lines(baseStr);
  const mineHunks = diffHunks(base, lines(mine));
  const theirHunks = diffHunks(base, lines(theirs));
  if (!mineHunks || !theirHunks) return { ok: false };
  const all = [
    ...mineHunks.map((hunk) => ({ ...hunk, side: 'mine' })),
    ...theirHunks.map((hunk) => ({ ...hunk, side: 'theirs' })),
  ].sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [];
  let pos = 0;
  let k = 0;
  while (k < all.length) {
    const group = [all[k]];
    const start = all[k].start;
    let end = all[k].end;
    k += 1;
    while (k < all.length && all[k].start <= end) {
      group.push(all[k]);
      end = Math.max(end, all[k].end);
      k += 1;
    }
    for (let p = pos; p < start; p += 1) out.push(base[p]);
    const render = (side) => {
      const result = [];
      let p = start;
      for (const hunk of group) {
        if (hunk.side !== side) continue;
        for (; p < hunk.start; p += 1) result.push(base[p]);
        result.push(...hunk.lines);
        p = hunk.end;
      }
      for (; p < end; p += 1) result.push(base[p]);
      return result;
    };
    const sides = new Set(group.map((hunk) => hunk.side));
    if (sides.size === 1) {
      out.push(...render(group[0].side));
    } else {
      const fromMine = render('mine');
      const fromTheirs = render('theirs');
      if (fromMine.join('\n') !== fromTheirs.join('\n')) return { ok: false };
      out.push(...fromMine);
    }
    pos = end;
  }
  for (let p = pos; p < base.length; p += 1) out.push(base[p]);
  const text = out.join('\n');
  return { ok: true, text, merged: text !== mine };
}

/** A single value (a title): only one side may have changed it. */
function mergeValue(base, mine, theirs, equal = Object.is) {
  if (equal(mine, theirs)) return { ok: true, value: mine, merged: false };
  if (base === null || base === undefined) return { ok: false };
  if (equal(mine, base)) return { ok: true, value: theirs, merged: false };
  if (equal(theirs, base)) return { ok: true, value: mine, merged: false };
  return { ok: false };
}

/**
 * A set (tags): the user's additions and removals applied to what the store holds now, so another
 * writer's additions survive. Compared by `key` (tags are case-insensitive), keeping theirs' order.
 */
function mergeSet(base, mine, theirs, key = (item) => item) {
  const mineList = Array.isArray(mine) ? mine : [];
  const theirList = Array.isArray(theirs) ? theirs : [];
  const keysOf = (list) => list.map(key);
  if (keysOf(mineList).join('\u0000') === keysOf(theirList).join('\u0000')) {
    return { ok: true, value: mineList, merged: false };
  }
  if (base === null || base === undefined || !Array.isArray(base)) return { ok: false };
  const baseKeys = new Set(keysOf(base));
  const mineKeys = new Set(keysOf(mineList));
  const removed = new Set(base.map(key).filter((k) => !mineKeys.has(k)));
  const value = theirList.filter((item) => !removed.has(key(item)));
  const have = new Set(keysOf(value));
  for (const item of mineList) {
    const k = key(item);
    if (!baseKeys.has(k) && !have.has(k)) { value.push(item); have.add(k); }
  }
  const merged = keysOf(value).join('\u0000') !== keysOf(mineList).join('\u0000');
  return { ok: true, value, merged };
}

module.exports = { EDIT_BASE_VERSION, MAX_CELLS, diffHunks, mergeSet, mergeText, mergeValue };
