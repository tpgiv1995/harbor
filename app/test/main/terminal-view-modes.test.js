'use strict';

// A >_ view starts with the pane's input modes (2026-10-24, the /mcp + >_ dead
// end). The view is a fresh xterm; Claude Code turned mouse reporting on at
// startup and repeats it only on some triggers, so the view used to open with
// clicks selecting text instead of reaching the CLI. The daemon's screen model
// reports the modes it has seen and the backfill carries them
// (terminal-bridge.js modeSequence). Reproduced against the real CLI by
// scripts/drive-mcp-tty-win.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
// What Claude Code 2.1.303 leaves set (measured: ?1000h ?1002h ?1003h ?1006h,
// bracketed paste on, cursor hidden).
const CLAUDE_MODES = { mouseTracking: 'any', mouseEncoding: 'SGR', bracketedPaste: true, applicationCursorKeys: false, sendFocus: false, cursorHidden: true };

function harness(modes) {
  const subscription = Object.assign(new EventEmitter(), { close() {} });
  const pane = { pane_id: 'c1', agent: 'claude' };
  const snapshot = { workspaces: [{ workspace_id: 'c1' }], tabs: [{ tab_id: 'c1', workspace_id: 'c1' }], panes: [pane], layouts: [{ tab_id: 'c1', panes: [pane] }] };
  class FakeDaemon {
    async bootstrap() { return { snapshot, subscription }; }
    async snapshot() { return { snapshot }; }
    // The shape session-daemon/client.js readPane returns: the read plus the screen it came from.
    async readPane() { return { read: { text: 'line one\nline two' }, screen: { visible: 'line two', ...(modes === undefined ? {} : { modes }) } }; }
    async sendInput() { return { accepted: true }; }
    focusPane() { return Promise.resolve({ ok: true }); }
    focusWorkspace() { return Promise.resolve({ ok: true }); }
  }
  const supervisor = new EventEmitter();
  supervisor.attachObserver = (paneId) => ({ paneId, ready: tick().then(() => true) });
  supervisor.detach = () => {};
  supervisor.releaseControl = () => {};
  supervisor.reset = () => {};
  supervisor.resize = () => {};
  const bridge = createTerminalBridge({
    createControlClient: () => new FakeDaemon(),
    createStreamSupervisor: () => supervisor,
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond' },
    sessionStorePolicy: { allowed: true },
  });
  bridge.emitter.on('error', () => {});
  const backfills = [];
  bridge.emitter.on('backfill', (event) => backfills.push(event.text));
  return { bridge, backfills };
}

test('a view opening on a pane whose CLI turned on mouse reporting gets the same switches with its backfill', async () => {
  const { bridge, backfills } = harness(CLAUDE_MODES);
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1', cols: 100, rows: 30 }]);
  assert.equal(backfills.length, 1);
  const text = backfills[0];
  assert.ok(text.startsWith('line one\r\nline two'), 'the history still comes first, CRLF-terminated');
  for (const seq of ['\x1b[?1003h', '\x1b[?1006h', '\x1b[?2004h', '\x1b[?25l']) {
    assert.ok(text.includes(seq), `the backfill carries ${JSON.stringify(seq)}`);
  }
  assert.ok(text.indexOf('\x1b[?1003h') < text.indexOf('\x1b[?1006h'), 'tracking before encoding, as the CLI sends them');
  bridge.close();
});

test('a pane with no mouse reporting says so, and bracketed paste off is honored', async () => {
  const { bridge, backfills } = harness({ mouseTracking: 'none', mouseEncoding: 'DEFAULT', bracketedPaste: false, applicationCursorKeys: true, sendFocus: false, cursorHidden: false });
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  const text = backfills[0];
  assert.ok(!/\x1b\[\?100[0236]h/.test(text), 'no mouse switch turned on');
  assert.ok(text.includes('\x1b[?2004l'), 'bracketed paste off overrides the view\'s assumption');
  assert.ok(text.includes('\x1b[?1h'), 'application cursor keys copied');
  assert.ok(text.includes('\x1b[?25h'), 'cursor shown');
  bridge.close();
});

test('a keeper from before this change reports no modes, and the backfill is exactly the old one', async () => {
  const { bridge, backfills } = harness(undefined);
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  assert.deepEqual(backfills, ['line one\r\nline two']);
  bridge.close();
});
