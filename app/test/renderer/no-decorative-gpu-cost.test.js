'use strict';

// Harbor is a terminal wrapper. On 2026-09-19 a FOCUSED Harbor cost 69% of the display GPU
// (Radeon 610M, 2560x1600 at 240 Hz) and typing in it lagged, with one session open. Measured
// live, one change per row, Harbor confirmed in the foreground for every row:
//
//   shipped                                   69.0%   (72.5% on the re-check)
//   the .aurora glow element removed, alone   25.9%
//   glow removed and no animations            23.7%
//   glow, blur, frost, shadows, motion all off 3.0%
//
// One decorative layer, a larger-than-viewport element with filter: blur(48px), was ~45 points
// by itself, and making it STATIC changed nothing (67.3%): the blur is re-applied on every frame
// the window draws, and typing draws frames. None of it added function. These pins keep it out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
function cssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}
const sheets = [...cssFiles(path.join(root, 'src/renderer')), ...cssFiles(path.join(root, 'web/src'))];
// Comments are blanked, not deleted, so a reported line number is the real one.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
const rel = (file) => path.relative(root, file).replace(/\\/g, '/');

test('the desktop and phone stylesheets are found', () => {
  assert.ok(sheets.some((f) => rel(f) === 'src/renderer/styles.css'));
  assert.ok(sheets.some((f) => rel(f) === 'web/src/styles.css'));
});

// backdrop-filter re-samples and re-blurs what is behind a surface on every frame that touches
// it. With no glow behind the panels there is nothing to refract, so it bought nothing at all.
test('no stylesheet sets a backdrop-filter', () => {
  const hits = [];
  for (const file of sheets) {
    stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (/backdrop-filter\s*:\s*(?!none\b)/.test(line)) hits.push(`${rel(file)}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the glow layer is gone from both clients, element and rule', () => {
  for (const file of sheets) assert.doesNotMatch(stripComments(fs.readFileSync(file, 'utf8')), /\.aurora\b/, rel(file));
  for (const jsx of ['src/renderer/index.jsx', 'web/src/shell/AppShell.jsx']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, jsx), 'utf8'), /className=["']aurora["']/, jsx);
  }
});

// A looping animation is the other half of the cost: while one runs, Chromium draws the whole
// window at the display rate, so ONE status pulse is 240 full-window frames a second on a 240 Hz
// panel. Sampling them from a JS timer instead (the 10 Hz "ambient clock" that shipped for one
// evening) still left a focused Harbor at 10 to 11% with seven pulses live, and moved the work
// onto the thread that handles typing. Pat, 2026-09-19: "its a status light, i dont need
// animations". State is colour and shape. Nothing loops, in either client.
test('no stylesheet in either client has a looping animation', () => {
  const hits = [];
  for (const file of sheets) {
    stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (/\binfinite\b/i.test(line)) hits.push(`${rel(file)}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, []);
});

// The desktop sheet goes further and animates nothing at all, so there is no keyframe block to
// hang a loop on later. Transitions stay: they run once, on an event, and stop. The phone keeps
// its finite sheet and drawer entrances, which end in a fraction of a second.
test('the desktop stylesheets declare no animation and no keyframes', () => {
  const hits = [];
  for (const file of cssFiles(path.join(root, 'src/renderer'))) {
    stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (/@keyframes\b/i.test(line) || /(?<![-\w])animation(?:-[a-z-]+)?\s*:/i.test(line)) {
        hits.push(`${rel(file)}:${i + 1} ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

// xterm's DOM renderer blinks the cursor with a looping CSS animation of its own.
test('the terminal cursor does not blink', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/terminal/XtermPane.jsx'), 'utf8');
  assert.match(source, /cursorBlink:\s*false/);
  assert.doesNotMatch(source, /cursorBlink:\s*true/);
});

// A large live blur is the expensive primitive, whatever the element is called next time.
// Small blurs on small elements (an icon glow) are fine; a wide one is a full re-filter per frame.
test('no stylesheet applies a wide live blur filter', () => {
  const hits = [];
  for (const file of sheets) {
    const css = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of css.matchAll(/(?<![-\w])filter\s*:[^;}]*blur\(\s*(\d+(?:\.\d+)?)px\s*\)/g)) {
      if (Number(match[1]) > 12) hits.push(`${rel(file)}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(hits, []);
});
