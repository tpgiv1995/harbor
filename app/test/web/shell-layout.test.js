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
