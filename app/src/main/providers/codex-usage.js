'use strict';
const { spawn } = require('node:child_process');
const { cliCommand } = require('./cli-command.js');

function mapCodexUsage(response, now = new Date()) {
  const limits = response?.rateLimitsByLimitId ? response.rateLimitsByLimitId.codex : response?.rateLimits;
  if (!limits) return null;
  const result = { updatedAt: now.toISOString() };
  for (const w of [limits.primary, limits.secondary]) {
    const field = w?.windowDurationMins === 300 ? 'fiveHour' : w?.windowDurationMins === 10080 ? 'weekly' : null;
    if (!field || !Number.isFinite(w.usedPercent)) continue;
    result[`${field}Pct`] = w.usedPercent;
    if (Number.isFinite(w.resetsAt)) result[`${field}ResetsAt`] = w.resetsAt;
  }
  return Number.isFinite(result.fiveHourPct) || Number.isFinite(result.weeklyPct) ? result : null;
}

// Ask the installed CLI using its own account/auth implementation. No tokens,
// rollouts, prompts, or login flows are handled by Harbor.
function fetchCodexUsage(home, { bin = 'codex', env = process.env, spawnImpl = spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const command = cliCommand(env.HARBOR_CODEX_BIN || bin, ['app-server', '--stdio']);
    const childEnv = { ...env, CODEX_HOME: home, PATH: [...new Set([env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))].join(require('node:path').delimiter) };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    let child;
    try { child = spawnImpl(command.file, command.args, { env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let done = false, buffer = '';
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); child.stdin.destroy(); child.kill(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (value) => { if (!done) child.stdin.write(`${JSON.stringify(value)}\n`); };
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(null); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { finish(null); return; }
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (message.id === 2) finish(message.error ? null : mapCodexUsage(message.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'harbor', version: '0.1.0' }, capabilities: {} } });
  });
}
module.exports = { mapCodexUsage, fetchCodexUsage };
