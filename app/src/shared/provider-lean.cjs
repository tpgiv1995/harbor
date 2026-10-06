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
    detail: 'Each task goes where it does best. Large general jobs go to a GPT seat with room.',
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
const BALANCED_MAX_PCT = 50;
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

function pctText(pct) {
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

const finitePct = (value) => typeof value === 'number' && Number.isFinite(value);

function seatFacts(seats) {
  const known = (Array.isArray(seats) ? seats : []).filter((seat) => seat && finitePct(seat.weeklyPct));
  const best = known.slice().sort((a, b) => a.weeklyPct - b.weeklyPct)[0] || null;
  const capped = known.filter((seat) => seat.weeklyPct >= 100);
  return { best, capped, open: best && best.weeklyPct < GPT_MAX_PCT ? best : null };
}

// One task's route. seats: [{ label, weeklyPct }] for the codex homes; cursor:
// { label, monthlyPct } or null. Unknown usage never qualifies, so missing data
// always lands on Claude (or, for mechanical work, on the general rule).
// `large` matters only for general work under Balanced. `complex` takes
// mechanical work off Cursor: it routes as general work, with the reason.
// Returns { side: 'claude' | 'gpt' | 'cursor', seat, kind, reason }.
function leanRoute(mode, kindId, seats, { large = false, cursor = null, complex = false } = {}) {
  const id = normalizeLean(mode);
  const kind = taskKind(kindId);
  const { best, capped, open } = seatFacts(seats);
  const claude = (reason) => ({ side: 'claude', seat: null, kind: kind.id, reason });
  const gpt = (seat, reason) => ({ side: 'gpt', seat, kind: kind.id, reason });
  if (id === 'claude-only') return claude('Heavy lifting is Claude only.');
  if (kind.side === 'claude') return claude(kind.why);
  if (kind.side === 'cursor') {
    const room = cursor && finitePct(cursor.monthlyPct) && cursor.monthlyPct < CURSOR_MAX_PCT;
    if (room && !complex) {
      return { side: 'cursor', seat: cursor, kind: kind.id, reason: kind.why };
    }
    // Too complex for Cursor, or Cursor full or unreadable: the work is
    // ordinary general work again.
    const fallback = leanRoute(id, 'general', seats, { large });
    let why = "Cursor's usage could not be read.";
    if (complex) why = 'Too complex for Cursor: the changes need judgement or a hard-to-check result.';
    else if (cursor && finitePct(cursor.monthlyPct)) why = `Cursor is at least ${CURSOR_MAX_PCT}% used this month.`;
    return { ...fallback, kind: kind.id, reason: `${why} ${fallback.reason}` };
  }
  if (kind.side === 'gpt' || id === 'lean-openai') {
    if (open) return gpt(open, kind.side === 'gpt' ? kind.why : 'Heavy lifting leans OpenAI.');
    return claude(best ? `Every GPT seat is at least ${GPT_MAX_PCT}% used.` : 'No GPT seat usage is known.');
  }
  if (id === 'lean-claude') return claude('Heavy lifting leans Claude.');
  // Balanced, general work.
  if (!large) return claude('Small and medium general work stays on Claude.');
  if (!best) return claude('No GPT seat usage is known.');
  if (capped.length) return claude(`${capped.map((seat) => seat.label).join(', ')} ${capped.length === 1 ? 'is' : 'are'} capped.`);
  if (best.weeklyPct >= BALANCED_MAX_PCT) return claude(`Every GPT seat is at least ${BALANCED_MAX_PCT}% used.`);
  return gpt(best, 'Large general jobs may use a GPT seat with room.');
}

// Where a route lands, as a row: { label, target, note }.
function routeRow(label, route) {
  if (route.side === 'gpt') return { label, target: route.seat.label, note: `${pctText(route.seat.weeklyPct)} used this week` };
  if (route.side === 'cursor') return { label, target: route.seat.label || 'Cursor', note: `${pctText(route.seat.monthlyPct)} used this month` };
  return { label, target: 'Claude', note: null };
}

// The whole setting at a glance, for the menu's "Right now" rows and
// bin/harbor-lean: { rows: [{ label, target, note }], summary, gpt, seat }.
// gpt is 'off' (nothing goes to a GPT seat), 'image' (only image work does),
// 'large' (plus large general jobs) or 'prefer' (most work).
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
    if (id === 'balanced') {
      const large = leanRoute(id, 'general', seats, { large: true });
      rows.push({ ...routeRow('Large general jobs', large), note: large.side === 'gpt' ? routeRow('', large).note : large.reason.replace(/\.$/, '') });
      if (large.side === 'gpt') {
        gpt = 'large';
        seat = large.seat;
      }
      rows.push({ label: 'Everything else', target: 'Claude', note: null });
    } else if (id === 'lean-openai') {
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

// The weekly window of each codex plan, in the shape plan-usage.js returns.
function seatsFromPlans(plans) {
  return (Array.isArray(plans) ? plans : [])
    .filter((plan) => plan && plan.provider === 'codex')
    .map((plan) => {
      const weekly = (plan.windows || []).find((w) => w && w.kind === 'weekly');
      return {
        label: plan.label,
        weeklyPct: plan.unavailable || !weekly ? null : weekly.usedPct,
      };
    });
}

// Cursor's monthly included usage from the same payload, or null.
function cursorFromPlans(plans) {
  const plan = (Array.isArray(plans) ? plans : []).find((p) => p && p.provider === 'cursor');
  if (!plan) return null;
  const monthly = (plan.windows || []).find((w) => w && w.kind === 'monthly');
  return { label: plan.label || 'Cursor', monthlyPct: plan.unavailable || !monthly ? null : monthly.usedPct };
}

module.exports = {
  LEAN_MODES,
  TASK_KINDS,
  DEFAULT_LEAN,
  BALANCED_MAX_PCT,
  GPT_MAX_PCT,
  CURSOR_MAX_PCT,
  normalizeLean,
  leanMode,
  taskKind,
  leanRoute,
  leanVerdict,
  seatsFromPlans,
  cursorFromPlans,
};
