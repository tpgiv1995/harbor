'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { test, expect } = require('@playwright/test');

const { launchHarbor, closeHarbor } = require('./helpers/electron.js');
const { APP_ROOT } = require('./helpers/paths.js');
const { SessionDaemonClient } = require('../../src/main/session-daemon/client.js');
const { legacyConfig } = require('../../src/main/config/migrate.js');
// A pane's agent_session is the herdr-shaped `{ kind: 'id', value }`, not a
// bare string, and reading `.value` by hand here would be a second copy of a
// rule the product already owns. Interpolating the object produced a selector
// for `[object Object]`, which then failed as if the rail were broken.
const { sessionAgentId } = require('../../src/shared/sidebar-model.cjs');

const DAEMON = path.join(APP_ROOT, 'src/daemon/daemon.js');
const E2E_HOME_ROOT = path.join(APP_ROOT, '.e2e-home');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function startIsolatedSessiond() {
  fs.mkdirSync(E2E_HOME_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(E2E_HOME_ROOT, 'sessiond-'));
  const sessionDir = path.join(root, 'sessiond');
  const userData = path.join(root, 'profile');
  const contextDir = path.join(root, 'context');
  const fakeHome = path.join(root, 'home');
  const projectDir = path.join(fakeHome, 'dev', 'project');
  const fakeBinDir = path.join(fakeHome, '.local', 'bin');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  // Named to match the real CLI bin/ai now execs (2026-08-07: claude-go was
  // an unshipped wrapper; bin/ai composes `claude --dangerously-skip-permissions`
  // directly). This stub must carry the same name or the real launch never
  // resolves it off PATH.
  const launcher = path.join(fakeBinDir, 'claude');
  fs.writeFileSync(launcher, [
    '#!/bin/bash',
    "printf 'SESSIOND_BOOT_FRAME\\n'",
    "exec /bin/bash --noprofile --norc",
    '',
  ].join('\n'), { mode: 0o755 });

  const historicalId = randomUUID();
  const transcriptDir = path.join(fakeHome, '.claude', 'projects', '-sessiond-e2e-project');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${historicalId}.jsonl`), `${JSON.stringify({
    type: 'user',
    cwd: projectDir,
    timestamp: new Date().toISOString(),
    message: { content: 'Sessiond launch anchor' },
  })}\n`);

  const socketPath = path.join(sessionDir, 'sessiond.sock');
  const env = {
    ...process.env,
    HOME: fakeHome,
    HARBOR_SESSION_BACKEND: 'sessiond',
    HARBOR_SESSIOND_DIR: sessionDir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_CONTEXT_DIR: contextDir,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_E2E_FAKE_LAUNCH: '0',
    HARBOR_ALLOW_REAL_LAUNCH: '1',
    HERDR_SOCKET_PATH: path.join(root, 'never-real-herdr.sock'),
  };
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    `${JSON.stringify(legacyConfig({ homedir: fakeHome, env }), null, 2)}\n`,
  );
  const daemon = spawn(process.execPath, [DAEMON], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionDaemonClient({ socketPath, env });
  await waitUntil(async () => {
    try { return (await client.ping()).ok; } catch { return false; }
  }, `isolated sessiond did not answer health, stderr=${stderr}`);
  return { root, env, daemon, client, projectDir };
}

async function stopIsolatedSessiond(harness) {
  if (!harness) return;
  try {
    for (const pane of await harness.client.listPanes()) {
      await harness.client.closePane(pane.pane_id).catch(() => {});
    }
  } catch {}
  harness.client.close();
  if (harness.daemon.exitCode === null) {
    harness.daemon.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => harness.daemon.once('exit', resolve)),
      sleep(3000),
    ]);
  }
  if (harness.daemon.exitCode === null) harness.daemon.kill('SIGKILL');
  fs.rmSync(harness.root, { recursive: true, force: true });
  try { fs.rmdirSync(E2E_HOME_ROOT); } catch {}
}

test.describe('Harbor on the sessiond backend', () => {
  let harness;
  let paneId;
  let sessionId;

  test.beforeAll(async () => {
    harness = await startIsolatedSessiond();
  });

  test.afterAll(async () => stopIsolatedSessiond(harness));

  test('Harbor launches a real sessiond session that appears, streams, accepts typing, and agrees with a screen read', async () => {
    const { electronApp, page } = await launchHarbor(harness.env);
    try {
      const project = page.locator('.sidebar-project-wrap', {
        has: page.locator('.pg-label', { hasText: /^project$/ }),
      }).first();
      await project.hover();
      await project.getByTitle(/^New Personal session/).click();

      const launched = await waitUntil(async () => {
        const panes = await harness.client.listPanes();
        return panes.find((pane) => pane.agent === 'claude' && pane.agent_session);
      }, 'Harbor launch did not create an identified sessiond pane', 15000);
      paneId = launched.pane_id;
      sessionId = sessionAgentId(launched.agent_session);
      expect(sessionId, 'the launched pane must carry a real session id').toBeTruthy();
      expect(launched.cwd).toBe(harness.projectDir);

      const row = page.locator(`.sr[data-session-id="${sessionId}"]`);
      await expect(row, 'the Harbor-launched sessiond pane must appear in the rail immediately').toBeVisible();

      // A live session must join its project's EXISTING group, not start a
      // second one. The rail groups by project label as a plain string, so a
      // backend that labels a workspace with the raw cwd splits one folder in
      // two: live sessions under an absolute path, their history under the real
      // name. Asserting the label set (not just that the row exists) is what
      // catches that, because the row is present either way.
      const projectLabels = await page.locator('.pg-label').allTextContents();
      expect(projectLabels, 'the launched session joins the existing project group').toEqual(['project']);
      await row.click();

      const tile = page.locator(`.win2[data-session-id="${sessionId}"]`);
      await expect(tile).toBeVisible();
      await tile.locator('.ico.tty').click();
      const terminal = tile.locator('.terminal-pane');
      await expect(terminal).toBeVisible();
      await expect.poll(async () => terminal.locator('.xterm-rows').innerText(), {
        message: 'the terminal view must backfill the real pty boot output',
      }).toContain('SESSIOND_BOOT_FRAME');

      const streamedMarker = `SESSIOND_LIVE_FRAME_${Date.now()}`;
      await harness.client.sendText(paneId, `printf '${streamedMarker}\\n'\n`);
      await expect.poll(async () => terminal.locator('.xterm-rows').innerText(), {
        message: 'the terminal view must stream output produced after attachment',
      }).toContain(streamedMarker);

      const typedMarker = `SESSIOND_TYPED_${Date.now()}`;
      await terminal.click();
      await page.keyboard.type(`printf '${typedMarker}\\n'`);
      await page.keyboard.press('Enter');
      await expect.poll(async () => terminal.locator('.xterm-rows').innerText(), {
        message: 'typing in the real UI must reach the sessiond pty and echo back',
      }).toContain(typedMarker);

      const screen = await harness.client.readPane(paneId, { lines: 200 });
      expect(screen.read.text, 'sessiond screen read must contain what Harbor displays').toContain(streamedMarker);
      expect(screen.read.text, 'sessiond screen read must contain the command typed through Harbor').toContain(typedMarker);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // The whole codex identity pipeline, driven through the real app on real
  // machinery with only the codex FILES fabricated (2026-08-08, from Pat's
  // live failure: a codex window showing an empty terminal and "has not named
  // its session yet" while the session wrote a 4.5MB conversation unseen).
  // Three fixes prove out together, and each had its own way of failing:
  //
  //   1. The fallback terminal is FED: the tile rendered an xterm the
  //      visible-pane registration never attached an observer to, so it showed
  //      nothing, ever (terminal-view.cjs is the shared rule now).
  //   2. The pane is NAMED from codex's own files by the production linker.
  //      The session_meta here is deliberately larger than the old 8KB head
  //      read, the real shape of codex 0.147.0 (18KB of embedded
  //      base_instructions): under the old reader the cwd read failed on every
  //      rollout, the linker never landed a link, and this spec's second half
  //      cannot pass.
  //   3. The live:<paneId> WINDOW FOLLOWS the link. When the link lands, the
  //      live: rail row becomes the real-id row, and a window that cannot
  //      upgrade stops resolving a session at all and vanishes from the stage.
  test('a codex pane streams its terminal, is named from its own files, and its window follows', async () => {
    const { electronApp, page } = await launchHarbor(harness.env);
    let codexPaneId = null;
    try {
      const fakeHome = harness.env.HOME;
      const spawned = await harness.client.createWorkspace({
        argv: ['/bin/bash', '--noprofile', '--norc'],
        cwd: harness.projectDir,
        env: { PATH: process.env.PATH, HOME: fakeHome, TERM: 'xterm-256color' },
        agent: 'codex',
      });
      codexPaneId = spawned.pane_id;
      await harness.client.sendText(codexPaneId, "printf 'CODEX_FALLBACK_MARKER\\n'; exec cat\n");

      // The unnamed pane lists under its live: key: the rail is the only
      // browser, and an invisible running agent is a dead end.
      const liveKey = `live:${codexPaneId}`;
      const row = page.locator(`.sr[data-session-id="${liveKey}"]`);
      await expect(row, 'an unnamed codex pane must appear in the rail').toBeVisible({ timeout: 20000 });
      await row.click();

      const liveTile = page.locator(`.win2[data-session-id="${liveKey}"]`);
      await expect(liveTile).toBeVisible({ timeout: 15000 });
      await expect(liveTile.locator('.terminal-provider-note')).toBeVisible({ timeout: 15000 });

      // Fix 1: the fallback terminal backfills what the pane already shows and
      // streams what it produces next, without the >_ toggle ever being
      // touched. Before the shared terminal-view rule this xterm had no
      // observer: black box, both assertions fail.
      const terminal = liveTile.locator('.terminal-pane');
      await expect(terminal).toBeVisible({ timeout: 15000 });
      await expect.poll(async () => terminal.locator('.xterm-rows').innerText(), {
        message: 'the fallback terminal must backfill the pane content',
        timeout: 20000,
      }).toContain('CODEX_FALLBACK_MARKER');
      const streamed = `CODEX_LIVE_${Date.now()}`;
      await harness.client.sendText(codexPaneId, `${streamed}\n`);
      await expect.poll(async () => terminal.locator('.xterm-rows').innerText(), {
        message: 'the fallback terminal must stream frames produced after attach',
        timeout: 20000,
      }).toContain(streamed);

      // Now codex's own files materialize, the way a real first message writes
      // them. The linker reads these with production code paths only.
      const codexId = '019fe010-da88-7c13-b551-983471300001';
      const day = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const rolloutDir = path.join(
        fakeHome, '.codex', 'sessions',
        String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()),
      );
      fs.mkdirSync(rolloutDir, { recursive: true });
      const promptText = 'codex e2e adversarial review prompt';
      fs.writeFileSync(path.join(rolloutDir, `rollout-e2e-${codexId}.jsonl`), [
        JSON.stringify({
          timestamp: day.toISOString(),
          type: 'session_meta',
          payload: {
            session_id: codexId,
            cwd: harness.projectDir,
            originator: 'codex-tui',
            // The real 0.147.0 shape: the whole system prompt rides in the
            // meta line, pushing it past any fixed-size head read.
            base_instructions: { text: 'You are Codex. '.repeat(1300) },
          },
        }),
        // The 0.147.0 item stream, today's real message shape (the old
        // user_message/agent_message events keep their own unit coverage).
        JSON.stringify({
          timestamp: day.toISOString(),
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: promptText }] } },
        }),
        JSON.stringify({
          timestamp: day.toISOString(),
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'CODEX_E2E_REPLY_MARKER' }] } },
        }),
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(fakeHome, '.codex', 'history.jsonl'), `${JSON.stringify({
        session_id: codexId, ts: Math.floor(Date.now() / 1000), text: promptText,
      })}\n`);

      // Fixes 2 and 3 land together: the linker names the pane from the files,
      // the rail row takes the real id, and the SAME open window follows it.
      const realTile = page.locator(`.win2[data-session-id="${codexId}"]`);
      await expect(realTile, 'the window must adopt the session id the linker resolved').toBeVisible({ timeout: 30000 });
      await expect(page.locator(`.win2[data-session-id="${liveKey}"]`)).toHaveCount(0);

      // And it is a DESIGNED window now: the conversation renders from the
      // rollout on disk, terminal note gone.
      await expect(realTile.locator('.terminal-provider-note')).toHaveCount(0);
      await expect(realTile.locator('.conv-body'), 'the adopted window renders the conversation').toContainText('CODEX_E2E_REPLY_MARKER', { timeout: 20000 });
    } finally {
      if (codexPaneId) await harness.client.closePane(codexPaneId).catch(() => {});
      await closeHarbor(electronApp, page);
    }
  });
});
