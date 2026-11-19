#!/usr/bin/env node
'use strict';

const util = require('node:util');
const { composeServer } = require('./compose.js');
// Its scheduled task starts it below normal; agents' sends run through here
// (daemon/interactive-priority.js).
require('../daemon/interactive-priority.js').raiseToInteractive();

async function main() {
  const composed = await composeServer();
  const address = await composed.listen();
  console.log(`harbor-server listening on ${address.address}:${address.port}`);
  console.log(`harbor-server token: ${composed.userDataDir}/server-token`);
  const stop = async () => { await composed.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return composed;
}

// EVERY SERVER LOG LINE CARRIES ITS TIME (2026-10-21). server.log had none, so
// a restart, a stall and a burst of link errors could not be put in order, and
// the audit could only guess at boot durations. Wrapped once, here at process
// start only: tests compose the server without this file and keep a plain
// console. util.format first, so a format string or an Error renders exactly
// as console would have rendered it, behind the stamp.
const STAMPED = Symbol.for('harbor.server.console-stamped');
function stampConsole(target = console, now = () => new Date()) {
  if (target[STAMPED]) return target;
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = target[method].bind(target);
    target[method] = (...args) => original(`${now().toISOString()} ${util.format(...args)}`);
  }
  target[STAMPED] = true;
  return target;
}

// A FAILED BOOT MUST END THE PROCESS (2026-10-21 audit). Setting exitCode was
// not enough: by the time a late step throws (an invalid token file, after the
// providers, watchers and ask inbox have started) their live handles keep node
// running, listening on nothing, and run-server.cmd only respawns a process
// that EXITS. Log it, give pending writes a moment, then exit 1 on an unref'd
// timer, so a process with nothing left alive still exits at once by itself.
function startFromCli({ run = main, exit = (code) => process.exit(code), log = console.error, graceMs = 2000 } = {}) {
  return run().catch((error) => {
    log('harbor-server: startup failed, exiting so run-server.cmd starts a fresh one:', error);
    process.exitCode = 1;
    setTimeout(() => exit(1), graceMs).unref?.();
  });
}

if (require.main === module) {
  stampConsole();
  startFromCli();
}

module.exports = { main, stampConsole, startFromCli };
