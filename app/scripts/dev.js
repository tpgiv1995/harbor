'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const APP_ROOT = path.resolve(__dirname, '..');

// Node cannot spawn a Windows .cmd shim without a shell. Run the installed
// JavaScript CLI and Electron executable directly, including paths with spaces.
function startDev({ spawnProcess = spawn, electronBin = require('electron'), appRoot = APP_ROOT } = {}) {
  const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawnProcess(process.execPath, [viteCli, '--host', '127.0.0.1'], {
    cwd: appRoot, stdio: 'inherit', windowsHide: true,
  });
  let electron;
  let timer;
  let stopped = false;
  const stop = () => { stopped = true; clearTimeout(timer); electron?.kill(); vite.kill(); };
  const fail = (error) => { console.error(error.message); stop(); process.exitCode = 1; };
  vite.on('error', fail);
  vite.on('exit', (code) => { if (!stopped) { stop(); process.exitCode = code || 1; } });
  timer = setTimeout(() => {
    if (stopped) return;
    electron = spawnProcess(electronBin, [appRoot], {
      cwd: appRoot, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' },
    });
    electron.on('error', fail);
    electron.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
  }, 1000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { stop, vite };
}

if (require.main === module) startDev();
module.exports = { startDev };
