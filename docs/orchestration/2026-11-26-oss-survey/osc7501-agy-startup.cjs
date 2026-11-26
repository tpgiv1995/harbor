// Real agy 1.5.14 in a ConPTY (scratch profile, no prompt sent): which OSC 7501 bytes does it write at startup?
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const pty = createRequire('C:/dev/harbor/app/src/daemon/package.json')('node-pty');
const [home, ws, mode] = process.argv.slice(2);
fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'cache', 'onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true }));
const settings = path.join(home, 'probe-settings.json');
fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [ws], showFeedbackSurvey: false }));
const env = { ...process.env, USERPROFILE: home, HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', NO_OPEN_BROWSER: '1', TERM: 'xterm-256color' };
if (mode === 'on') env.AGY_CLI_OSC7501 = 'on';
const p = pty.spawn('C:\\tools\\antigravity\\1.5.14\\agy.exe', ['--settings', settings, '--model', 'gemini-4-hydrogen', '--effort', 'low'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env, useConpty: true, windowsHide: true });
let out = '';
p.onData((d) => { out += d; });
setTimeout(() => {
  const hits = out.match(/\x1b\]7501;[^\x07\x1b]*/g) || [];
  console.log(`mode=${mode} bytes=${out.length} 7501=${JSON.stringify(hits.map((h) => h.slice(1)))} boxDrawn=${/─{20,}/.test(out)}`);
  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}, 20000);
