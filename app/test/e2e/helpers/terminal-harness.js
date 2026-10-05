'use strict';

const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { APP_ROOT } = require('./paths.js');

const HOME = os.homedir();
const HERDR_BIN = path.join(HOME, '.local/bin/herdr');
// Per-process, so the gate's two consecutive runs cannot collide on it. A
// fixed name meant run 2 tore down and re-created the SAME named session run 1
// was still shutting down, and lost the race often enough to fail one pty spec
// per gate (a different one each time, always in run 2).
const SESSION_NAME = process.env.HARBOR_TERMINAL_HARNESS_SESSION
  || `harbor-terminal-harness-${process.pid}`;
const SESSION_DIR = path.join(HOME, '.config/herdr/sessions', SESSION_NAME);
const SOCKET_PATH = path.join(SESSION_DIR, 'herdr.sock');

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
    const fs = require('node:fs');
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

function teardownHarness() {
  stopNamedServer();
  deleteNamedSession();
}

function startHarness({ stress = false } = {}) {
  teardownHarness();
  return new Promise((resolve, reject) => {
    const args = ['scripts/terminal-harness.js'];
    if (stress) args.push('--stress');

    const child = spawn(process.execPath, args, {
      cwd: APP_ROOT,
      env: { ...process.env, ...cleanEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) {
        child.kill('SIGTERM');
        reject(new Error('terminal harness startup timed out'));
      }
    }, 30000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (ready || !stdout.includes('TERMINAL_HARNESS_READY')) return;

      const readyIdx = stdout.indexOf('TERMINAL_HARNESS_READY');
      const braceStart = stdout.indexOf('{', readyIdx);
      if (braceStart < 0) return;

      let depth = 0;
      let braceEnd = -1;
      for (let i = braceStart; i < stdout.length; i += 1) {
        if (stdout[i] === '{') depth += 1;
        else if (stdout[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            braceEnd = i;
            break;
          }
        }
      }
      if (braceEnd < 0) return;

      try {
        const info = JSON.parse(stdout.slice(braceStart, braceEnd + 1));
        ready = true;
        clearTimeout(timeout);
        resolve({
          child,
          socketPath: info.socketPath || SOCKET_PATH,
          paneCount: info.paneCount,
          paneIds: info.paneIds,
          session: SESSION_NAME,
        });
      } catch {
        // wait for more stdout chunks
      }
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`terminal harness exited early with code ${code}`));
      }
    });
  });
}

module.exports = {
  SESSION_NAME,
  SOCKET_PATH,
  startHarness,
  teardownHarness,
  socketExists,
};
