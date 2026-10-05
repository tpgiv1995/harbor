'use strict';

// A PACKAGED HARBOR LAUNCHED FROM FINDER OR THE DOCK GETS LAUNCHD'S PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`), and every session it starts inherits it.
// Homebrew lives in `/opt/homebrew/bin`, so `claude`, `codex`, `op` and every
// hook or tool a session shells out to are simply not found there. It only
// ever worked from `npm start`, which inherits a developer's terminal PATH
// (2026-10-05, first packaged build on the M5 Max). script-exec.js already
// names the interpreter for Harbor's own scripts; this closes the same hole
// for the provider CLIs and everything they run.
//
// The fix asks the user's own login shell once, at startup, for its PATH and
// adopts it. A sentinel brackets the value because rc files may print banners.
// Bounded by a timeout, never throws, and a PATH that already has Homebrew on
// it (a terminal launch) is left alone. If the shell cannot answer, the usual
// Homebrew and /usr/local bins are appended so the CLIs are still found.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MARK = '__HARBOR_LOGIN_PATH__';
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

function parseShellPath(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf(MARK);
  const end = text.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return null;
  const value = text.slice(start + MARK.length, end).trim();
  return value.includes('/') ? value : null;
}

function mergePaths(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const dir of String(list || '').split(path.delimiter)) {
      if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); }
    }
  }
  return out.join(path.delimiter);
}

function resolveLoginPath({ env = process.env, platform = process.platform, exec = execFileSync, timeoutMs = 4000 } = {}) {
  const current = env.PATH || '';
  if (platform !== 'darwin') return { path: current, source: 'unchanged (not macOS)' };
  if (current.split(path.delimiter).includes('/opt/homebrew/bin')) return { path: current, source: 'unchanged (already has Homebrew)' };
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  try {
    const stdout = exec(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, HARBOR_LOGIN_PATH_PROBE: '1' },
    });
    const shellPath = parseShellPath(stdout);
    if (shellPath) return { path: mergePaths(shellPath, current), source: `login shell ${shell}` };
  } catch { /* fall through to the fixed dirs */ }
  return { path: mergePaths(current, FALLBACK_DIRS.join(path.delimiter)), source: 'fallback dirs' };
}

// Mutates process.env.PATH once; returns what it did so the caller can log it.
function applyLoginPath(options = {}) {
  const env = options.env || process.env;
  const result = resolveLoginPath({ ...options, env });
  env.PATH = result.path;
  return result;
}

module.exports = { applyLoginPath, resolveLoginPath, parseShellPath, mergePaths, MARK };
