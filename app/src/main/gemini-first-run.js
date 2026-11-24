'use strict';

// GEMINI'S FIRST-RUN PAGES AS A HARBOR CARD (2026-11-24, Pat, on a new Gemini window that opened on Antigravity's
// colour-scheme page in a raw terminal: "you didn't even bother to build out a harbor screen for gemini").
//
// A profile that never ran agy interactively opens on two pages before any conversation exists: "Choose your color
// scheme" and "Terms of Service & Data Use" (a data-sharing box, pre-ticked by Google, then [Previous] [Done]). These
// are Pat's choices, so Harbor never makes them (DESIGN D12). It reads each page into a card he answers in the window,
// and a click becomes keys only after the screen is re-read and the pointer is verified, one step at a time.
//
// Keys measured on agy 1.5.14 in a scratch home (2026-11-24, fixtures in test/fixtures/gemini-first-run; Done was
// never pressed): colour page, Up/Down move the "> " pointer and Enter on a scheme goes straight to the Terms page.
// Terms page: focus starts on the box and Enter toggles it; Down moves to Previous; Tab cycles box, Previous, Done;
// Up from the box stays; Enter on Previous returns to the colour page; Enter on Done finishes onboarding.

const KEYS = Object.freeze({ up: '\x1b[A', down: '\x1b[B', enter: '\r', tab: '\t' });

const SCHEME_RE = /Choose your color scheme:/;
const TERMS_RE = /Terms of Service & Data Use/;
// The colour page draws a live preview box to the right of the list; only the text left of it is the list.
const leftOfPreview = (line) => line.split(/[│╭╰]/u)[0];

function parseScheme(lines) {
  const start = lines.findIndex((line) => SCHEME_RE.test(line));
  if (start < 0) return null;
  const schemes = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const left = leftOfPreview(lines[i]);
    if (/\[Next\]|Navigate/.test(left)) break;
    const m = /^ {2}(>| ) (\S.*?)\s*$/.exec(left);
    if (m) schemes.push({ label: m[2], selected: m[1] === '>' });
  }
  if (!schemes.length || schemes.filter((s) => s.selected).length !== 1) return null;
  return { kind: 'gemini-setup', page: 'scheme', schemes };
}

function parseTerms(lines) {
  const title = lines.findIndex((line) => TERMS_RE.test(line));
  if (title < 0) return null;
  const rule = lines.findIndex((line, i) => i > title && /^-{10,}\s*$/.test(line));
  const warning = lines.slice(title + 1, rule < 0 ? title + 1 : rule).map((l) => l.trim()).filter(Boolean).join(' ');
  const boxAt = lines.findIndex((line, i) => i > title && /^\s*(?:>\s*)?\[(?:x| )\]\s+\S/.test(line));
  if (boxAt < 0) return null;
  const boxMatch = /^\s*(>)?\s*\[(x| )\]\s+(.*\S)\s*$/.exec(lines[boxAt]);
  const consent = [boxMatch[3]];
  let i = boxAt + 1;
  for (; i < lines.length && lines[i].trim(); i += 1) consent.push(lines[i].trim());
  const links = [];
  for (const line of lines.slice(i)) {
    const m = /^\s*-\s+([^:]+):\s+(https?:\/\/\S+)\s*$/.exec(line);
    if (m) links.push({ label: m[1].trim(), url: m[2] });
  }
  const buttons = lines.find((line) => /Previous/.test(line) && /Done/.test(line)) || '';
  let focus = null;
  if (boxMatch[1]) focus = 'box';
  else if (/>\s+Previous/.test(buttons)) focus = 'previous';
  else if (/>\s+Done/.test(buttons)) focus = 'done';
  if (!focus) return null;
  return { kind: 'gemini-setup', page: 'terms', warning, consent: consent.join(' '), checked: boxMatch[2] === 'x', links, focus };
}

// The page on screen, or null when no first-run page is drawn.
function parseGeminiFirstRun(screen) {
  const lines = String(screen || '').split('\n');
  return parseScheme(lines) || parseTerms(lines);
}

// Answer one card action on the live pane. deps: { read() -> screen text, type(bytes), sleep(ms) }.
// Every key is sent only after a fresh read proves where the pointer is; a step that does not move ends the walk
// without Enter. Returns { ok, action } or { ok: false, reason }.
async function answerGeminiFirstRun(action, { read, type, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const page = async () => parseGeminiFirstRun(await read());
  // Resolves to { now } once the screen passes the test (now may be null: the page has gone), else to null.
  const waitFor = async (test, ms = 3000) => {
    for (let waited = 0; waited <= ms; waited += 150) {
      const now = await page();
      if (test(now)) return { now };
      await sleep(150);
    }
    return null;
  };

  if (action.type === 'gemini-scheme') {
    const want = String(action.label || '');
    for (let step = 0; step < 16; step += 1) {
      const now = await page();
      if (!now || now.page !== 'scheme') return { ok: false, reason: 'The colour-scheme page is no longer on screen' };
      const at = now.schemes.findIndex((s) => s.selected);
      const target = now.schemes.findIndex((s) => s.label === want);
      if (target < 0) return { ok: false, reason: `No colour scheme named "${want}" on screen` };
      if (at === target) {
        await type(KEYS.enter);
        return (await waitFor((p) => !p || p.page !== 'scheme'))
          ? { ok: true, action: 'gemini-scheme', label: want }
          : { ok: false, reason: 'The colour-scheme page did not move on after Enter' };
      }
      await type(target > at ? KEYS.down : KEYS.up);
      const moved = await waitFor((p) => p?.page === 'scheme' && p.schemes.findIndex((s) => s.selected) !== at, 1500);
      if (!moved) return { ok: false, reason: 'The pointer did not move; nothing was chosen' };
    }
    return { ok: false, reason: 'Could not reach that colour scheme' };
  }

  if (action.type === 'gemini-terms') {
    const now = await page();
    if (!now || now.page !== 'terms') return { ok: false, reason: 'The Terms page is no longer on screen' };
    // Focus moves only by measured keys, each step verified: Down from the box (-> Previous), Tab from Previous
    // (-> Done) and from Done (-> the box).
    const focusOn = async (target) => {
      for (let step = 0; step < 4; step += 1) {
        const cur = await page();
        if (!cur || cur.page !== 'terms') return null;
        if (cur.focus === target) return cur;
        const before = cur.focus;
        await type(before === 'box' ? KEYS.down : KEYS.tab);
        if (!(await waitFor((p) => p?.page === 'terms' && p.focus !== before, 1500))) return null;
      }
      return null;
    };
    if (action.op === 'toggle') {
      const at = await focusOn('box');
      if (!at) return { ok: false, reason: 'Could not reach the data-sharing box' };
      await type(KEYS.enter);
      return (await waitFor((p) => p?.page === 'terms' && p.checked !== at.checked, 2000))
        ? { ok: true, action: 'gemini-terms', op: 'toggle' }
        : { ok: false, reason: 'The data-sharing box did not change' };
    }
    if (action.op === 'previous') {
      if (!(await focusOn('previous'))) return { ok: false, reason: 'Could not reach Previous' };
      await type(KEYS.enter);
      return (await waitFor((p) => p?.page === 'scheme'))
        ? { ok: true, action: 'gemini-terms', op: 'previous' }
        : { ok: false, reason: 'The colour-scheme page did not come back' };
    }
    if (action.op === 'done') {
      // Done confirms exactly what the card showed: if the box changed since, nothing is pressed.
      if (typeof action.checked !== 'boolean' || now.checked !== action.checked) {
        return { ok: false, reason: 'The data-sharing box is not what the card showed; look at it again before Done' };
      }
      const at = await focusOn('done');
      if (!at || at.checked !== action.checked) return { ok: false, reason: 'Could not reach Done' };
      await type(KEYS.enter);
      return (await waitFor((p) => !p, 4000))
        ? { ok: true, action: 'gemini-terms', op: 'done' }
        : { ok: false, reason: 'The Terms page is still on screen after Done' };
    }
    return { ok: false, reason: `unknown Terms action ${action.op}` };
  }
  return { ok: false, reason: `not a first-run action: ${action.type}` };
}

const isGeminiFirstRunAction = (action) => action?.type === 'gemini-scheme' || action?.type === 'gemini-terms';

module.exports = { parseGeminiFirstRun, answerGeminiFirstRun, isGeminiFirstRunAction, KEYS };
