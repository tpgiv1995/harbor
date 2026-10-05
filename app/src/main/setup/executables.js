'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

// Check the selected file without launching it or starting a sign-in flow.
async function executablePath(bin, { env = process.env, platform = process.platform } = {}) {
  const value = String(bin || '').trim();
  if (!value) return null;
  const windows = platform === 'win32';
  const extensions = windows ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    .map((ext) => ext.trim().toLowerCase()).filter((ext) => /^\.[a-z0-9]+$/.test(ext)) : [];
  const explicit = /[\\/]/.test(value) || path.isAbsolute(value);
  const names = windows && !path.extname(value) ? [value, ...extensions.map((ext) => value + ext)] : [value];
  const candidates = explicit ? names : String(env.PATH || '').split(windows ? ';' : path.delimiter).filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir.replace(/^"|"$/g, ''), name)));
  for (const candidate of candidates) {
    if (windows && !explicit && path.extname(candidate) && !extensions.includes(path.extname(candidate).toLowerCase())) continue;
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, windows ? constants.F_OK : constants.X_OK);
      return path.resolve(candidate);
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

async function validateProviderExecutables(config, options) {
  for (const [provider, value] of Object.entries(config.providers || {})) {
    if (!value.enabled) continue;
    const bin = String(value.bin || '').trim();
    if (!bin || (!await executablePath(bin, options) && config.setup?.executableApprovals?.[provider] !== bin)) {
      throw new Error(`${provider} executable not found or not runnable: ${value.bin || '(empty)'}. Choose an installed CLI path before finishing setup.`);
    }
  }
}

module.exports = { executablePath, validateProviderExecutables };
