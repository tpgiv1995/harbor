'use strict';

// The "Heavy lifting" setting in the title-bar plans menu (Pat, 2026-10-05,
// after an Astra run was launched on a GPT seat while his OpenAI plans were
// tight: "it'd be nice to almost have like a slider or something where i could
// set it to like a few different options on how much to lean on claude /
// openai"). Harbor saves the choice; Claude sessions read it (bin/harbor-lean,
// the guard hook, the session-start doctrine line) before they hand work to a
// GPT seat (an Astra run, a codex worker) or to Cursor.
//
// A lean is a DEFAULT side, not a wall (Pat, same day: "i'd rather the 'lean
// claude' and 'lean openai' would work where they auto-send stuff to the other
// plan but they would send specific tasks where the other plan tends to shine
// ... like for lean claude it should still send visual stuff and like image
// creation to openai"). So every task has a kind; a kind where one side is
// BETTER than the other goes to that side under every setting except Claude
// only, and everything else follows the setting. Better, not merely good (Pat,
// same evening: "i dont want this to be stuff its good at i want it to be stuff
// its better at than claude"): a kind joins a side only with a reason that side
// wins, recorded as its `why`. Writing, planning and judgement are general
// work because nothing here shows Claude beating GPT-6 at them.
//
// Cursor is a third budget with a different rule (Pat, same evening: "i feel
// like we should be using more cursor for mechanical work - we barely touch my
// usage on that"). Mechanical work goes to Cursor not because Cursor is better
// at it but because Cursor's plan sits nearly unused and the work needs no
// judgement; Claude reviews what comes back. It goes there under every setting
// except Claude only, while Cursor's monthly use is under 90% and known. Never
// complex work dressed as mechanical (Pat: "i dont want it to force feed
// mechanical work to cursor if its heavily complex"): mechanical means every
// change is the same decided edit and a simple check proves the result. A job
// where changes need judgement one by one, alter behavior (semantics, data,
// security, concurrency), cross interacting modules, or have no simple check is
// `complex`, and routes as general work instead.
//
// Balanced keeps general work on Claude, large or not (Pat, 2026-10-18: "work
// should go where it is best done (visual / image stuff goes to gpt, pretty
// much all else goes to claude)"). From 2026-10-05 it had sent a large general
// job to a GPT seat whenever one sat under 50%; Pat called that rule temporary,
// and it is gone. So under Balanced only the better-side kinds cross over:
// images to a GPT seat, simple mechanical work to Cursor.
//
// One more route is set per PROJECT, not per setting (Pat, 2026-11-23, after
// upgrading Cursor to its top plan: test-backed builds for one project go to
// Cursor, his other projects stay as they are). The kind is `build`: a code
// change that starts from a failing test, carries a --check, and is read whole
// by a Claude reviewer. Those three are what make a real build safe to hand
// over, so the kind needs no "better than Claude" claim; like mechanical work it
// rides on an idle budget and Pat's explicit word. A project with the override
// (the `projects` list in the setting file, shown and switched in the plans
// menu) sends `build` to Cursor under every setting except Claude only while
// Cursor's month is known and under 90%. Anywhere else, `build` is general work,
// and no other kind changes.
//
// Pure on purpose: the renderer imports this file, so no fs here. The file
// itself is read and written by main/providers/provider-lean.js.

const LEAN_MODES = Object.freeze([
  Object.freeze({
    id: 'claude-only',
    label: 'Claude only',
    detail: 'Claude does all the work. No Astra runs, GPT or Cursor workers.',
  }),
  Object.freeze({
    id: 'lean-claude',
    label: 'Lean Claude',
    detail: 'Claude does the work. Images go to a GPT seat, mechanical work to Cursor.',
  }),
  Object.freeze({
    id: 'balanced',
    label: 'Balanced',
    detail: 'Each task goes where it is best done: images to a GPT seat, mechanical work to Cursor, everything else on Claude.',
  }),
  Object.freeze({
    id: 'lean-openai',
    label: 'Lean OpenAI',
    detail: 'GPT seats do most work. Connected work and reviews stay on Claude.',
  }),
]);

// The task kinds, each with where it goes and why. `side: null` is general
// work, which follows the setting. bin/harbor-lean --task <id> routes one of
// these, and the guard hook lets a launch tagged HARBOR_LEAN_TASK=<kind> through
// under Lean Claude when the kind belongs on that launch's side, and refuses
// every other launch there (it never asks Pat, 2026-10-05).
const TASK_KINDS = Object.freeze([
  Object.freeze({
    id: 'image', side: 'gpt', label: 'Image work',
    detail: 'creating or editing images, including mockups and icons',
    why: 'Claude cannot create or edit images; a GPT seat can.',
  }),
  Object.freeze({
    id: 'mechanical', side: 'cursor', label: 'Mechanical work',
    detail: 'boilerplate, scaffolding, wide renames and find-and-replace edits, format conversions, applying a decided pattern across many files; only when every change is the same and a simple check proves it',
    why: "Cursor's plan sits nearly unused and this work needs no judgement; Claude reviews the result.",
  }),
  // side null: general work, except in a project whose override sends it to
  // Cursor (`projectWhy` is that route's reason).
  Object.freeze({
    id: 'build', side: null, label: 'Test-backed builds',
    detail: 'a code change that starts from a failing test, carries a --check, and is read whole by a Claude reviewer',
    why: null,
    projectWhy: 'each one starts from a failing test, carries a check, and a Claude reviewer reads it whole.',
  }),
  Object.freeze({
    id: 'connected', side: 'claude', label: 'Connected work',
    detail: 'claude.ai connectors (Teams, Outlook, Dropbox and the rest), live browser checks, deploys',
    why: 'GPT seats and Cursor cannot reach the connectors, the live browser or deploys.',
  }),
  Object.freeze({
    id: 'review', side: 'claude', label: 'Reviewing worker output',
    detail: 'checking what a GPT seat or Cursor produced',
    why: 'A different model catches mistakes the author misses.',
  }),
  Object.freeze({
    id: 'general', side: null, label: 'Everything else',
    detail: 'coding, writing, planning, research, data work',
    why: null,
  }),
]);

const DEFAULT_LEAN = 'balanced';
const GPT_MAX_PCT = 90;
const CURSOR_MAX_PCT = 90;

function normalizeLean(value) {
  return LEAN_MODES.some((mode) => mode.id === value) ? value : DEFAULT_LEAN;
}

function leanMode(value) {
  return LEAN_MODES.find((mode) => mode.id === normalizeLean(value));
}

function taskKind(value) {
  return TASK_KINDS.find((kind) => kind.id === value) || TASK_KINDS.find((kind) => kind.id === 'general');
}

// The per-project overrides from the setting file, read defensively: an entry
// needs an id, a label, at least one folder and the one route that exists
// (`build: 'cursor'`); a repeated id keeps the first. Only an explicit
// `enabled: false` switches one off. Unknown fields pass through untouched.
function normalizeProjects(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const folders = Array.isArray(entry.folders)
      ? entry.folders.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
      : [];
    if (!id || !label || !folders.length || entry.build !== 'cursor' || seen.has(id)) continue;
    seen.add(id);
    out.push({
      ...entry,
      id,
      label,
      folders,
      build: 'cursor',
      enabled: entry.enabled !== false,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    });
  }
  return out;
}

// Folder comparison without node:path (the renderer imports this file). Either
// slash works; a drive-letter path compares without case, as Windows does; a
// `*` matches within one folder name (slot-*). A folder matches a pattern when
// it is that folder or anything inside it.
const pathParts = (value) => String(value).trim().replace(/\//g, '\\').replace(/\\+$/, '').split(/\\+/);
const segmentRx = new Map();
function segmentMatches(pattern, name) {
  if (!pattern.includes('*')) return pattern === name;
  let rx = segmentRx.get(pattern);
  if (!rx) {
    rx = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\]*')}$`);
    segmentRx.set(pattern, rx);
  }
  return rx.test(name);
}
function folderMatches(pattern, folder) {
  if (typeof pattern !== 'string' || typeof folder !== 'string' || !pattern.trim() || !folder.trim()) return false;
  const anyCase = /^[a-z]:/i.test(pattern.trim()) || /^[a-z]:/i.test(folder.trim());
  const fold = (s) => (anyCase ? s.toLowerCase() : s);
  const want = pathParts(fold(pattern));
  const have = pathParts(fold(folder));
  return have.length >= want.length && want.every((part, i) => segmentMatches(part, have[i]));
}

// The project a folder belongs to (switched on or off), or null.
function matchProject(projects, folder) {
  if (!Array.isArray(projects)) return null;
  return projects.find((p) => p && Array.isArray(p.folders) && p.folders.some((f) => folderMatches(f, folder))) || null;
}

function pctText(pct) {
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

const finitePct = (value) => typeof value === 'number' && Number.isFinite(value);

const hasReset = (seat) => Number.isSafeInteger(seat.resetsAvailable) && seat.resetsAvailable > 0;

// A seat holding a reset is not out (Pat's standing rule, 2026-09-16: spend a
// GPT plan's resets before any of its work goes to Claude), so it never counts
// as capped, and when no seat has room by its weekly number the emptiest seat
// with a reset is the `spare`: the work goes there and the reset is applied
// when the seat actually runs out. Until 2026-10-13 resets were invisible here
// and a capped seat with one waiting sent its work to Claude.
function seatFacts(seats) {
  const known = (Array.isArray(seats) ? seats : []).filter((seat) => seat && finitePct(seat.weeklyPct));
  const byPct = (a, b) => a.weeklyPct - b.weeklyPct;
  const best = known.slice().sort(byPct)[0] || null;
  const spare = known.filter(hasReset).sort(byPct)[0] || null;
  return { best, spare, open: best && best.weeklyPct < GPT_MAX_PCT ? best : null };
}

function spareReason(seat) {
  const n = seat.resetsAvailable;
  return `${seat.label} is ${pctText(seat.weeklyPct)} used but has ${n} reset${n === 1 ? '' : 's'} waiting; apply one when it runs out.`;
}

const cursorHasRoom = (cursor) => Boolean(cursor && finitePct(cursor.monthlyPct) && cursor.monthlyPct < CURSOR_MAX_PCT);

// Why Cursor cannot take work right now: full, signed out, or unreadable.
function cursorMissReason(cursor) {
  if (cursor && finitePct(cursor.monthlyPct)) return `Cursor is at least ${CURSOR_MAX_PCT}% used this month.`;
  if (cursor?.signedOut) return 'Cursor is signed out; sign it in again with cursor-agent login.';
  return "Cursor's usage could not be read.";
}

// One task's route. seats: [{ label, weeklyPct }] for the codex homes; cursor:
// { label, monthlyPct } or null. Unknown usage never qualifies, so missing data
// always lands on Claude (or, for mechanical work, on the general rule).
// `large` is still accepted from older callers (bin/harbor-lean --large) but no
// setting reads it since 2026-10-18. `complex` takes mechanical work off
// Cursor: it routes as general work, with the reason. `project` is the
// override the work's folder belongs to (matchProject), read only by `build`.
// Returns { side: 'claude' | 'gpt' | 'cursor', seat, kind, reason }, plus
// `project` (the override's id, or null) for a build.
function leanRoute(mode, kindId, seats, { large = false, cursor = null, complex = false, project = null } = {}) {
  const id = normalizeLean(mode);
  const kind = taskKind(kindId);
  const { best, open, spare } = seatFacts(seats);
  const claude = (reason) => ({ side: 'claude', seat: null, kind: kind.id, reason });
  const gpt = (seat, reason) => ({ side: 'gpt', seat, kind: kind.id, reason });
  if (kind.id === 'build') {
    // A build is general work unless its project's override sends it to
    // Cursor, and even then Claude only wins and a full or unreadable Cursor
    // hands it back to the general rule, with the reason.
    const general = leanRoute(id, 'general', seats, { large });
    const override = project && project.build === 'cursor' && project.enabled !== false ? project : null;
    if (!override) return { ...general, kind: kind.id, project: null };
    if (id === 'claude-only') return { ...general, kind: kind.id, project: override.id };
    if (cursorHasRoom(cursor)) {
      return { side: 'cursor', seat: cursor, kind: kind.id, project: override.id, reason: `${override.label} sends test-backed builds to Cursor: ${kind.projectWhy}` };
    }
    return { ...general, kind: kind.id, project: override.id, reason: `${cursorMissReason(cursor)} ${general.reason}` };
  }
  if (id === 'claude-only') return claude('Heavy lifting is Claude only.');
  if (kind.side === 'claude') return claude(kind.why);
  if (kind.side === 'cursor') {
    if (cursorHasRoom(cursor) && !complex) {
      return { side: 'cursor', seat: cursor, kind: kind.id, reason: kind.why };
    }
    // Too complex for Cursor, or Cursor full or unreadable: the work is
    // ordinary general work again.
    const fallback = leanRoute(id, 'general', seats, { large });
    const why = complex ? 'Too complex for Cursor: the changes need judgement or a hard-to-check result.' : cursorMissReason(cursor);
    return { ...fallback, kind: kind.id, reason: `${why} ${fallback.reason}` };
  }
  if (kind.side === 'gpt' || id === 'lean-openai') {
    if (open) return gpt(open, kind.side === 'gpt' ? kind.why : 'Heavy lifting leans OpenAI.');
    if (spare) return gpt(spare, spareReason(spare));
    return claude(best ? `Every GPT seat is at least ${GPT_MAX_PCT}% used.` : 'No GPT seat usage is known.');
  }
  if (id === 'lean-claude') return claude('Heavy lifting leans Claude.');
  return claude('Balanced keeps general work on Claude, where it is best done.');
}

// Where a route lands, as a row: { label, target, note }.
function routeRow(label, route) {
  if (route.side === 'gpt') {
    const n = hasReset(route.seat) ? route.seat.resetsAvailable : 0;
    return { label, target: route.seat.label, note: `${pctText(route.seat.weeklyPct)} used this week${n ? `, ${n} reset${n === 1 ? '' : 's'} waiting` : ''}` };
  }
  if (route.side === 'cursor') return { label, target: route.seat.label || 'Cursor', note: `${pctText(route.seat.monthlyPct)} used this month` };
  return { label, target: 'Claude', note: null };
}

// The whole setting at a glance, for the menu's "Right now" rows and
// bin/harbor-lean: { rows: [{ label, target, note }], summary, gpt, seat }.
// gpt is 'off' (nothing goes to a GPT seat), 'image' (only image work does)
// or 'prefer' (most work).
function leanVerdict(mode, seats, cursor = null) {
  const id = normalizeLean(mode);
  const rows = [];
  let gpt = 'off';
  let seat = null;
  if (id === 'claude-only') {
    rows.push({ label: 'All work', target: 'Claude', note: null });
  } else {
    // A row that missed its usual destination says why, in its first sentence.
    const why = (route) => route.reason.split('. ')[0].replace(/\.$/, '');
    const image = leanRoute(id, 'image', seats);
    rows.push(image.side === 'gpt' ? routeRow('Image work', image) : { ...routeRow('Image work', image), note: why(image) });
    if (image.side === 'gpt') {
      gpt = 'image';
      seat = image.seat;
    }
    const mechanical = leanRoute(id, 'mechanical', seats, { cursor });
    rows.push(mechanical.side === 'cursor' ? routeRow('Simple mechanical work', mechanical) : { ...routeRow('Simple mechanical work', mechanical), note: why(mechanical) });
    if (id === 'lean-openai') {
      rows.push({ label: 'Connected work and reviews', target: 'Claude', note: null });
      const general = leanRoute(id, 'general', seats);
      rows.push(routeRow('Everything else', general));
      if (general.side === 'gpt') {
        gpt = 'prefer';
        seat = general.seat;
      }
    } else {
      rows.push({ label: 'Everything else', target: 'Claude', note: null });
    }
  }
  const summary = rows.map((row) => `${row.label}: ${row.target}${row.note ? ` (${row.note})` : ''}.`).join(' ');
  return { gpt, seat, rows, summary };
}

// One row per project override, for the plans menu and bin/harbor-lean: where
// that project's test-backed builds go right now, or why not.
// [{ id, label, enabled, folders, target, note }].
function projectRows(mode, seats, cursor, projects) {
  return normalizeProjects(projects).map((project) => {
    const route = leanRoute(mode, 'build', seats, { cursor, project });
    const row = routeRow(project.label, route);
    let note = row.note;
    if (!project.enabled) note = 'Off: builds route as general work';
    else if (route.side !== 'cursor') note = route.reason.split('. ')[0].replace(/\.$/, '');
    return { id: project.id, label: project.label, enabled: project.enabled, folders: project.folders, target: row.target, note };
  });
}

// The weekly window and reset credits of each codex plan, in the shape
// plan-usage.js returns.
function seatsFromPlans(plans) {
  return (Array.isArray(plans) ? plans : [])
    .filter((plan) => plan && plan.provider === 'codex')
    .map((plan) => {
      const weekly = (plan.windows || []).find((w) => w && w.kind === 'weekly');
      const available = plan.resets && plan.resets.available;
      return {
        label: plan.label,
        weeklyPct: plan.unavailable || !weekly ? null : weekly.usedPct,
        resetsAvailable: Number.isSafeInteger(available) && available >= 0 ? available : null,
      };
    });
}

// Cursor's monthly included usage from the same payload, or null.
function cursorFromPlans(plans) {
  const plan = (Array.isArray(plans) ? plans : []).find((p) => p && p.provider === 'cursor');
  if (!plan) return null;
  const monthly = (plan.windows || []).find((w) => w && w.kind === 'monthly');
  return {
    label: plan.label || 'Cursor',
    monthlyPct: plan.unavailable || !monthly ? null : monthly.usedPct,
    signedOut: Boolean(plan.signedOut),
  };
}

module.exports = {
  LEAN_MODES,
  TASK_KINDS,
  DEFAULT_LEAN,
  GPT_MAX_PCT,
  CURSOR_MAX_PCT,
  normalizeLean,
  leanMode,
  taskKind,
  normalizeProjects,
  folderMatches,
  matchProject,
  leanRoute,
  leanVerdict,
  projectRows,
  seatsFromPlans,
  cursorFromPlans,
};
