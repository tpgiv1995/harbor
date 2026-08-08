'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const APP = path.join(__dirname, '..');
const DIST = path.join(APP, 'dist-web');
const OUT = path.join(APP, 'verify', 'capability');
const LIVE = process.env.HARBOR_LIVE_SERVER || 'http://127.0.0.1:8787';

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://local').pathname;
      const candidate = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
      const file = candidate.startsWith(DIST) && fs.existsSync(candidate) ? candidate : path.join(DIST, 'index.html');
      const ext = path.extname(file);
      res.setHeader('content-type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.woff2' ? 'font/woff2' : 'text/html');
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function measure(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const rect = root?.getBoundingClientRect();
    const targets = root ? [...root.querySelectorAll('button,input,[role="button"]')].map((node) => {
      const box = node.getBoundingClientRect();
      return { label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 60), width: Math.round(box.width), height: Math.round(box.height) };
    }) : [];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sheet: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, overflowY: root.scrollHeight - root.clientHeight } : null,
      targets,
      undersizedTargets: targets.filter((item) => item.width < 44 || item.height < 44),
    };
  }, selector);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const token = fs.readFileSync(path.join(os.homedir(), '.config', 'harbor', 'server-token'), 'utf8').trim();
  const staticServer = await serve();
  const local = `http://127.0.0.1:${staticServer.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();
    await page.addInitScript(({ server, tok }) => {
      localStorage.setItem('harbor-web-server', server);
      localStorage.setItem('harbor-web-token', tok);
      localStorage.removeItem('harbor-web-open');
      localStorage.removeItem('harbor-web-active');
    }, { server: LIVE, tok: token });
    await page.goto(local, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
    await page.waitForTimeout(2500);
    const raw = await page.evaluate(async () => {
      const settings = { serverUrl: localStorage.getItem('harbor-web-server'), token: localStorage.getItem('harbor-web-token') };
      const wsUrl = new URL(settings.serverUrl); wsUrl.protocol = 'ws:'; wsUrl.pathname = '/ws'; wsUrl.searchParams.set('token', settings.token);
      const socket = new WebSocket(wsUrl); let id = 0; const pending = new Map();
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      socket.onmessage = (event) => { const m = JSON.parse(event.data); if (m.type === 'response' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } };
      const call = (method, payload) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, payload })); });
      const sidebar = await call('sidebar:get-state');
      const sessions = (sidebar?.model?.projects || []).flatMap((project) => project.sessions || []);
      const session = sessions.find((item) => item.id && !String(item.id).startsWith('pane:') && item.provider === 'claude' && !item.paneId)
        || sessions.find((item) => item.id && !String(item.id).startsWith('pane:') && item.provider === 'claude') || sessions[0];
      const result = { session, capabilities: await call('capabilities:get', { sessionId: session.id }), usage: await call('usage:get-all'), emails: await call('accounts:read-emails') };
      socket.close(); return result;
    });
    fs.writeFileSync(path.join(OUT, 'raw-payloads.json'), JSON.stringify(raw, null, 2));

    await page.evaluate((sessionId) => {
      localStorage.setItem('harbor-web-open', JSON.stringify([sessionId]));
      localStorage.setItem('harbor-web-active', sessionId);
    }, raw.session.id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
    await page.waitForTimeout(1500);

    await page.getByLabel('Model, effort and permissions').click();
    await page.locator('.capability-sheet').waitFor();
    await page.locator('.cap-efforts button').first().waitFor({ timeout: 20000 });
    await page.screenshot({ path: path.join(OUT, 'capability-sheet-430x932.png') });
    fs.writeFileSync(path.join(OUT, 'capability-sheet-measured.json'), JSON.stringify(await measure(page, '.capability-sheet'), null, 2));
    const effort = page.locator('.cap-efforts button', { hasText: 'high' }).first();
    if (!await effort.count()) throw new Error('live capabilities did not offer high effort');
    await effort.click();
    await page.locator('.sheet-notice').waitFor({ timeout: 20000 });
    const effortStatus = await page.locator('.sheet-notice').innerText();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, 'effort-applied-430x932.png') });
    if (!/change sent/i.test(effortStatus)) throw new Error(`effort application failed: ${effortStatus}`);
    await page.getByLabel('Close').click();
    await page.waitForTimeout(5000);
    const sessionChip = await page.getByLabel('Model, effort and permissions').innerText();
    const paneText = await page.locator('.shell-screen-sessions').innerText();
    await page.screenshot({ path: path.join(OUT, 'effort-session-pane-430x932.png') });
    fs.writeFileSync(path.join(OUT, 'effort-session-pane.txt'), paneText);
    fs.writeFileSync(path.join(OUT, 'applied-effort.json'), JSON.stringify({ sessionId: raw.session.id, command: '/effort high', status: effortStatus, sessionChip, at: new Date().toISOString() }, null, 2));
    await page.getByLabel('Plan and usage').click();
    await page.locator('.plan-sheet').waitFor();
    await page.screenshot({ path: path.join(OUT, 'plan-sheet-430x932.png') });
    fs.writeFileSync(path.join(OUT, 'plan-sheet-measured.json'), JSON.stringify(await measure(page, '.plan-sheet'), null, 2));
  } finally {
    await browser.close(); staticServer.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
