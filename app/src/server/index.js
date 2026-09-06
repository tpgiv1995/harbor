#!/usr/bin/env node
'use strict';

const { composeServer } = require('./compose.js');

async function main() {
  const composed = await composeServer();
  const address = await composed.listen();
  console.log(`harbor-server listening on ${address.address}:${address.port}`);
  console.log(`harbor-server token: ${composed.userDataDir}/server-token`);
  const stop = async () => { await composed.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return composed;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { main };
