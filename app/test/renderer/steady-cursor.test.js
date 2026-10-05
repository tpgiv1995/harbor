'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdCursorSteady } = require('../../src/renderer/terminal/steady-cursor.cjs');

// A terminal shaped like xterm 5.5's: a custom CSI handler that returns false falls through to
// the built-in one, and the built-ins write the option themselves (InputHandler.ts: DECSET 12
// sets cursorBlink true; DECSCUSR sets it from the parity of Ps, where a missing Ps counts as 1).
function fakeTerm() {
  const term = { options: { cursorBlink: true, cursorStyle: 'block' }, handlers: [] };
  term.parser = { registerCsiHandler: (id, fn) => { term.handlers.push({ id, fn }); return { dispose() {} }; } };
  const run = (match, params, builtin) => {
    const handled = term.handlers.filter((h) => match(h.id)).some((h) => h.fn(params));
    if (!handled) builtin();
    return handled;
  };
  term.decset = (params) => run((id) => id.prefix === '?' && id.final === 'h', params, () => {
    if (params.includes(12)) term.options.cursorBlink = true;
  });
  term.decscusr = (params) => run((id) => id.intermediates === ' ' && id.final === 'q', params, () => {
    const ps = params[0] || 1;
    term.options.cursorStyle = ps <= 2 ? 'block' : ps <= 4 ? 'underline' : 'bar';
    term.options.cursorBlink = ps % 2 === 1;
  });
  return term;
}

test('the cursor starts steady and both blink-capable sequences are watched', () => {
  const term = fakeTerm();
  holdCursorSteady(term, () => {});
  assert.equal(term.options.cursorBlink, false);
  assert.deepEqual(term.handlers.map((h) => h.id), [{ prefix: '?', final: 'h' }, { intermediates: ' ', final: 'q' }]);
});

test('DECSET 12 from a program in the pty is let through, then blinking is switched back off', () => {
  const term = fakeTerm();
  const deferred = [];
  holdCursorSteady(term, (fn) => deferred.push(fn));
  assert.equal(term.decset([12]), false, 'never swallowed: xterm still runs its own handler');
  assert.equal(term.options.cursorBlink, true, 'which turns blinking on');
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.equal(term.options.cursorBlink, false, 'and the deferred reset lands after it');
});

test('12 inside a longer mode list is caught, and other modes are left alone', () => {
  const term = fakeTerm();
  const deferred = [];
  holdCursorSteady(term, (fn) => deferred.push(fn));
  assert.equal(term.decset([25, 12]), false);
  assert.equal(deferred.length, 1);
  assert.equal(term.decset([25]), false);
  assert.equal(term.decset([2004]), false);
  assert.equal(deferred.length, 1, 'bracketed paste and show-cursor schedule nothing');
});

test('a cursor-shape request keeps its shape and loses its blink, whatever Ps says', () => {
  for (const [params, style] of [[[1], 'block'], [[3], 'underline'], [[5], 'bar'], [[0], 'block'], [[], 'block'], [[6], 'bar']]) {
    const term = fakeTerm();
    const deferred = [];
    holdCursorSteady(term, (fn) => deferred.push(fn));
    assert.equal(term.decscusr(params), false, 'let through, so the shape change lands');
    assert.equal(term.options.cursorStyle, style);
    for (const fn of deferred) fn();
    assert.equal(term.options.cursorBlink, false, `CSI ${params.join(';')} SP q must not leave the cursor blinking`);
  }
});

test('dispose releases both handlers', () => {
  const term = fakeTerm();
  let disposed = 0;
  term.parser.registerCsiHandler = () => ({ dispose() { disposed += 1; } });
  holdCursorSteady(term, () => {}).dispose();
  assert.equal(disposed, 2);
});
