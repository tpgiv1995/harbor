#!/usr/bin/env node
'use strict';

// Isolated herdr session harness for manual and E2E terminal grid verification.
// Starts a named session with demo panes streaming live output. NEVER touches
// the live daemon socket.
//
//   node scripts/terminal-harness.js              3-pane demo session
//   node scripts/terminal-harness.js --stress     7-pane stress session
//   node scripts/terminal-harness.js --verify     run harness then electron verify
//   node scripts/terminal-harness.js --verify --stress   7-pane verify + lag check

const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { HerdrClient } = require('../src/main/herdr/client.js');

const HOME = os.homedir();
const HERDR_BIN = path.join(HOME, '.local/bin/herdr');
// The name comes from the caller when there is one. Two consecutive gate runs
// share a machine, and a FIXED session name is a shared namespace between them:
// run 1's teardown stops that daemon while run 2 is starting its own under the
// same name, so run 2 raced a socket being removed and died with
// `connect ENOENT .../harbor-terminal-harness/herdr.sock`. Run 1 always passed
// because it had the clean slate. (Same shape as the 2026-07-29 systemd unit
// name; a resource NAME is an ambient channel.)
const SESSION_NAME = process.env.HERDR_SESSION || 'harbor-terminal-harness';
const SESSION_DIR = path.join(HOME, '.config/herdr/sessions', SESSION_NAME);
const SOCKET_PATH = path.join(SESSION_DIR, 'herdr.sock');
const APP_ROOT = path.join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const stress = args.has('--stress');
const verify = args.has('--verify');
const paneTarget = stress ? 7 : 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanEnv() {
  const xdgRt = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return {
    HOME,
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    SHELL: '/bin/bash',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PATH: `${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_RUNTIME_DIR: xdgRt,
    HERDR_SESSION: SESSION_NAME,
  };
}

function socketExists() {
  try {
    const fs = require('fs');
    return fs.statSync(SOCKET_PATH).isSocket();
  } catch {
    return false;
  }
}

function stopNamedServer() {
  spawnSync(HERDR_BIN, ['server', 'stop'], { env: { ...cleanEnv() }, stdio: 'ignore', timeout: 8000 });
}

function deleteNamedSession() {
  spawnSync(HERDR_BIN, ['session', 'delete', SESSION_NAME], { env: { ...cleanEnv() }, stdio: 'ignore', timeout: 8000 });
}

async function startNamedServer() {
  if (socketExists()) stopNamedServer();
  deleteNamedSession();
  await sleep(300);

  const child = spawn(HERDR_BIN, ['server'], {
    env: cleanEnv(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const start = Date.now();
  while (!socketExists()) {
    if (Date.now() - start > 8000) throw new Error('named herdr socket never appeared');
    await sleep(150);
  }
  return SOCKET_PATH;
}

async function layoutPaneIds(client, tabId) {
  const snap = await client.snapshot();
  const layout = (snap.snapshot?.layouts || []).find((entry) => entry.tab_id === tabId);
  return (layout?.panes || []).map((pane) => pane.pane_id);
}

async function splitToPaneCount(client, tabId, rootPaneId, target) {
  let paneIds = await layoutPaneIds(client, tabId);
  let splitPaneId = rootPaneId;
  while (paneIds.length < target) {
    const direction = paneIds.length % 2 === 1 ? 'right' : 'down';
    await client.splitPane(splitPaneId, { direction, ratio: 0.5, focus: false });
    await sleep(250);
    paneIds = await layoutPaneIds(client, tabId);
    splitPaneId = paneIds[paneIds.length - 1] || splitPaneId;
    if (paneIds.length >= target) break;
  }
  return paneIds.slice(0, target);
}

async function startDemoOutput(client, paneIds) {
  for (let index = 0; index < paneIds.length; index += 1) {
    const paneId = paneIds[index];
    const label = `pane-${index + 1}`;
    const cmd = `(while true; do printf '\\r${label} tick %s   ' "$(date +%T)"; sleep 0.4; done) &`;
    await client.sendText(paneId, cmd);
    await client.sendKeys(paneId, ['enter']);
    await sleep(120);
  }
}

async function setupHarness() {
  await startNamedServer();
  const client = new HerdrClient({ socketPath: SOCKET_PATH });
  await client.assertProtocol();

  const ws = await client.createWorkspace({
    cwd: HOME,
    label: 'terminal-harness',
    focus: true,
  });
  const workspaceId = ws.workspace.workspace_id;
  const tab = await client.createTab({
    workspace_id: workspaceId,
    cwd: HOME,
    label: 'demo',
    focus: true,
  });
  const demoTabId = tab.tab.tab_id;
  const rootPaneId = tab.root_pane.pane_id;

  const snap = await client.snapshot();
  for (const other of snap.snapshot?.tabs || []) {
    if (other.tab_id !== demoTabId) {
      await client.closeTab(other.tab_id);
      await sleep(150);
    }
  }

  const paneIds = await splitToPaneCount(client, demoTabId, rootPaneId, paneTarget);
  await sleep(500);
  await startDemoOutput(client, paneIds);

  return {
    socketPath: SOCKET_PATH,
    workspaceId,
    tabId: tab.tab.tab_id,
    paneIds,
  };
}

function launchVerify(extraArgs = []) {
  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: SOCKET_PATH,
  };
  const electronArgs = ['.', '--verify-terminal', ...extraArgs];
  const child = spawn('npx', ['electron', ...electronArgs], {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`electron verify exited with code ${code}`));
    });
  });
}

async function main() {
  const info = await setupHarness();
  console.log('TERMINAL_HARNESS_READY');
  console.log(JSON.stringify({
    session: SESSION_NAME,
    socketPath: info.socketPath,
    paneCount: info.paneIds.length,
    paneIds: info.paneIds,
    stress,
  }, null, 2));
  console.log(`export HERDR_SOCKET_PATH=${info.socketPath}`);

  if (verify) {
    spawnSync('npm', ['run', 'build'], { cwd: APP_ROOT, stdio: 'inherit' });
    const extra = stress ? ['--stress-terminal'] : [];
    await launchVerify(extra);
    stopNamedServer();
    deleteNamedSession();
    return;
  }

  console.log('Harness is running. Press Ctrl+C to stop and tear down.');
  const onStop = () => {
    stopNamedServer();
    deleteNamedSession();
    process.exit(0);
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  stopNamedServer();
  deleteNamedSession();
  process.exit(1);
});
