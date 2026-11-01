'use strict';
const { Pool } = require('../../src/shared/lane/pool.cjs');
const fs = require('node:fs');
const path = require('node:path');
const options = JSON.parse(process.argv[3]);
const mode = process.argv[2];
const pool = new Pool({ fault: step => {
  if (mode === 'slow' && step === 'after-claim') { fs.writeSync(1, 'PREPARING\n'); fs.readSync(0, Buffer.alloc(1), 0, 1, null); }
  if ((mode === 'crash' && step === 'after-reset') || (mode === 'release-crash' && step === 'after-detach')) process.exit(77);
} });
const lease = pool.lease({ ...options, ownerPid: process.pid });
if (mode === 'dirty') fs.writeFileSync(path.join(lease.path, 'unfinished.txt'), 'unfinished synthetic work');
if (mode === 'sealed' || mode === 'sealed-quarantined') pool.checkpoint({ ...lease, final: lease.baseSha });
if (mode === 'sealed-quarantined') pool.quarantine({ ...lease, reason: 'Synthetic coordinator hold' });
if (mode === 'release-crash') pool.release({ ...lease, final: lease.baseSha });
console.log(JSON.stringify(lease));
