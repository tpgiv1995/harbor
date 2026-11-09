'use strict';

// The composer card's toolbar (web/src/composer/composer-actions.cjs): where Stop
// lives now that it is a button beside Send and not a row of its own
// (2026-10-31). The drive scripts/drive-phone-qol-win.js proves the layout in a
// real browser; this pins the rule it draws and the shape of the markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { composerActions, hasDraft } = require('../../web/src/composer/composer-actions.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../web/src', rel), 'utf8');

test('idle: no Stop, and Send is ready only when there is a draft', () => {
  assert.deepEqual(composerActions({ canStop: false, hasDraft: false }), { stop: false, sendReady: false });
  assert.deepEqual(composerActions({ canStop: false, hasDraft: true }), { stop: false, sendReady: true });
  assert.deepEqual(composerActions(), { stop: false, sendReady: false });
});

test('a turn is running: Stop is always there, whatever the box holds', () => {
  for (const draft of [false, true]) {
    const actions = composerActions({ canStop: true, hasDraft: draft });
    assert.equal(actions.stop, true, `a running turn always has a Stop (draft ${draft})`);
    assert.equal(actions.sendReady, draft, 'Send follows the draft and nothing else, so a draft queues behind the turn');
  }
});

test('a draft is text with a character in it, or any attachment', () => {
  assert.equal(hasDraft('', 0), false);
  assert.equal(hasDraft('   \n\t ', 0), false, 'whitespace alone is not a draft: Send stays disabled for it');
  assert.equal(hasDraft('hello', 0), true);
  assert.equal(hasDraft('', 1), true, 'an attachment alone is a draft');
  assert.equal(hasDraft(undefined, undefined), false);
  assert.equal(hasDraft(null, 2), true);
});

test('the 500 ms tap guard is gone: nothing about Stop depends on the clock', () => {
  const helper = read('composer/composer-actions.cjs');
  const source = read('composer/Composer.jsx');
  assert.doesNotMatch(helper, /GUARD|stopTapAllowed|sendHandedToStop/);
  assert.doesNotMatch(source, /stopTapAllowed|sendHandedToStop|sendLeftAt|Date\.now/);
  assert.match(source, /onClick=\{interrupt\}/, 'Stop interrupts on every tap');
});

test('one card holds chips, the text box and the toolbar, with Stop before Send', () => {
  const source = read('composer/Composer.jsx');
  const card = source.indexOf('<div className={cardClass}>');
  const chips = source.indexOf('<AttachChips');
  const field = source.indexOf('<div className="composer-field">');
  const bar = source.indexOf('<div className="composer-bar">');
  const plus = source.indexOf('className={`composer-plus');
  const stop = source.indexOf('className="composer-stop"');
  const send = source.indexOf('className="composer-send"');
  for (const [name, at] of Object.entries({ card, chips, field, bar, plus, stop, send })) assert.ok(at > 0, `${name} is in the markup`);
  assert.ok(card < chips && chips < field && field < bar, 'card: chips, then the text box, then the toolbar');
  assert.ok(bar < plus && plus < stop && stop < send, 'toolbar: tools toggle on the left, then Stop, then Send last');
  assert.match(source, /\{actions\.stop \? \(/, 'Stop is drawn from the rule, Send always');
  // Stop's old homes, a row of its own and a slot that swapped places with Send, are gone.
  assert.doesNotMatch(source, /composer-interrupt|composer-row|stopButton|actions\.send\b/);
  // The text box is not a sibling of the toolbar's buttons: nothing shares its row.
  const css = read('composer/composer.css');
  assert.doesNotMatch(css, /composer-interrupt|\.composer-row|\.composer-stop\.beside/);
});

test('every composer button keeps focus in the text box (the lost-first-tap bug of 2026-10-21)', () => {
  const source = read('composer/Composer.jsx');
  const tags = source.match(/<button[\s\S]*?>/g).filter((tag) => /composer-(plus|send|stop)/.test(tag));
  assert.equal(tags.length, 3, 'plus, stop and send');
  for (const tag of tags) assert.match(tag, /onPointerDown=\{keepFocus\}/, `a composer button without keepFocus: ${tag.slice(0, 80)}`);
  assert.match(source, /aria-label="Stop"/);
  assert.match(source, /'Send'/);
});

test('the toolbar circles are one size with a 44px target, and the card is the established shape', () => {
  const css = read('composer/composer.css');
  assert.match(css, /--cmp-btn:\s*40px/, 'one diameter for every toolbar circle');
  assert.match(css, /\.composer-plus,\s*\.composer-stop,\s*\.composer-send\s*\{[^}]*width:\s*var\(--cmp-btn\)[^}]*height:\s*var\(--cmp-btn\)/, 'plus, stop and send share the diameter');
  assert.match(css, /\.composer-send::before[\s\S]*?inset:\s*-2px/, 'a 40px circle plus 2px a side is a 44px target');
  // Lighthouse glass (2026-11-09): the card is the text box, radius 20 (it was 24 in Slate).
  assert.match(css, /\.composer-card\s*\{[^}]*border-radius:\s*20px/, 'a 20px card');
  // The rim's mask is a gradient on the card's ::after; Send itself paints no gradient.
  for (const rule of css.match(/\.composer-send\s*\{[^}]*\}/g)) assert.doesNotMatch(rule, /linear-gradient/, 'no gradient on Send');
  const slash = read('slash/slash.css');
  assert.doesNotMatch(slash, /inset 3px 0 0/, 'no coloured bar down the left of the text box');
});
