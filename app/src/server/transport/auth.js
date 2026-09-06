'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { methodChannel } = require('../../main/rpc/channels.js');

async function ensureServerToken(userDataDir) {
  const file = path.join(userDataDir, 'server-token');
  await fs.mkdir(userDataDir, { recursive: true });
  try {
    const token = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`harbor-server: invalid token file ${file}`);
    await fs.chmod(file, 0o600);
    return token;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(`${token}\n`, 'utf8'); } finally { await handle.close(); }
    return token;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return ensureServerToken(userDataDir);
  }
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(candidate); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorizeMethod(method, { authenticated = false } = {}) {
  const channel = methodChannel(method);
  if (!channel) throw new Error(`unknown RPC method: ${method}`);
  if (channel.capability === 'local-only') throw new Error(`RPC method '${method}' is local-only and is refused by harbor-server`);
  if (channel.capability === 'mutating' && !authenticated) throw new Error(`authentication required for RPC method '${method}'`);
  return channel;
}

module.exports = { ensureServerToken, tokenMatches, authorizeMethod };
