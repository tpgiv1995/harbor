'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const esbuild = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/sidebar/Sidebar.jsx'), 'utf8');
const rowSource = source.slice(source.indexOf('const SessionRailRow ='), source.indexOf('function AccountBadge'));
const treeFind = (node, className) => node && typeof node === 'object' && (node.props?.className === className ? node : (node.children || []).flat(Infinity).map((child) => treeFind(child, className)).find(Boolean));
test('unchanged memoized rail rows age their label, turn signal and owner beacon on one coarse clock', () => {
  let Row;
  vm.runInNewContext(esbuild.transformSync(rowSource + '\nglobalThis.Row = SessionRailRow;', { loader: 'jsx' }).code, {
    React: { memo: (fn) => fn, createElement: (type, props, ...children) => ({ type, props, children }) },
    set Row(value) { Row = value; },
    providerIdentity: () => ({}), AccountBadge: () => null,
    formatRelative: require('../../src/shared/date-roll.cjs').formatRelative,
    runStateCue: require('../../src/shared/session-run-state.cjs').runStateCue,
    railStatus: require('../../src/renderer/sidebar/rail-status.cjs').railStatus,
    subSessionReadOnly: require('../../src/shared/sub-sessions.cjs').subSessionReadOnly,
    canQuickAnswer: require('../../src/shared/session-run-state.cjs').canQuickAnswer, QuickAnswer: () => null,
  });
  const start = new Date(2026, 0, 1, 10).getTime();
  const session = { lastActive: '2026-01-01 10:00', background: { working: true, lastInTurnMs: start }, ownerEvidence: { beaconMs: start } };
  const render = (clock) => Row({ session, clock });
  assert.deepEqual(treeFind(render(start), 'sr-tm').children, ['just now']);
  assert.equal(treeFind(render(start), 'sr-d running')?.props['data-status'], 'running');
  assert.equal(treeFind(render(start + 4 * 60000), 'sr-d ready')?.props['data-status'], 'ready');
  assert.equal(treeFind(render(start + 11 * 60000), 'sr-d stopped')?.props['data-status'], 'stopped');
  assert.deepEqual(treeFind(render(start + 90 * 60000), 'sr-tm').children, ['2h ago']);
  assert.match(source, /setInterval\([^\n]*15_000/);
  assert.match(source, /<SessionRailRow[^>]*clock=\{clock\}/);
});
