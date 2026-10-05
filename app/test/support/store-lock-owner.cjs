'use strict';

const fs = require('node:fs');
const path = require('node:path');
const [lock, mode] = process.argv.slice(2);
fs.mkdirSync(lock);
fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
if (mode === 'stale') {
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lock, past, past);
  process.stdout.write('ready');
} else {
  const timer = setTimeout(() => process.exit(2), 10000);
  process.stdin.once('data', () => {
    clearTimeout(timer);
    fs.rmSync(lock, { recursive: true, force: true });
    process.stdin.destroy();
  });
  process.stdout.write('ready');
}
