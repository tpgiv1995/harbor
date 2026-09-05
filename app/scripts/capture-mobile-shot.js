#!/usr/bin/env node
'use strict';

// THE PUBLISHED PHONE SCREENSHOT, from the same fixture corpus as the desktop one.
//
//   env -u DISPLAY -u WAYLAND_DISPLAY node scripts/capture-mobile-shot.js
//
// Writes docs/screenshots/mobile.png: two phone screens on a dark ground.
//
// This drives the REAL client against the REAL server. `scripts/capture-mobile-web.js`
// (the MOBILE-6 verification harness) stubs the sidebar, the transcripts and the
// artifacts, which is right for asserting on a layout and wrong for a picture: a
// README shot of a mocked client is a drawing of a product rather than the
// product. So it builds the corpus in scripts/lib/demo-corpus.cjs, starts
// `src/server/index.js` as its own process pointed at that corpus, and loads the
// built PWA over loopback with a real token. Every session, message and provider
// on screen came through the same RPC a phone uses.
//
// It needs `npm run build:web` first; the server serves dist-web and says so in
// its log when the client is not built, which would otherwise photograph a 404.
//
// The two screens are composed side by side because a lone 430x932 shot is a
// tall ribbon that wastes a README's width, and because the pair is the point:
// one conversation, and the switcher showing that the phone sees every provider
// the desktop does.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  prepareRoot, buildCorpus, buildConfig, seedTasks, seedUsage, DEFAULT_ROOT,
} = require('./lib/demo-corpus.cjs');
const { renderHtmlToPng, dataUri } = require('./lib/render-html.cjs');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const SHOT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');
const OUT = path.join(SHOT_DIR, 'mobile.png');
const PHONE = { width: 430, height: 932 };
const SCALE = 2;
const PRESENT_WIDTH = 1760;

const REAL_HOME = os.homedir();
const REAL_USER = (() => {
  try { return os.userInfo().username; } catch { return path.basename(REAL_HOME); }
})();

if (!process.env.HARBOR_SHOT_INNER && !process.env.HARBOR_SHOT_HEADED) {
  const result = spawnSync(
    'env',
    ['-u', 'DISPLAY', '-u', 'WAYLAND_DISPLAY', 'xvfb-run', '-a',
      '--server-args=-screen 0 2400x2200x24',
      process.execPath, __filename],
    { stdio: 'inherit', env: { ...process.env, HARBOR_SHOT_INNER: '1' }, cwd: APP_ROOT },
  );
  process.exit(result.status ?? 1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, deadlineMs = 60000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error(`harbor-server never listened on ${port}`);
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
}

async function assertNoIdentity(page, label) {
  const text = await page.evaluate(() => document.body.innerText || '');
  for (const needle of [REAL_HOME, REAL_USER].filter((value) => value && value.length > 2)) {
    if (!text.includes(needle)) continue;
    const line = text.split('\n').find((candidate) => candidate.includes(needle)) || '';
    throw new Error(`${label}: rendered text contains '${needle}'. Offending line: ${line.trim().slice(0, 200)}`);
  }
}

// One phone, drawn as a phone. A bezel is not decoration here: two bare
// screenshots butted together read as one broken wide image, and the rounded
// dark frame is what makes them read as two devices.
function frame(png, caption) {
  return `
    <figure class="phone">
      <div class="bezel"><img src="${dataUri(png)}" alt=""></div>
      <figcaption>${caption}</figcaption>
    </figure>`;
}

function composition(shots) {
  return `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    background:
      radial-gradient(1100px 520px at 22% -12%, #1a2434 0%, rgba(26,36,52,0) 62%),
      radial-gradient(900px 480px at 84% 112%, #1d1b2c 0%, rgba(29,27,44,0) 60%),
      #0b0d11;
    font: 400 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #c9ccd4;
    display: flex; align-items: center; justify-content: center; gap: 84px;
  }
  .phone { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .bezel {
    padding: 10px; border-radius: 40px; background: #16181e;
    border: 1px solid #2a2f3a;
    box-shadow: 0 30px 70px rgba(0,0,0,.55), 0 2px 0 rgba(255,255,255,.04) inset;
  }
  .bezel img { display: block; width: ${PHONE.width}px; height: ${PHONE.height}px; border-radius: 30px; }
  figcaption { font-size: 14.5px; letter-spacing: .01em; color: #8b90a0; }
</style>
<body>${shots.map(([png, caption]) => frame(png, caption)).join('')}</body>`;
}

async function main() {
  const { _electron: electron } = require('@playwright/test');
  const root = prepareRoot(process.env.HARBOR_SHOT_ROOT || `${DEFAULT_ROOT}-phone`);

  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const corpus = buildCorpus(root);
  const { projectsDir, home, sessions } = corpus;
  const configFile = path.join(userData, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(
    buildConfig(root, { projectsDir, home, cacheDir, userData }), null, 2,
  ));
  seedTasks(REPO_ROOT, path.join(root, 'tasks.json'));
  seedUsage(cacheDir);

  const webDist = path.join(APP_ROOT, 'dist-web');
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    throw new Error(`no built phone client at ${webDist}; run \`npm run build:web\` first`);
  }

  const serverEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    HARBOR_USER_DATA_DIR: userData,
    HARBOR_CONFIG_FILE: configFile,
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_ARTIFACTS_ROOTS: projectsDir,
    HARBOR_ARTIFACTS_CACHE: path.join(cacheDir, 'artifacts-index.json'),
    HARBOR_ARTIFACT_THUMBS_DIR: path.join(cacheDir, 'thumbs'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_SESSIOND_SOCKET: path.join(root, 'sessiond', 'sessiond.sock'),
    HARBOR_DELEGATE_STATE_DIR: path.join(root, 'delegate'),
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_MODEL_DISCOVERY: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_NO_VOICE: '1',
  };

  const daemon = spawn(process.execPath, [path.join(APP_ROOT, 'src', 'daemon', 'daemon.js')], {
    stdio: 'ignore', detached: true, env: serverEnv,
  });
  await new Promise((resolve) => { setTimeout(resolve, 1500); });

  const port = await freePort();
  const server = spawn(process.execPath, [path.join(APP_ROOT, 'src', 'server', 'index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...serverEnv, HARBOR_SERVER_HOST: '127.0.0.1', HARBOR_SERVER_PORT: String(port) },
  });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  let app = null;
  const screens = [];
  try {
    await waitForPort(port);
    const token = fs.readFileSync(path.join(userData, 'server-token'), 'utf8').trim();
    const baseUrl = `http://127.0.0.1:${port}`;

    const clientMain = path.join(root, 'phone-main.js');
    fs.writeFileSync(clientMain, `'use strict';
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: ${PHONE.width}, height: ${PHONE.height}, useContentSize: true, show: true, frame: false,
  });
  win.loadURL('about:blank');
});
`);
    app = await electron.launch({
      executablePath: require('electron'),
      args: ['--no-sandbox', '--disable-gpu', `--force-device-scale-factor=${SCALE}`, clientMain],
      cwd: APP_ROOT,
      timeout: 120000,
      env: { ...process.env, HOME: home },
    });
    const page = await app.firstWindow({ timeout: 60000 });
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    if (dpr !== SCALE) throw new Error(`expected a ${SCALE}x phone capture, got devicePixelRatio ${dpr}`);

    // The codex session: it is mid-turn, it is not Claude, and it proves the
    // phone renders a provider the desktop shot also shows.
    const opening = sessions.find((session) => session.provider === 'codex') || sessions[0];
    await page.addInitScript(({ serverUrl, authToken, sessionId }) => {
      localStorage.setItem('harbor-web-server', serverUrl);
      localStorage.setItem('harbor-web-token', authToken);
      localStorage.setItem('harbor-web-active', sessionId);
    }, { serverUrl: baseUrl, authToken: token, sessionId: opening.id });
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('.app-shell', { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelector('.app-shell')?.dataset.connection === 'online',
      null, { timeout: 30000 },
    );
    await page.waitForSelector('.conv-assistant', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const conversation = path.join(root, 'phone-conversation.png');
    await assertNoIdentity(page, 'phone conversation');
    await page.screenshot({ path: conversation });
    screens.push([conversation, 'One conversation, driven from the phone']);

    // The switcher: every project and every provider, the same rail the desktop
    // shows, in the shape a phone can hold.
    await page.locator('.hdr-session').first().click({ timeout: 10000 });
    await page.waitForSelector('.shell-drawer', { timeout: 15000 });
    await page.waitForTimeout(1400);
    const browser = path.join(root, 'phone-browser.png');
    await assertNoIdentity(page, 'phone switcher');
    await page.screenshot({ path: browser });
    screens.push([browser, 'Every session, on the same tailnet']);

    await app.close().catch(() => {});
    app = null;

    // 84px of gutter and 10px of bezel either side of two 430px screens.
    const width = PHONE.width * 2 + 84 + 40 + 160;
    const height = PHONE.height + 20 + 42 + 120;
    // Composed and scaled in the run's own directory, and only copied into
    // docs/ once both have succeeded: a failure between the two used to leave a
    // raw 2288px-wide mobile.png in the repository, which is the same
    // half-published state the desktop capture's staging step exists to prevent.
    const staged = path.join(root, 'mobile.png');
    await renderHtmlToPng({
      html: composition(screens), width, height, scale: SCALE, out: staged,
    });
    const scaled = `${staged}.scaled.png`;
    const result = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', staged,
      '-vf', `scale=${PRESENT_WIDTH}:-1:flags=lanczos`, '-compression_level', '100', scaled,
    ]);
    if (result.status === 0 && fs.existsSync(scaled)) {
      fs.renameSync(scaled, staged);
      process.stdout.write(`scaled mobile.png to ${PRESENT_WIDTH}px (${Math.round(fs.statSync(staged).size / 1024)}KB)\n`);
    } else {
      fs.rmSync(scaled, { force: true });
      process.stdout.write(`left mobile.png at full size (ffmpeg: ${result.error?.code || result.status})\n`);
    }
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.copyFileSync(staged, OUT);
    process.stdout.write(`published ${OUT}\n`);
  } catch (error) {
    process.stderr.write(`harbor-server log:\n${serverLog.join('')}\n`);
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    server.kill('SIGTERM');
    try { process.kill(-daemon.pid, 'SIGTERM'); } catch { try { daemon.kill('SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`capture-mobile-shot failed: ${error.message}\n`);
  process.exit(1);
});
