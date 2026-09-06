'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const APP = path.join(__dirname, '..');
const DIST = path.join(APP, 'dist-web');
const OUT = path.join(APP, 'verify', 'composer-qol');
const LIVE = process.env.HARBOR_LIVE_SERVER || 'http://127.0.0.1:8787';

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://local').pathname;
      const candidate = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
      const file = candidate.startsWith(DIST) && fs.existsSync(candidate) ? candidate : path.join(DIST, 'index.html');
      const ext = path.extname(file);
      res.setHeader('content-type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html');
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function rpc(page, method, payload) {
  return page.evaluate(async ({ method: m, payload: p }) => {
    const settings = {
      serverUrl: localStorage.getItem('harbor-web-server'),
      token: localStorage.getItem('harbor-web-token'),
    };
    const wsUrl = new URL(settings.serverUrl);
    wsUrl.protocol = 'ws:';
    wsUrl.pathname = '/ws';
    wsUrl.searchParams.set('token', settings.token);
    const socket = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'response' && pending.has(message.id)) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        message.error ? handler.reject(new Error(message.error)) : handler.resolve(message.result);
      }
    };
    const call = (methodName, callPayload) => new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method: methodName, payload: callPayload }));
    });
    const result = await call(m, p);
    socket.close();
    return result;
  }, { method, payload });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const build = spawnSync('npm', ['run', 'build:web'], { cwd: APP, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);

  const token = fs.readFileSync(path.join(os.homedir(), '.config', 'harbor', 'server-token'), 'utf8').trim();
  const staticServer = await serve();
  const local = `http://127.0.0.1:${staticServer.address().port}`;
  const launchOpts = fs.existsSync('/usr/bin/google-chrome')
    ? { executablePath: '/usr/bin/google-chrome', headless: true }
    : { headless: true };
  const browser = await chromium.launch(launchOpts);

  const report = { shipped: [], notShipped: [], evidence: {} };
  try {
    const context = await browser.newContext({
      viewport: { width: 430, height: 932 },
      permissions: ['microphone'],
    });
    const page = await context.newPage();
    await page.addInitScript(({ server, tok }) => {
      localStorage.setItem('harbor-web-server', server);
      localStorage.setItem('harbor-web-token', tok);
      localStorage.removeItem('harbor-web-open');
      localStorage.removeItem('harbor-web-active');
    }, { server: LIVE, tok: token });

    await page.goto(local, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
    await page.waitForTimeout(2000);

    const session = await page.evaluate(async () => {
      const settings = { serverUrl: localStorage.getItem('harbor-web-server'), token: localStorage.getItem('harbor-web-token') };
      const wsUrl = new URL(settings.serverUrl); wsUrl.protocol = 'ws:'; wsUrl.pathname = '/ws'; wsUrl.searchParams.set('token', settings.token);
      const socket = new WebSocket(wsUrl); let id = 0; const pending = new Map();
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      socket.onmessage = (event) => { const m = JSON.parse(event.data); if (m.type === 'response' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } };
      const call = (method, payload) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, payload })); });
      const sidebar = await call('sidebar:get-state');
      const sessions = (sidebar?.model?.projects || []).flatMap((project) => project.sessions || []);
      const pick = sessions.find((item) => item.id && !String(item.id).startsWith('pane:') && item.provider === 'claude')
        || sessions[0];
      socket.close();
      return pick;
    });
    if (!session?.id) throw new Error('no session available for composer proof');

    await page.evaluate((sessionId) => {
      localStorage.setItem('harbor-web-open', JSON.stringify([sessionId]));
      localStorage.setItem('harbor-web-active', sessionId);
    }, session.id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
    await page.locator('textarea[aria-label="Message"]').waitFor({ timeout: 15000 });

    // 1) Voice to draft
    const audioPath = path.join(OUT, 'voice-sample.webm');
    const audioBytes = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();
      await new Promise((r) => setTimeout(r, 1200));
      recorder.stop();
      await done;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    });
    fs.writeFileSync(audioPath, Buffer.from(audioBytes));
    const transcribe = await rpc(page, 'whisper:transcribe', { buffer: audioBytes, mimeType: 'audio/webm' });
    report.evidence.voiceToDraft = { audioPath, transcribe };
    if (transcribe?.ok && transcribe.text) {
      await page.locator('textarea[aria-label="Message"]').fill(transcribe.text);
      await page.screenshot({ path: path.join(OUT, '01-voice-to-draft.png') });
      report.shipped.push('voice-to-draft');
      fs.writeFileSync(path.join(OUT, '01-voice-transcript.txt'), transcribe.text);
    } else {
      report.notShipped.push(`voice-to-draft (${transcribe?.reason || 'transcribe failed'})`);
    }

    // 2) Slash palette
    const caps = await rpc(page, 'capabilities:get', { sessionId: session.id });
    const commands = caps?.capabilities?.commands || [];
    const valid = commands[0]?.name || '/help';
    const invalid = '/not-a-real-harbor-command-xyz';
    await page.locator('textarea[aria-label="Message"]').fill(`${invalid} hello ${valid}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '02-slash-palette.png') });
    fs.writeFileSync(path.join(OUT, '02-slash-commands.json'), JSON.stringify({ valid, invalid, commandCount: commands.length, sample: commands.slice(0, 5) }, null, 2));
    const slashDom = await page.evaluate(() => ({
      valid: Boolean(document.querySelector('.slash-token-ok')),
      invalid: Boolean(document.querySelector('.slash-token-bad')),
      palette: Boolean(document.querySelector('.slash-palette')),
    }));
    report.evidence.slashPalette = slashDom;
    if (slashDom.valid && slashDom.invalid) report.shipped.push('slash-palette');
    else report.notShipped.push('slash-palette (token colours missing)');

    // 3) Formatting
    await page.getByLabel('Show formatting options').click();
    const message = page.locator('textarea[aria-label="Message"]');
    await message.fill('format proof');
    await message.selectText();
    await page.getByLabel('Bold').click();
    const markdown = await page.inputValue('[aria-label="Message"]');
    await page.screenshot({ path: path.join(OUT, '03-formatting.png') });
    fs.writeFileSync(path.join(OUT, '03-format-markdown.txt'), markdown);
    report.evidence.formatting = { markdown, approach: 'markdown-aware toolbar over plain textarea' };
    if (markdown.includes('**format proof**')) report.shipped.push('formatting');
    else report.notShipped.push('formatting (bold markdown missing)');

    // 4) Live voice
    const tokenResult = await rpc(page, 'voice:token', { voice: 'marin' });
    report.evidence.liveVoiceToken = { ok: tokenResult?.ok, hasToken: Boolean(tokenResult?.token), reason: tokenResult?.reason };
    await page.getByLabel('Start live voice mode').click();
    await page.waitForTimeout(4000);
    const liveState = await page.evaluate(() => ({
      phase: document.querySelector('.composer-live-voice')?.className || '',
      bar: Boolean(document.querySelector('.live-voice-bar')),
      label: document.querySelector('.live-voice-label')?.textContent || '',
    }));
    await page.screenshot({ path: path.join(OUT, '04-live-voice.png') });
    const queueProof = await page.evaluate(() => window.__composerLiveVoiceTest || null);
    report.evidence.liveVoice = { liveState, tokenOk: tokenResult?.ok, queueProof };
    if (tokenResult?.ok && (liveState.bar || /live|connecting/.test(liveState.phase))) {
      report.shipped.push('live-voice');
    } else {
      report.notShipped.push(`live-voice (${tokenResult?.reason || liveState.label || 'not connected'})`);
    }
    await page.getByLabel('End live voice mode').click().catch(() => {});

    const controls = await page.evaluate(() => [...document.querySelectorAll('.composer-row button, .composer-row label')]
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { label: node.getAttribute('aria-label') || node.className, w: Math.round(box.width), h: Math.round(box.height) };
      }));
    report.evidence.controls = controls;
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    staticServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
