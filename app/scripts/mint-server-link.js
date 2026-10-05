#!/usr/bin/env node
'use strict';

// One command that prints the phone connect URL:
//   https://<host>/#token=<token>&url=<ws-origin>
//
// Reads the server-token through ensureServerToken, which CREATES one when
// none exists yet (first run); delete the file and restart the server for
// rotation. Discovers the MagicDNS name
// the same way compose.js does, falling back to loopback when Tailscale is
// down so the operator still gets a pasteable local URL.

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { defaultUserDataDir } = require('../src/shared/tasks-file.cjs');
const { ensureServerToken } = require('../src/server/transport/auth.js');
const { resolveSelfMagicDnsName } = require('../src/server/compose.js');

function usage() {
  console.log(`Usage: node scripts/mint-server-link.js [options]

Prints the one-tap phone connect link for harbor-server.

Options:
  --host <name>     Override the public hostname (default: MagicDNS, else 127.0.0.1)
  --port <n>        Server port for the url= query (default: HARBOR_SERVER_PORT or 8787)
  --https           Force https:// on the link host (default when MagicDNS is used)
  --http            Force http:// on the link host (default for loopback)
  --user-data <dir> Token directory (default: Harbor userData / HARBOR_USER_DATA_DIR)
  --token-file <f>  Read this token file instead of <userData>/server-token
`);
}

function parseArgs(argv) {
  const out = {
    host: null,
    port: Number(process.env.HARBOR_SERVER_PORT || 8787),
    scheme: null,
    userDataDir: process.env.HARBOR_USER_DATA_DIR || defaultUserDataDir(),
    tokenFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (arg === '--https') { out.scheme = 'https'; continue; }
    if (arg === '--http') { out.scheme = 'http'; continue; }
    if (arg === '--host') { out.host = argv[++i]; continue; }
    if (arg === '--port') { out.port = Number(argv[++i]); continue; }
    if (arg === '--user-data') { out.userDataDir = argv[++i]; continue; }
    if (arg === '--token-file') { out.tokenFile = argv[++i]; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function readToken(opts) {
  if (opts.tokenFile) {
    const token = (await fs.readFile(opts.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`invalid token in ${opts.tokenFile}`);
    return { token, tokenPath: opts.tokenFile };
  }
  const tokenPath = path.join(opts.userDataDir, 'server-token');
  try {
    const token = await ensureServerToken(opts.userDataDir);
    return { token, tokenPath };
  } catch (error) {
    throw new Error(`cannot read server token at ${tokenPath}: ${error.message}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { token, tokenPath } = await readToken(opts);
  const magic = opts.host || await resolveSelfMagicDnsName({ env: process.env, execFileImpl: execFile });
  const host = magic || '127.0.0.1';
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const scheme = opts.scheme || (isLoopback ? 'http' : 'https');
  // The phone's page origin is what the PWA is served as (Serve on 443 => no
  // port in the URL). The url= query tells the client which WS origin to use
  // when the page was opened from a file or a different host; for the normal
  // Serve flow it matches the page origin.
  const pageOrigin = isLoopback
    ? `${scheme}://${host}:${opts.port}`
    : `${scheme}://${host}`;
  const wsUrl = pageOrigin;
  const link = `${pageOrigin}/#token=${token}&url=${encodeURIComponent(wsUrl)}`;

  console.log(link);
  console.log(`# token file: ${tokenPath}`);
  console.log(`# host: ${host}${magic && !opts.host ? ' (MagicDNS)' : ''}`);
  if (isLoopback) {
    console.log('# note: loopback link only works on this machine; run with Tailscale up for a phone URL');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main };
