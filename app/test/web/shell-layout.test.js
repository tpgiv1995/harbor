'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '../..');
const WEB_ROOT = path.join(APP_ROOT, 'web');

function readSource(rel) {
  return fs.readFileSync(path.join(WEB_ROOT, 'src', rel), 'utf8');
}

test('MOBILE-OVERHAUL-1: screen-based shell replaces header dropdown with SessionBrowser', () => {
  const main = readSource('main.jsx');
  const shell = readSource('shell/AppShell.jsx');
  assert.match(main, /from '\.\/shell\/AppShell\.jsx'/);
  assert.match(shell, /from '\.\.\/browse\/SessionBrowser\.jsx'/);
  assert.doesNotMatch(shell, /conv-header-btn/);
  assert.doesNotMatch(shell, /from '\.\.\/rail\/SessionSheet\.jsx'/);
  assert.match(shell, /<SessionBrowser/);
});

test('MOBILE-SHELL-1: one conversation uses a drawer with no stack gestures (bottom tabs are the Chat/Tasks/Notes nav)', () => {
  const styles = fs.readFileSync(path.join(WEB_ROOT, 'src/styles.css'), 'utf8');
  const shellCss = readSource('shell/shell.css');
  const shell = readSource('shell/AppShell.jsx');
  // Session switching stays a drawer with no swipe/stack gestures; the bottom
  // tab bar (added 2026-08-31) switches Chat/Tasks/Notes, not sessions.
  assert.match(shell, /<BottomNav/);
  assert.doesNotMatch(shell, /shell-session-dots|onTouchStart|onTouchEnd|onStep/);
  assert.match(shell, /className="shell-drawer-backdrop"/);
  assert.match(shellCss, /\.shell-drawer/);
  assert.doesNotMatch(styles, /\.session-dots\s*\{/);
});

test('MOBILE-KEYBOARD-1: shell follows visualViewport directly without keyboard inference', () => {
  const hook = readSource('shell/use-visual-viewport.js');
  const styles = fs.readFileSync(path.join(WEB_ROOT, 'src/styles.css'), 'utf8');
  assert.match(hook, /visualViewport/);
  assert.match(hook, /addEventListener\('resize'/);
  assert.match(hook, /addEventListener\('scroll'/);
  assert.doesNotMatch(hook, /keyboardOpen|KEYBOARD_MIN_BITE|innerHeight\s*-|visualHeight\s*-/);
  assert.doesNotMatch(hook, /bottomAnchoredStyle/);
  assert.match(hook, /--app-offset-top/);
  assert.doesNotMatch(styles, /data-keyboard-open|transform:\s*translateY\(var\(--app-offset-top/);
  assert.match(styles, /top:\s*var\(--app-offset-top/);
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  assert.match(html, /interactive-widget=resizes-visual/);
});

// Pat's phone after the Lighthouse reskin, twice. html, body and #root are
// --app-h tall and clip; with the keyboard up Safari pans the visual viewport and
// the shell (top: --app-offset-top) sits below that box. 2026-11-09: a positioned
// #root was the shell's containing block and cut it off. 2026-11-10: with
// `isolation: isolate` instead, iOS still cut it, because iOS composites every
// position:fixed glass layer and clips composited layers to an overflow-clipping
// STACKING CONTEXT's box regardless of containing block. So none of the three may
// form a stacking context or a containing block; the ground goes under the app by
// its own z-index: -1. The browser check is scripts/drive-phone-ux-win.js
// --only=typingPanned (computed styles of the shell's ancestors).
test('MOBILE-KEYBOARD-2: html, body and #root stay plain boxes; the ground sits under the app by z-index -1', () => {
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sheets = {
    'styles.css': strip(fs.readFileSync(path.join(WEB_ROOT, 'src/styles.css'), 'utf8')),
    'tokens.css': strip(readSource('tokens.css')),
  };
  const forbidden = /(^|;|\s)(position|z-index|isolation|opacity|transform|translate|rotate|scale|filter|backdrop-filter|-webkit-backdrop-filter|clip-path|mask|contain|will-change|mix-blend-mode|perspective|container-type)\s*:/;
  let seen = 0;
  for (const [name, css] of Object.entries(sheets)) {
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const hits = selector.split(',').map((s) => s.trim()).filter((s) => ['html', 'body', '#root', ':root'].includes(s));
      if (hits.length === 0) continue;
      seen += 1;
      assert.doesNotMatch(body, forbidden, `${name} rule "${selector.trim()}" must not make ${hits.join('/')} a stacking context or containing block: ${body.trim()}`);
    }
  }
  assert.ok(seen > 0, 'the sheets style html/body/#root');
  const ground = sheets['tokens.css'].match(/body::before\s*\{([^{}]*)\}/);
  assert.ok(ground, 'tokens.css paints the ground on body::before');
  assert.match(ground[1], /position:\s*fixed/);
  assert.match(ground[1], /z-index:\s*-1\s*;/, 'the ground sits under the app by its own negative z-index');
});

test('MOBILE-OVERHAUL-1: sprint-2 seam signatures exist', () => {
  const browser = readSource('browse/SessionBrowser.jsx');
  const composer = readSource('composer/Composer.jsx');
  const newsession = readSource('newsession/NewSessionSheet.jsx');
  const rpc = readSource('rpc/rpc-context.jsx');
  assert.match(browser, /export function SessionBrowser\(\{/);
  assert.match(browser, /open,\s*model:\s*modelProp,\s*rows:\s*_rows,\s*activeSessionId,\s*onPick,\s*onClose,\s*onNewSession/);
  assert.match(composer, /export function Composer\(\{/);
  // `working` joined the seam so Interrupt can be drawn only while there is a
  // turn to interrupt, instead of as a permanent full-width bar.
  assert.match(composer, /sessionId,\s*paneId,\s*disabled,\s*working[^,]*,\s*onSent/);
  assert.match(newsession, /export function NewSessionSheet\(\{/);
  assert.match(newsession, /open,\s*onClose,\s*onCreated/);
  assert.match(rpc, /export function RpcProvider/);
  assert.match(rpc, /export function useRpc/);
});

test('MOBILE-SHELL-1: open-session state is a single active conversation', () => {
  const shell = readSource('shell/AppShell.jsx');
  const sessions = readSource('nav/useOpenSessions.js');
  assert.doesNotMatch(shell, /Math\.abs\(dx\)|changedTouches/);
  assert.doesNotMatch(sessions, /STORAGE_OPEN|setOpenIds|const step/);
});

test('MOBILE-SHELL-1: unchanged selection preserves transcript subscription identity', () => {
  // Run the production hook with persistent hook slots. Object identity matters:
  // useOpenTranscripts reopens subscriptions whenever openIds changes identity.
  const slots = [];
  let cursor = 0;
  const storage = new Map();
  function useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = value; }];
  }
  function useMemo(factory, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || deps.length !== previous.deps.length ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      slots[index] = { value: factory(), deps };
    }
    return slots[index].value;
  }
  const useCallback = (fn, deps) => useMemo(() => fn, deps);
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const source = readSource('nav/useOpenSessions.js')
    .replace(/^import[^\n]+\n/, '').replace('export function', 'function');
  const useOpenSessions = new Function('useState', 'useMemo', 'useCallback', 'useEffect',
    'localStorage', source + '\nreturn useOpenSessions;')(
    useState, useMemo, useCallback, () => {}, localStorage);
  function render() { cursor = 0; return useOpenSessions(); }

  const empty = render();
  assert.deepEqual(empty.openIds, []);
  assert.strictEqual(render().openIds, empty.openIds, 'idle renders keep the same subscription list');
  empty.openSession('first');
  const first = render();
  assert.equal(first.activeId, 'first');
  assert.deepEqual(first.openIds, ['first']);
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(render().openIds, first.openIds, 'transcript pushes must not reopen the session');
  }
  first.setActive('second');
  const second = render();
  assert.equal(second.activeId, 'second');
  assert.deepEqual(second.openIds, ['second']);
  assert.notStrictEqual(second.openIds, first.openIds, 'switching sessions changes the subscription');
  second.openSession('second');
  assert.strictEqual(render().openIds, second.openIds);
  second.openSession(null);
  assert.strictEqual(render().openIds, second.openIds, 'empty selections leave the conversation open');
});
