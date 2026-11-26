// Host: spawns the child in a ConPTY exactly like Harbor's keeper (node-pty, useConpty), records the raw output bytes,
// and answers the 7501 query if it arrives, to see whether the answer reaches the child's stdin.
const { createRequire } = require('module');
const req = createRequire('C:/dev/harbor/app/src/daemon/package.json');
const pty = req('node-pty');
const p = pty.spawn(process.execPath, ['C:/dev/harbor/docs/orchestration/2026-11-26-oss-survey/osc7501-conpty-child.cjs'], { cols: 100, rows: 20, useConpty: true, windowsHide: true, env: process.env });
let out = '';
let answered = false;
p.onData((d) => {
  out += d;
  if (!answered && d.includes('\x1b]7501;?')) { answered = true; p.write('\x1b]7501;?\x1b\\'); }
});
p.onExit(() => {
  const show = out.replace(/\x1b/g, '<ESC>').replace(/\x07/g, '<BEL>');
  console.log('raw 7501 reports seen by host:', (out.match(/\x1b\]7501;[^\x07\x1b]*/g) || []).map((s) => s.replace(/\x1b/g, '<ESC>')));
  console.log('host answered the query:', answered);
  console.log('child line:', (show.match(/CHILD-STDIN=[^\r\n]*/) || ['(none)'])[0]);
  process.exit(0);
});
setTimeout(() => { console.log('timeout; raw so far:', out.replace(/\x1b/g, '<ESC>').slice(0, 600)); process.exit(1); }, 8000);
