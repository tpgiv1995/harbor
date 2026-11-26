// Real Codex CLI in a ConPTY (node-pty from Harbor's daemon), no prompt sent, no answer to any query.
// Prints every OSC 7501 (and Codex's own OSC 21337) sequence it wrote in 20 seconds.
// Usage: node osc7501-codex-startup.cjs <scratch folder> <codex.exe path>
const { createRequire } = require('module');
const pty = createRequire('C:/dev/harbor/app/src/daemon/package.json')('node-pty');
const [ws, exe] = process.argv.slice(2);
const p = pty.spawn(exe, ['--no-alt-screen'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: true, windowsHide: true });
let out = '';
p.onData((d) => { out += d; });
setTimeout(() => {
  const hits = out.match(/\x1b\](7501|21337);[^\x07\x1b]*/g) || [];
  const screen = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\s+/g, ' ');
  console.log(`bytes=${out.length} osc=${JSON.stringify(hits.map((h) => h.slice(1)))}`);
  console.log('screen words:', screen.slice(0, 260));
  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 800);
}, 20000);
