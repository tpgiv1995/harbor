// Real Claude Code in a ConPTY (node-pty from Harbor's daemon, the keeper's settings), no prompt sent.
// Mode "answer": the host answers Claude's `ESC ] 7501 ; ? ST` question the moment it appears. Mode "silent": it does not.
// Prints every 7501 sequence Claude wrote. Any `state=` report in "answer" mode proves the answer reached Claude.
// Usage: node osc7501-claude-startup.cjs <scratch folder> <answer|silent> [debug log file] [node-pty package folder] [dll]
// The 4th argument loads another node-pty (default: Harbor's daemon copy); "dll" as the 5th uses that package's bundled
// conpty.dll and OpenConsole.exe (useConptyDll) instead of the Windows built-in ConPTY. "trust" as the 6th presses Enter on
// Claude's folder-trust screen (use a scratch folder) so it reaches its prompt; "prompt" also sends one tiny prompt when
// Claude first reports idle, to record the reports a real turn makes. Reports are listed with their time in ms. Results also go to <debug log>.result.txt.
const fs = require('fs');
const { createRequire } = require('module');
const pty = process.argv[5] ? require(process.argv[5]) : createRequire('C:/dev/harbor/app/src/daemon/package.json')('node-pty');
const [ws, mode] = process.argv.slice(2);
// The npm-installed Claude Code under %APPDATA%.
const exe = require('path').join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const p = pty.spawn(exe, ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(process.argv[4] ? ['--debug-file', process.argv[4]] : [])], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: true, windowsHide: true, ...(process.argv[6] === 'dll' ? { useConptyDll: true } : {}),
});
let out = '';
let answeredAt = null;
const queries = new Set();
let trusted = false;
let prompted = false;
const timeline = [];
const t0 = Date.now();
p.onData((d) => {
  out += d;
  for (const r of d.match(/\x1b\]7501;state=[^\x07\x1b]*/g) || []) {
    timeline.push(`${Date.now() - t0}ms ${r.slice(1)}`);
    // The first idle report means the prompt box is ready: type the prompt then.
    if (process.argv[8] === 'prompt' && !prompted && /state=idle/.test(r)) {
      prompted = true;
      setTimeout(() => { timeline.push(`${Date.now() - t0}ms (prompt typed)`); p.write('Reply with the single word hi.'); setTimeout(() => p.write('\r'), 800); }, 1500);
    }
  }
  if (mode === 'answer' && answeredAt === null && out.includes('\x1b]7501;?')) { answeredAt = Date.now() - t0; p.write('\x1b]7501;?\x1b\\'); }
  // Outside a git repository the trust screen's cursor starts on "No, exit": Down, then Enter, picks "Yes, I trust this folder".
  if (process.argv[7] === 'trust' && !trusted && /trust/i.test(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) {
    trusted = true;
    setTimeout(() => { p.write('\x1b[B'); setTimeout(() => p.write('\r'), 400); }, 1500);
  }
  // A pass-through ConPTY forwards the standard questions too, so the host answers them the way a terminal would:
  // DA1 (primary device attributes) and DSR 6 (cursor position). Every question seen is listed in the result.
  if (mode === 'answer') {
    for (const q of d.match(/\x1b\[[>?=]?[0-9;]*[cnqu]|\x1b\][0-9]+;\?/g) || []) {
      queries.add(q.replace(/\x1b/g, '<ESC>'));
      if (/^\x1b\[0?c$/.test(q)) p.write('\x1b[?62;22c');
      else if (q === '\x1b[6n') p.write('\x1b[1;1R');
    }
  }
});
setTimeout(() => {
  const hits = out.match(/\x1b\]7501;[^\x07\x1b]*/g) || [];
  const screen = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\s+/g, ' ');
  console.log(`mode=${mode} bytes=${out.length} queryAnsweredAtMs=${answeredAt} 7501=${JSON.stringify(hits.map((h) => h.slice(1)))}`);
  console.log('screen words:', screen.slice(0, 300));
  if (process.argv[4]) fs.writeFileSync(`${process.argv[4]}.result.txt`, `mode=${mode} dll=${process.argv[6] === 'dll'} queryAnsweredAtMs=${answeredAt} 7501=${JSON.stringify(hits.map((h) => h.slice(1)))} questionsSeen=${JSON.stringify([...queries])} trustPressed=${trusted} timeline=${JSON.stringify(timeline)}\n`);
  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 800);
}, process.argv[8] === 'prompt' ? 60000 : 30000);
