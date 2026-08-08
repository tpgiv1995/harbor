#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
// node-pty is a NATIVE module and it is declared in this directory's own
// package.json, not the app's, because the keeper runs under the system Node
// rather than Electron. A fresh clone that ran only `npm install` at the app
// level therefore used to reach this line and die with a bare MODULE_NOT_FOUND
// in the daemon log, which reads as "sessions just do not start" and names
// nothing a user could act on. `postinstall` now installs it, so this branch
// should be unreachable; it says what to run when it is not.
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    throw new Error(
      'node-pty is not installed, so this session cannot open a pty. '
      + 'Run `npm install` from the app directory (its postinstall installs the '
      + "daemon's own dependencies), or `npm run pack:daemon-deps` to install just "
      + 'those. Original error: ' + err.message,
    );
  }
  throw err;
}
const { ScreenModel } = require('./screen.js');
const { readRecords, writeRecord } = require('./ndjson.js');
const { ObserverWriter } = require('./observer-writer.js');
const { listenAddress } = require('./paths.js');
const { currentBootId } = require('./boot-id.js');

// Read once: this keeper cannot outlive the boot it started in, so the value it
// stamps must be the boot it started in even if /proc is unreadable later.
const bootId = currentBootId();

const configPath = process.argv[2];
if (!configPath) throw new Error('keeper requires a config path');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch {}
const statePath = config.state_path;
const socketPath = config.keeper_socket;
const observers = new Map();
let exit = null;

function persist(extra = {}) {
  const state = {
    id: config.id,
    argv: config.argv,
    cwd: config.cwd,
    agent: config.agent ?? null,
    agent_session: config.agent_session ?? null,
    cols: screen.terminal.cols,
    rows: screen.terminal.rows,
    pid: terminal.pid,
    keeper_pid: process.pid,
    keeper_socket: socketPath,
    created_at: config.created_at,
    // The only field that survives a reboot with its meaning intact. `exit`
    // cannot: a SIGKILLed keeper never reaches onExit to write one.
    boot_id: bootId,
    exit,
    ...extra,
  };
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function event(payload) {
  const value = { id: config.id, ...payload };
  for (const writer of observers.values()) {
    if (payload.type === 'frame') writer.send(value);
    else writeRecord(writer.socket, { type: 'event', event: value });
  }
}

const screen = new ScreenModel({ cols: config.cols, rows: config.rows });
const [file, ...args] = config.argv;
const terminal = pty.spawn(file, args, {
  name: 'xterm-256color',
  cwd: config.cwd,
  env: { ...config.env, TERM: config.env.TERM || 'xterm-256color' },
  cols: config.cols,
  rows: config.rows,
});

terminal.onData((data) => {
  screen.write(data);
  event({ type: 'frame', text: data, bytes: Buffer.from(data).toString('base64') });
});
terminal.onExit(({ exitCode, signal }) => {
  exit = { code: exitCode, signal, at: new Date().toISOString() };
  persist();
  event({ type: 'exit', exit });
  const delay = Number(process.env.HARBOR_SESSIOND_KEEPER_EXIT_DELAY_MS || 1000);
  setTimeout(shutdown, Number.isFinite(delay) && delay >= 0 ? delay : 1000).unref();
});

try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  readRecords(socket, async (record) => {
    const requestId = record.request_id;
    try {
      let result;
      const params = record.params || {};
      if (record.verb === 'observe') {
        observers.set(socket, new ObserverWriter(socket));
        result = { observing: true };
      } else if (record.verb === 'input') {
        if (exit) throw new Error(`session ${config.id} has exited`);
        if (typeof params.text !== 'string' && typeof params.bytes !== 'string') throw new Error('input requires text or base64 bytes');
        terminal.write(typeof params.text === 'string' ? params.text : Buffer.from(params.bytes, 'base64').toString('utf8'));
        result = { accepted: true };
      } else if (record.verb === 'resize') {
        if (!Number.isInteger(params.cols) || params.cols < 1) throw new Error('cols must be a positive integer');
        if (!Number.isInteger(params.rows) || params.rows < 1) throw new Error('rows must be a positive integer');
        terminal.resize(params.cols, params.rows);
        screen.resize(params.cols, params.rows);
        persist();
        result = { cols: params.cols, rows: params.rows };
      } else if (record.verb === 'screen') {
        result = await screen.read(params.scrollback || 0);
      } else if (record.verb === 'process') {
        result = { pid: terminal.pid, running: exit === null, exit };
      } else if (record.verb === 'terminate') {
        if (!exit) {
          const signal = params.signal || 'SIGTERM';
          // WINDOWS HAS NO SIGNALS (2026-08-06, caught closing a real session
          // on real hardware). `process.kill(-pid, ...)` needs POSIX process
          // groups, and node-pty's own kill REFUSES a signal argument there,
          // throwing "Signals not supported on windows" out of the fallback the
          // POSIX path relies on. So terminate ends the session with no signal,
          // which is what node-pty offers, and there is no grace escalation to
          // schedule because the first call is already the forceful one.
          if (process.platform === 'win32') {
            try { terminal.kill(); } catch { /* already gone */ }
          } else {
            try { process.kill(-terminal.pid, signal); }
            catch { terminal.kill(signal); }
            if (signal !== 'SIGKILL') {
              const graceMs = Number.isInteger(params.grace_ms) ? Math.max(0, params.grace_ms) : 1500;
              setTimeout(() => {
                if (!exit) {
                  try { process.kill(-terminal.pid, 'SIGKILL'); }
                  catch { terminal.kill('SIGKILL'); }
                }
              }, graceMs).unref();
            }
          }
        }
        result = { signaled: !exit, signal: params.signal || 'SIGTERM' };
      } else throw new Error(`unsupported keeper verb: ${record.verb}`);
      writeRecord(socket, { type: 'response', request_id: requestId, ok: true, result });
    } catch (error) {
      writeRecord(socket, { type: 'response', request_id: requestId, ok: false, error: error.message });
    }
  }, (error) => writeRecord(socket, { type: 'error', error: error.message }));
  socket.on('close', () => observers.delete(socket));
});
// Windows binds a named pipe, which is not a file: nothing to chmod.
server.listen(listenAddress(socketPath), () => {
  if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  persist();
});

function shutdown() {
  for (const socket of observers.keys()) socket.destroy();
  server.close(() => {
    try { fs.unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
