'use strict';
// Where the one-click permission answers show, and the keyboard rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { canQuickAnswer, quickAllowOffered } = require('../../src/shared/session-run-state.cjs');
const { quickAnswerDecision, isEditableTarget, quickAnswerKeys } = require('../../src/renderer/stage/quick-answer-keys.cjs');

const PANE = { paneId: 'p1', workspaceId: 'w1' };
const blocked = (extra = {}) => ({
  id: 's1', provider: 'claude', isLive: true,
  agentStatus: 'blocked', agentStatusKind: 'permission', agentStatusMsg: 'approve Write: /work/toy.txt', agentStatusSeq: 2,
  ...extra,
});

test('offered only while the CLI reports a permission prompt with its words, on a pane Harbor runs', () => {
  assert.equal(canQuickAnswer(blocked(), PANE), true);
  assert.equal(canQuickAnswer(blocked(), null), false, 'no pane: nothing to press keys into');
  assert.equal(canQuickAnswer(blocked(), PANE, true), false, 'read-only window');
  assert.equal(canQuickAnswer(blocked({ agentStatusKind: 'question' }), PANE), false, 'a question is answered on its card');
  assert.equal(canQuickAnswer(blocked({ agentStatus: 'working' }), PANE), false);
  assert.equal(canQuickAnswer(blocked({ agentStatusMsg: null }), PANE), false, 'nothing to name the prompt by');
  assert.equal(canQuickAnswer(blocked({ agentStatusMsg: '  ' }), PANE), false);
});

test('never on a machine-made session (read-only sub-sessions)', () => {
  assert.equal(canQuickAnswer(blocked({ isChildTask: true }), PANE), false);
  assert.equal(canQuickAnswer(blocked({ delegatedBy: 'parent' }), PANE), false);
  assert.equal(canQuickAnswer(blocked({ entrypoint: 'sdk-cli' }), PANE), false);
});

test('plan approval gets Deny only', () => {
  assert.equal(quickAllowOffered('approve Write: /work/toy.txt'), true);
  assert.equal(quickAllowOffered('approve plan'), false);
  assert.equal(quickAllowOffered('Approve plan: Toy plan'), false);
  assert.equal(quickAllowOffered(''), false);
  assert.equal(quickAllowOffered(null), false);
});

const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, target: { tagName: 'DIV' }, ...extra });

test('Cmd/Ctrl+Shift+Y allows and Cmd/Ctrl+Shift+N denies', () => {
  assert.equal(quickAnswerDecision(key('Y')), 'allow');
  assert.equal(quickAnswerDecision(key('n')), 'deny');
  assert.equal(quickAnswerDecision(key('y', { ctrlKey: false, metaKey: true })), 'allow');
  assert.equal(quickAnswerDecision(key('y', { shiftKey: false })), null);
  assert.equal(quickAnswerDecision(key('y', { altKey: true })), null);
  assert.equal(quickAnswerDecision(key('y', { ctrlKey: false })), null);
  assert.equal(quickAnswerDecision(key('x')), null);
  assert.equal(quickAnswerDecision(key('y', { repeat: true })), null, 'a held key answers once');
});

test('never while typing: text boxes, the composer and the raw terminal keep the keys', () => {
  assert.equal(quickAnswerDecision(key('y', { target: { tagName: 'TEXTAREA' } })), null, 'xterm\'s input and any textarea');
  assert.equal(quickAnswerDecision(key('y', { target: { tagName: 'INPUT', type: 'search' } })), null, 'rail search');
  assert.equal(quickAnswerDecision(key('y', { target: { tagName: 'DIV', isContentEditable: true } })), null, 'the composer');
  assert.equal(quickAnswerDecision(key('y', { target: { tagName: 'BUTTON' } })), 'allow');
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget(null), false);
});

test('the hint names the platform\'s keys', () => {
  assert.deepEqual(quickAnswerKeys('MacIntel'), { allow: '⌘⇧Y', deny: '⌘⇧N' });
  assert.deepEqual(quickAnswerKeys('Win32'), { allow: 'Ctrl+Shift+Y', deny: 'Ctrl+Shift+N' });
});

// The rail row, evaluated the way rail-clock.test.js does (no DOM).
test('a rail row on a permission prompt carries Allow / Deny naming the prompt and its seq', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const esbuild = require('esbuild');
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/sidebar/Sidebar.jsx'), 'utf8');
  const rowSource = source.slice(source.indexOf('const SessionRailRow ='), source.indexOf('function AccountBadge'));
  const QuickAnswer = () => null;
  let Row;
  vm.runInNewContext(esbuild.transformSync(`${rowSource}\nglobalThis.Row = SessionRailRow;`, { loader: 'jsx' }).code, {
    React: { memo: (fn) => fn, createElement: (type, props, ...children) => ({ type, props, children }) },
    set Row(value) { Row = value; },
    providerIdentity: () => ({}), AccountBadge: () => null, formatRelative: () => '',
    runStateCue: require('../../src/shared/session-run-state.cjs').runStateCue,
    railStatus: require('../../src/renderer/sidebar/rail-status.cjs').railStatus,
    subSessionReadOnly: require('../../src/shared/sub-sessions.cjs').subSessionReadOnly,
    canQuickAnswer, QuickAnswer,
  });
  const find = (node) => node && typeof node === 'object' && (node.type === QuickAnswer ? node : (node.children || []).flat(Infinity).map(find).find(Boolean));
  const row = Row({ session: { ...blocked(), paneId: 'p1', workspaceId: 'w1' }, clock: Date.now() });
  assert.match(row.props.className, /\bquick\b/);
  const quick = find(row);
  assert.equal(quick.props.expect, 'approve Write: /work/toy.txt');
  assert.equal(quick.props.expectSeq, 2);
  assert.equal(JSON.stringify(quick.props.pane), JSON.stringify(PANE));
  const idle = Row({ session: { ...blocked({ agentStatus: 'working' }), paneId: 'p1', workspaceId: 'w1' }, clock: Date.now() });
  assert.ok(!find(idle));
  assert.doesNotMatch(idle.props.className, /\bquick\b/);
});
