'use strict';

// A control's STATE must survive the cursor landing on it.
//
// `.compose-mic:hover:not(:disabled)` has specificity (0,3,0); `.compose-mic.recording`
// has (0,2,0). The hover therefore wins no matter which is written first, so hovering
// a RECORDING mic repainted it as an ordinary idle button, and the cursor is naturally
// resting right there because that is the control the user just clicked. Four instances
// of this exact shape shipped at once (mic recording, the recommended answer key, and
// both format toggles), which is what makes it worth a rule rather than four patches:
// the pattern is easy to write and invisible until someone hovers the one control whose
// state matters.
//
// The fix is never to weaken the hover. It is to add a state-aware hover so the control
// still responds to the pointer while keeping its state colour.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '../../src/renderer/styles.css');

// Walk the sheet tracking brace depth so rules nested in @media are collected too,
// and an at-rule preamble is never mistaken for a selector.
function parseRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let buf = '';
  let depth = 0;
  let selector = '';
  for (const ch of stripped) {
    if (ch === '{') {
      depth += 1;
      if (depth === 1 || (depth === 2 && selector === '')) selector = buf.trim();
      else selector = buf.trim();
      buf = '';
      continue;
    }
    if (ch === '}') {
      if (depth >= 1 && selector && !selector.startsWith('@')) {
        rules.push({ selector, body: buf });
      }
      depth -= 1;
      buf = '';
      selector = '';
      continue;
    }
    buf += ch;
  }
  return rules;
}

// Specificity of the simple compound selectors this sheet uses. :not() contributes
// the specificity of its argument, which is exactly why :not(:disabled) is the thing
// that tips a hover over a state class.
function specificity(sel) {
  let s = sel;
  let count = 0;
  s = s.replace(/:not\(([^)]*)\)/g, (_m, inner) => {
    count += specificity(inner);
    return '';
  });
  count += (s.match(/\.[A-Za-z0-9_-]+/g) || []).length;
  count += (s.match(/:[A-Za-z-]+/g) || []).length;
  return count;
}

function declaredProps(body) {
  const props = new Map();
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const name = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim().replace(/\s+/g, ' ');
    if (name) props.set(name, value);
  }
  return props;
}

// A state class is a modifier the app toggles at runtime. Availability pseudo-classes
// are not states in this sense: a hover SHOULD lose to :disabled.
const NOT_A_STATE = new Set(['primary', 'on', 'recording']);

test('a state class is never overridden by a bare hover on the same control', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const rules = parseRules(css);
  assert.ok(rules.length > 400, `expected a real stylesheet, parsed ${rules.length} rules`);

  // base class -> rules whose selector is that class plus modifiers only
  const byBase = new Map();
  for (const rule of rules) {
    for (const single of rule.selector.split(',')) {
      const sel = single.trim();
      const m = /^\.([A-Za-z0-9_-]+)([.:][^\s>+~]*)?$/.exec(sel);
      if (!m) continue;
      const base = m[1];
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push({ sel, body: rule.body, order: rules.indexOf(rule) });
    }
  }

  const offenders = [];
  for (const [base, group] of byBase) {
    const hovers = group.filter((r) => r.sel.includes(':hover') && !/\.[A-Za-z0-9_-]+/.test(r.sel.slice(base.length + 1)));
    const states = group.filter((r) => {
      const tail = r.sel.slice(base.length + 1);
      return /^\.[A-Za-z0-9_-]+$/.test(tail) && !r.sel.includes(':');
    });
    if (!hovers.length || !states.length) continue;

    for (const hover of hovers) {
      const hoverProps = declaredProps(hover.body);
      const hoverSpec = specificity(hover.sel);
      for (const state of states) {
        // A selector LIST sharing one block (`.x:hover, .x.open { ... }`) is the two
        // being styled deliberately alike. They declare the same bytes, so neither can
        // erase the other, and flagging them would demand churn on healthy controls.
        if (state.order === hover.order) continue;

        const stateClass = state.sel.slice(base.length + 1).replace('.', '');
        const stateProps = declaredProps(state.body);
        // Only a DIFFERENT value erases anything. Both setting `color: var(--tx)` is
        // redundant, not a defect.
        const clash = [...stateProps.keys()]
          .filter((p) => hoverProps.has(p) && hoverProps.get(p) !== stateProps.get(p));
        if (!clash.length) continue;

        // The cascade: higher specificity always wins; on a TIE the later rule wins.
        // So an equal-specificity hover written BEFORE its state rule is correct and
        // must not be flagged, or this test would demand churn on ~17 healthy controls.
        const stateSpec = specificity(state.sel);
        if (stateSpec > hoverSpec) continue;
        if (stateSpec === hoverSpec && state.order > hover.order) continue;

        // The state loses to the hover, so a state-aware hover must exist to restore it.
        const guarded = group.some((r) => r.sel.includes(`.${stateClass}`) && r.sel.includes(':hover'));
        if (!guarded) {
          offenders.push(
            `.${base}.${stateClass} (${specificity(state.sel)}) is erased by `
            + `${hover.sel} (${hoverSpec}) for [${clash.join(', ')}]; `
            + `add .${base}.${stateClass}:hover`,
          );
        }
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `hover erases a runtime state on ${offenders.length} control(s):\n  ${offenders.join('\n  ')}`,
  );
});

test('the four known instances each carry a state-aware hover', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  for (const sel of [
    '.compose-mic.recording:hover',
    '.tile-ask-key.primary:hover',
    '.compose-format-btn.on:hover',
    '.compose-format-toggle.on:hover',
  ]) {
    assert.ok(css.includes(sel), `${sel} is missing; the cursor erases that control's state again`);
  }
  assert.ok(NOT_A_STATE.size === 3, 'known runtime state modifiers');
});
