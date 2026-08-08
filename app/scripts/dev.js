const { spawn } = require('node:child_process');

const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1'], {
  stdio: 'inherit',
});

let electron;

const launchElectron = () => {
  electron = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.'],
    { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' } },
  );
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
};

setTimeout(launchElectron, 1000);

const stop = () => {
  electron?.kill();
  vite.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
