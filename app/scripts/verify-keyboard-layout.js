'use strict';

/**
 * Keyboard-open layout proof for MOBILE-PARITY-1.
 * Drives Chromium at 430x932 with a faithful visualViewport shim (innerHeight
 * stays 932 while visual height shrinks to ~460, matching iOS standalone PWA).
 *
 * Run: node scripts/verify-keyboard-layout.js
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const APP_ROOT = path.join(__dirname, '..');
const DIST_WEB = path.join(APP_ROOT, 'dist-web');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'keyboard');
const VIEWPORT = { width: 430, height: 932 };
const VISUAL_H = 460;
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

async function main() {
  const build = spawnSync('npm', ['run', 'build:web'], { cwd: APP_ROOT, encoding: 'utf8' });
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/whoami')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authenticated: true, tokenRequired: false, login: 'test@example.com' }));
      return;
    }
    const rel = (req.url || '/').split('?')[0];
    const urlPath = rel === '/' ? 'index.html' : rel.replace(/^\//, '');
    const filePath = path.join(DIST_WEB, urlPath);
    if (!filePath.startsWith(DIST_WEB) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.webmanifest': 'application/manifest+json',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (bytes) => {
    const message = JSON.parse(bytes);
    let result = { ok: true };
    if (message.method === 'sidebar:get-state') {
      result = {
        model: {
          projects: [{
            label: 'harbor',
            cwd: '/tmp/harbor',
            sessions: [{
              id: SESSION_ID,
              title: 'Keyboard layout proof',
              firstPrompt: 'Existing prompt',
              provider: 'claude',
              paneId: 'pane-proof',
              workspaceId: 'ws-proof',
              isLive: true,
              lastActiveMs: Date.now(),
            }],
          }],
        },
      };
    }
    if (message.method === 'project-icons:list') result = { icons: {} };
    if (message.method === 'tasks:read') result = { ok: true, doc: { lists: [], tasks: [] } };
    if (message.method === 'transcript:open') result = { ok: true };
    if (message.method === 'session:send-queue') result = { count: 0, items: [] };
    socket.send(JSON.stringify({ type: 'response', id: message.id, result }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = require('@playwright/test');
  const browser = fs.existsSync('/usr/bin/google-chrome')
    ? await chromium.launch({ channel: 'chrome', timeout: 60000 })
    : await chromium.launch({ timeout: 60000 });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await page.addInitScript(({ visualH, layoutH, id, wsBase }) => {
    window.localStorage.setItem('harbor-web-server', wsBase);
    window.localStorage.setItem('harbor-web-token', 'a'.repeat(64));
    window.localStorage.setItem('harbor-web-open', JSON.stringify([id]));
    window.localStorage.setItem('harbor-web-active', id);

    const vv = new EventTarget();
    let height = layoutH;
    let width = 430;
    let offsetTop = 0;
    let offsetLeft = 0;

    const apply = () => {
      vv.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('scroll'));
    };

    Object.defineProperty(vv, 'height', {
      get: () => height,
      set: (v) => { height = v; apply(); },
      configurable: true,
    });
    Object.defineProperty(vv, 'width', {
      get: () => width,
      configurable: true,
    });
    Object.defineProperty(vv, 'offsetTop', {
      get: () => offsetTop,
      configurable: true,
    });
    Object.defineProperty(vv, 'offsetLeft', {
      get: () => offsetLeft,
      configurable: true,
    });

    window.__setVisualViewport = (next) => {
      if (next.height != null) height = next.height;
      if (next.width != null) width = next.width;
      if (next.offsetTop != null) offsetTop = next.offsetTop;
      if (next.offsetLeft != null) offsetLeft = next.offsetLeft;
      apply();
    };

    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => layoutH });
    apply();
  }, { visualH: VISUAL_H, layoutH: VIEWPORT.height, id: SESSION_ID, wsBase: baseUrl });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-shell', { timeout: 10000 });

  // Seed a tall transcript so check (3) has something to measure.
  await page.evaluate(() => {
    const body = document.querySelector('.conv-body');
    if (!body) return;
    for (let i = 0; i < 40; i += 1) {
      const p = document.createElement('p');
      p.className = 'conv-assistant';
      p.textContent = `Transcript line ${i} for keyboard layout proof.`;
      body.appendChild(p);
    }
  });
  await page.waitForTimeout(200);

  const textarea = page.getByLabel('Message');
  await textarea.click();
  await textarea.fill('typing on the keyboard');

  // Shrink visual viewport to simulate iOS keyboard (layout innerHeight stays 932).
  await page.evaluate((h) => {
    window.__setVisualViewport({ height: h, offsetTop: 0, offsetLeft: 0, width: 430 });
  }, VISUAL_H);
  await page.waitForTimeout(300);

  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
      viewport: { width: VIEWPORT.width, height: VISUAL_H, scale: 1, x: 0, y: 0 },
    });
  } catch {
    // CDP visual viewport override is best-effort; the shim above is authoritative.
  }

  await page.waitForTimeout(200);

  const metrics = await page.evaluate(() => {
    const vv = window.visualViewport;
    const visualH = vv?.height ?? window.innerHeight;
    const visualTop = vv?.offsetTop ?? 0;
    const keyboardTop = visualTop + visualH;

    const composer = document.querySelector('.composer');
    const textarea = document.querySelector('.composer textarea');
    const nav = document.querySelector('.shell-bottom-anchor');
    const lastBlock = document.querySelector('.conv-body > :last-child');
    const shell = document.querySelector('.app-shell');

    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const c = rect(composer);
    const t = rect(textarea);
    const n = rect(nav);
    const l = rect(lastBlock);

    const fixedBars = [...document.querySelectorAll('.composer.is-focused, .shell-bottom-anchor')]
      .filter((el) => getComputedStyle(el).position === 'fixed')
      .map((el) => ({
        class: el.className,
        top: Math.round(el.getBoundingClientRect().top),
        bottom: Math.round(el.getBoundingClientRect().bottom),
      }));

    let barsOverlap = false;
    for (let i = 0; i < fixedBars.length; i += 1) {
      for (let j = i + 1; j < fixedBars.length; j += 1) {
        const a = fixedBars[i];
        const b = fixedBars[j];
        if (a.bottom > b.top + 1 && b.bottom > a.top + 1) barsOverlap = true;
      }
    }

    const check1 = c
      ? c.top >= visualTop - 1
        && c.bottom <= keyboardTop + 1
        && c.left >= 0
        && c.right <= (vv?.width ?? window.innerWidth) + 1
      : false;

    const check2 = t
      ? t.bottom <= keyboardTop + 1 && t.top >= visualTop - 1
      : false;

    const check3 = l && c
      ? l.bottom <= c.top + 1
      : false;

    const check4 = !barsOverlap;

    const docH = document.documentElement.scrollHeight;
    const docClient = document.documentElement.clientHeight;
    const check5 = (docH <= visualH + 2 || docH <= docClient + 2) && window.scrollY === 0;

    return {
      viewport: {
        layoutInnerHeight: window.innerHeight,
        visualHeight: visualH,
        visualTop,
        keyboardTop,
        appH: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
      },
      shell: shell ? {
        height: Math.round(shell.getBoundingClientRect().height),
        keyboardOpen: shell.hasAttribute('data-keyboard-open'),
      } : null,
      composer: c ? {
        top: Math.round(c.top),
        bottom: Math.round(c.bottom),
        height: Math.round(c.height),
      } : null,
      textarea: t ? {
        top: Math.round(t.top),
        bottom: Math.round(t.bottom),
      } : null,
      nav: n ? {
        display: getComputedStyle(nav).display,
        top: Math.round(n.top),
        bottom: Math.round(n.bottom),
      } : null,
      lastBlock: l ? { bottom: Math.round(l.bottom) } : null,
      fixedBars,
      docScrollHeight: docH,
      docClientHeight: docClient,
      scrollY: window.scrollY,
      checks: {
        '1_composerInsideVisualViewport': check1,
        '2_textareaCaretLineVisible': check2,
        '3_lastBlockAboveComposer': check3,
        '4_noFixedBarOverlap': check4,
        '5_documentDoesNotScroll': check5,
      },
    };
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shotPath = path.join(OUT_DIR, 'keyboard-open-430x932.png');
  await page.screenshot({ path: shotPath });

  const jsonPath = path.join(OUT_DIR, 'keyboard-open-metrics.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(metrics, null, 2)}\n`);

  await browser.close();
  await new Promise((resolve) => { wss.close(); server.close(resolve); });

  console.log(JSON.stringify(metrics, null, 2));
  console.log(`screenshot: ${shotPath}`);
  console.log(`metrics: ${jsonPath}`);

  const failed = Object.entries(metrics.checks).filter(([, ok]) => !ok);
  if (failed.length) {
    console.error('FAILED:', failed.map(([k]) => k).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
