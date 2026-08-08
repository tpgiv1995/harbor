'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isolatedFixture } = require('./mobile.spec.js');

// DERIVED, never written down. These were absolute paths into one developer's
// checkout, which is both a personal identifier and a landmine: the publish-time
// scrub rewrote the home component, the directory stopped existing, and
// `electron.launch({ cwd })` failed with ENOENT for all thirteen mobile specs
// while the desktop gate stayed green. A path a harness must actually OPEN has
// to come from __dirname, or the next rename silently unhooks the gate again.
const APP_ROOT = path.resolve(__dirname, '../..');
const SCREENSHOT_ROOT = path.join(APP_ROOT, 'verify/e2e/mobile-screenshots');
const { PORTRAIT: VIEWPORT, LANDSCAPE, SIZES } = require('../support/mobile-viewport.cjs');
const FIRST_SESSION = '11111111-1111-4111-8111-111111111111';
const SECOND_SESSION = '22222222-2222-4222-8222-222222222222';
const CREATED_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function screenshotPath(name) {
  const run = process.env.HARBOR_E2E_RUN || 'manual';
  return path.join(SCREENSHOT_ROOT, `run-${run}`, name);
}

// `listLaunchedSession: false` reproduces the ordinary real-world case this
// harness otherwise hides: a freshly launched session is NOT in the sidebar
// model yet. The default fixture publishes it synchronously inside the launch
// itself, so any client that polls for it succeeds on its first try and the
// twelve-second poll never runs.
async function makeUiFixture({ listLaunchedSession = true } = {}) {
  const sidebarEmitter = new EventEmitter();
  const transcriptEmitter = new EventEmitter();
  const sendEmitter = new EventEmitter();
  const projectFolder = '/tmp/harbor-mobile-e2e-project';
  const state = {
    model: {
      projects: [{
        label: 'harbor-mobile-e2e-project',
        hasLive: true,
        sessions: [
          {
            id: FIRST_SESSION,
            title: 'First mobile session',
            cwd: projectFolder,
            provider: 'claude',
            paneId: 'pane-mobile-first',
            workspaceId: 'workspace-mobile',
            isLive: true,
            agentStatus: 'blocked',
            needsAnswer: true,
            lastActiveMs: 200,
          },
          {
            id: SECOND_SESSION,
            title: 'Picked mobile session',
            cwd: projectFolder,
            provider: 'claude',
            paneId: 'pane-mobile-second',
            workspaceId: 'workspace-mobile',
            isLive: true,
            agentStatus: 'idle',
            lastActiveMs: 100,
          },
        ],
      }],
    },
  };
  const stateReads = [];
  const sidebar = {
    emitter: sidebarEmitter,
    async start() {},
    close() {},
    getState: () => { stateReads.push(Date.now()); return state; },
    getSessionMeta: async () => ({ cwd: projectFolder }),
    getSessionPreview: async () => null,
    focusLivePane: async () => ({ ok: true }),
  };
  const opens = [];
  const transcript = {
    emitter: transcriptEmitter,
    async open(sessionId) {
      opens.push(sessionId);
      setTimeout(() => transcriptEmitter.emit('update', {
        sessionId,
        replace: [
          { key: `${sessionId}-user`, kind: 'user', text: 'Drive the real phone flow.' },
          {
            key: `${sessionId}-assistant`,
            kind: 'assistant',
            text: Array.from({ length: 28 }, (_, index) => `Measured mobile line ${index + 1}.`).join('\n\n'),
          },
        ],
        header: { blocked: sessionId === FIRST_SESSION, working: false },
      }), 25);
      return { ok: true };
    },
    close() {},
    closeAll() {},
  };
  const sent = [];
  const answers = [];
  const menuCalls = [];
  let questionOpen = true;
  // Lets a spec put a `session:send` in flight and leave it there, which is
  // what a send looks like at the instant its socket dies.
  let holdSend = false;
  const sessionSend = {
    emitter: sendEmitter,
    async send(payload) {
      sent.push(payload);
      if (holdSend) return new Promise(() => {});
      return { ok: true };
    },
    getQueueState: () => ({ count: 0, items: [] }),
    cancelQueued: () => ({ ok: true }),
    async getMenu({ sessionId }) {
      menuCalls.push(sessionId);
      if (sessionId !== FIRST_SESSION || !questionOpen) return null;
      return {
        question: 'Which mobile layout is safe?',
        options: [
          { index: 1, label: 'Measured clearance', description: 'Keeps content above the bar.', selected: true },
          { index: 2, label: 'Visual guess', description: 'Can regress without a geometry assertion.' },
        ],
      };
    },
    async answerMenu(payload) {
      answers.push(payload);
      questionOpen = false;
      return { ok: true };
    },
  };
  const terminalInputs = [];
  const terminalBridge = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    async sendInput(paneId, input) {
      terminalInputs.push({ paneId, input });
      return { ok: true };
    },
  };
  const launches = [];
  const fx = await isolatedFixture({
    fakeLaunch: true,
    sidebar,
    transcript,
    sessionSend,
    terminalBridge,
    onFakeLaunch(record) {
      launches.push(record);
      if (!listLaunchedSession) return;
      // THE ID THE LAUNCH ACTUALLY MINTED. Harbor passes `claude --session-id
      // <uuid>`, so that uuid IS the session, and a fixture that invents its
      // own instead cannot tell a client reading the launch's answer apart
      // from one guessing by folder and recency.
      const argv = record.argv || [];
      const at = argv.indexOf('--session-id');
      const mintedId = at >= 0 ? argv[at + 1] : CREATED_SESSION;
      state.model.projects[0].sessions.unshift({
        id: mintedId,
        title: 'Created mobile session',
        cwd: record.options.cwd,
        provider: 'claude',
        isLive: true,
        lastActiveMs: Date.now(),
      });
      sidebarEmitter.emit('update', state);
    },
  });
  return {
    ...fx,
    answers,
    launches,
    menuCalls,
    opens,
    projectFolder,
    sendEmitter,
    sent,
    stateReads,
    terminalInputs,
    transcriptEmitter,
    holdNextSend: () => { holdSend = true; },
  };
}

async function launchPhone(fx, { keyboard = false, size = VIEWPORT } = {}) {
  if (!process.env.DISPLAY) throw new Error('mobile E2E requires DISPLAY from xvfb-run');
  const mainPath = path.join(fx.root, 'mobile-electron-main.js');
  await fs.writeFile(mainPath, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    'app.whenReady().then(() => {',
    `  const win = new BrowserWindow({ width: ${size.width}, height: ${size.height}, useContentSize: true, show: true });`,
    "  win.loadURL('about:blank');",
    '});',
  ].join('\n'));
  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', mainPath],
    cwd: APP_ROOT,
    env: { ...process.env },
    timeout: 60000,
  });
  const page = await electronApp.firstWindow({ timeout: 60000 });
  await page.setViewportSize(size);
  await page.addInitScript(({
    serverUrl, token, emulateKeyboard, VIEWPORT_HEIGHT, VIEWPORT_WIDTH,
  }) => {
    localStorage.setItem('harbor-web-server', serverUrl);
    localStorage.setItem('harbor-web-token', token);
    localStorage.removeItem('harbor-web-open');
    localStorage.removeItem('harbor-web-active');
    if (emulateKeyboard) {
      const viewport = new EventTarget();
      Object.assign(viewport, {
        height: VIEWPORT_HEIGHT,
        width: VIEWPORT_WIDTH,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.__harborOpenKeyboard = () => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 548 });
        viewport.height = 546;
        viewport.offsetTop = 325;
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
      };
      // The event iOS fires constantly and that means NOTHING: a scroll whose
      // rectangle is byte-identical to the last one. The phone emits these at
      // the display refresh rate while the keyboard is up or a list has
      // momentum.
      window.__harborViewportNudge = () => viewport.dispatchEvent(new Event('scroll'));
    }
  }, {
    serverUrl: `http://127.0.0.1:${fx.address.port}`,
    token: fx.composed.token,
    emulateKeyboard: keyboard,
    VIEWPORT_HEIGHT: size.height,
    VIEWPORT_WIDTH: size.width,
  });
  await page.goto(`http://127.0.0.1:${fx.address.port}/`, { waitUntil: 'domcontentloaded' });
  // Connection state is a data attribute now, not a permanent green banner:
  // the banner only renders when there is something wrong to report, so it is
  // no longer something a healthy run can wait for.
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
  return { electronApp, page };
}

async function closeUi(fx, electronApp) {
  await electronApp?.close({ force: true }).catch(() => {});
  await fx.close();
}

test.describe('MOBILE-OVERHAUL-6 real phone flow gate', () => {
  test('full-screen browser picks a session and composer sends through the stubbed pty boundary', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      // The whole header IS the switcher now (it carries the session identity),
      // replacing the 13px "Sessions" text button that used to sit beside a
      // title reading "Harbor".
      await fx.page.getByRole('button', { name: 'Switch session' }).click();
      await fx.page.waitForTimeout(250);
      const browserBox = await fx.page.locator('.session-browser').boundingBox();
      expect(browserBox.x).toBe(0);
      expect(browserBox.height).toBe(VIEWPORT.height);
      expect(browserBox.width).toBeLessThan(VIEWPORT.width);
      await fx.page.screenshot({ path: screenshotPath('session-drawer-430x873.png') });

      await fx.page.getByText('Picked mobile session', { exact: true }).click();
      await expect(fx.page.locator('.session-browser')).toHaveCount(0);
      await fx.page.getByLabel('Message', { exact: true }).fill('Sent from the 430px mobile gate');
      await fx.page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => fx.sent.length).toBe(1);
      expect(fx.sent[0]).toMatchObject({ sessionId: SECOND_SESSION, text: 'Sent from the 430px mobile gate' });
      expect(fx.terminalInputs).toEqual([]);
      await fx.page.screenshot({ path: screenshotPath('composer-sent-430x873.png') });
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  test('question card sends the selected answer through the stubbed pty boundary', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      await fx.page.getByText('Which mobile layout is safe?', { exact: true }).waitFor();
      await fx.page.screenshot({ path: screenshotPath('question-card-430x873.png') });
      await fx.page.getByRole('button', { name: /Measured clearance/ }).click();
      await expect.poll(() => fx.answers.length).toBe(1);
      expect(fx.answers[0]).toMatchObject({
        pane: { paneId: 'pane-mobile-first', workspaceId: 'workspace-mobile' },
        action: { type: 'select', index: 1 },
      });
      await expect(fx.page.locator('.ask-card')).toHaveCount(0);
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  test('new session sheet creates a session through fake launch', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      // The whole header IS the switcher now (it carries the session identity),
      // replacing the 13px "Sessions" text button that used to sit beside a
      // title reading "Harbor".
      await fx.page.getByRole('button', { name: 'Switch session' }).click();
      await fx.page.getByRole('button', { name: 'New session' }).click();
      await fx.page.locator('.newsession-sheet').waitFor();
      const sheetBox = await fx.page.locator('.newsession-sheet').boundingBox();
      expect(sheetBox).toEqual({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
      await fx.page.screenshot({ path: screenshotPath('new-session-430x873.png') });
      await fx.page.getByRole('button', { name: 'Start session' }).click();
      await expect.poll(() => fx.launches.length, { timeout: 15000 }).toBe(1);
      expect(fx.launches[0].options.cwd).toBe(fx.projectFolder);
      await expect(fx.page.locator('.newsession-sheet')).toHaveCount(0);
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  test('conversation content ends above the normal-flow composer', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      await fx.page.locator('.conv-assistant').waitFor();
      const metrics = await fx.page.evaluate(() => {
        const conversation = document.querySelector('.conv');
        conversation.scrollTop = conversation.scrollHeight;
        const last = document.querySelector('.conv-body > :last-child');
        const composer = document.querySelector('.composer');
        return {
          lastBottom: last.getBoundingClientRect().bottom,
          composerTop: composer.getBoundingClientRect().top,
          composerBottom: composer.getBoundingClientRect().bottom,
          viewportBottom: window.innerHeight,
          conversationScrollHeight: conversation.scrollHeight,
          conversationClientHeight: conversation.clientHeight,
        };
      });
      expect(metrics.composerBottom).toBeLessThanOrEqual(VIEWPORT.height);
      expect(metrics.lastBottom, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.composerTop + 1);
      await fx.page.screenshot({ path: screenshotPath('layout-clearance-430x873.png') });
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  // WHAT YOU TYPE MUST BE VISIBLE, AND THE VOICE CONTROLS MUST BE REACHABLE.
  //
  // Both live-caught by Pat on his own phone on 2026-08-07, with this gate
  // green at 20/20 twice. It measured geometry and never once asked what a
  // human would actually SEE: the composer set `color: transparent` on the
  // textarea the moment it held text (half of a highlight-overlay pattern whose
  // other half does not exist in this client), so typing showed a caret moving
  // across an empty box. Layout was perfect throughout.
  test('typed text is visible, and the voice controls are on screen', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      const box = fx.page.locator('.composer-field textarea');
      await box.waitFor();
      await box.fill('hello, can I read this');

      const seen = await fx.page.evaluate(() => {
        const el = document.querySelector('.composer-field textarea');
        const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
        // COMPOSITE the whole ancestor stack. A single lookup is not enough:
        // the field sits on rgba(255,255,255,0.1), a 10% white VEIL over a dark
        // surface, and reading that one layer as if it were opaque white says
        // the text is invisible when it is plainly readable.
        const layers = [];
        for (let node = el; node; node = node.parentElement) {
          const parts = parse(getComputedStyle(node).backgroundColor);
          if (parts.length < 3) continue;
          const alpha = parts.length > 3 ? parts[3] : 1;
          if (alpha <= 0) continue;
          layers.push({ rgb: parts.slice(0, 3), alpha });
          if (alpha >= 1) break;
        }
        // Paint from the bottom-most opaque layer upward, source-over.
        let base = [0, 0, 0];
        for (let k = layers.length - 1; k >= 0; k -= 1) {
          const { rgb, alpha } = layers[k];
          base = base.map((channel, c) => (rgb[c] * alpha) + (channel * (1 - alpha)));
        }
        const style = getComputedStyle(el);
        return { color: style.color, colorParts: parse(style.color), background: base };
      });

      // A transparent or alpha-zero text colour is the exact defect.
      expect(seen.color, `composer text colour is ${seen.color}`).not.toBe('transparent');
      const alpha = seen.colorParts.length > 3 ? seen.colorParts[3] : 1;
      expect(alpha, `composer text alpha is ${alpha}`).toBeGreaterThan(0.5);

      // And it must contrast with what is actually painted behind it.
      const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const delta = Math.abs(luminance(seen.colorParts) - luminance(seen.background));
      expect(delta, `text ${seen.color} on composited ${JSON.stringify(seen.background.map(Math.round))}`).toBeGreaterThan(0.25);

      // The voice controls exist on desktop and are MORE important on a phone.
      for (const selector of ['.composer-mic', '.composer-live-voice']) {
        const control = fx.page.locator(selector);
        await expect(control).toBeVisible();
        const rect = await control.boundingBox();
        expect(rect, `${selector} has no box`).not.toBeNull();
        expect(rect.width, `${selector} width`).toBeGreaterThanOrEqual(40);
        expect(rect.x, `${selector} starts off the left edge`).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width, `${selector} runs past the right edge`).toBeLessThanOrEqual(VIEWPORT.width + 1);
        expect(rect.y + rect.height, `${selector} runs below the fold`).toBeLessThanOrEqual(VIEWPORT.height + 1);
      }
      // The reason these controls were hidden in the first place was that six
      // of them squeezed the text field to ~130px. Moving two back into the row
      // must not recreate that, so the field is MEASURED rather than eyeballed.
      const fieldWidth = await fx.page.evaluate(() => document
        .querySelector('.composer-field').getBoundingClientRect().width);
      expect(fieldWidth, `composer field is ${Math.round(fieldWidth)}px at ${VIEWPORT.width}px`)
        .toBeGreaterThanOrEqual(180);

      await fx.page.screenshot({ path: screenshotPath('composer-typed-text.png') });
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  // Live-caught by Pat, 2026-08-08: "the text box is ass, tiny as hell and can
  // barely see anything". composer.css claimed the field "grows with what is
  // typed" and nothing implemented it, so a long message showed ONE line and
  // scrolled inside itself. This spec is two-sided on purpose: it must GROW for
  // a multi-line draft and it must COME BACK DOWN afterwards, or "grows" would
  // pass just as well as a field that only ever gets taller.
  test('the composer grows with a long draft and shrinks back when it is cleared', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      const box = fx.page.locator('.composer-field textarea');
      await box.waitFor();
      const heightNow = () => box.evaluate((el) => el.getBoundingClientRect().height);

      await box.fill('one line');
      const single = await heightNow();

      await box.fill(Array.from({ length: 8 }, (_, i) => `line number ${i + 1} of a long draft`).join('\n'));
      const grown = await heightNow();
      expect(grown, `a multi-line draft must make the field taller: ${single}px -> ${grown}px`)
        .toBeGreaterThan(single + 20);

      // Bounded, so growing never pushes the conversation off the screen.
      const viewport = await fx.page.evaluate(() => window.innerHeight);
      expect(grown, `field must stay bounded: ${grown}px of ${viewport}px`)
        .toBeLessThanOrEqual(viewport * 0.45);

      await box.fill('');
      const cleared = await heightNow();
      expect(cleared, `clearing must shrink the field back: ${grown}px -> ${cleared}px`)
        .toBeLessThan(grown - 20);
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  // UNIVERSAL PERCEPTION SWEEP. Not "does the element exist" but "could a human
  // read it and reach it". Every defect Pat has reported on the phone passed a
  // gate that measured structure: invisible text, an unreachable control, a
  // message that never rendered. So this walks the app, TYPES into every field
  // it finds (the invisible-text bug only exists once a field holds text), and
  // checks what is actually painted.
  test('PERCEPTION: every visible text node is readable and inside the viewport', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      await fx.page.locator('.composer-field textarea').waitFor();
      // Put text everywhere first: several defects only appear when a field is
      // non-empty, which is why a browse-only audit could not see them.
      await fx.page.locator('.composer-field textarea').fill('readable?');
      await fx.page.screenshot({ path: screenshotPath('perception-plain-text.png') });
      await fx.page.locator('.composer-field textarea').fill('/model sonnet and some plain words after it');

      const report = await fx.page.evaluate(() => {
        const parse = (v) => (v.match(/[\d.]+/g) || []).map(Number);
        const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const composite = (el) => {
          const layers = [];
          for (let n = el; n; n = n.parentElement) {
            const parts = parse(getComputedStyle(n).backgroundColor);
            if (parts.length < 3) continue;
            const a = parts.length > 3 ? parts[3] : 1;
            if (a <= 0) continue;
            layers.push({ rgb: parts.slice(0, 3), a });
            if (a >= 1) break;
          }
          let base = [0, 0, 0];
          for (let k = layers.length - 1; k >= 0; k -= 1) {
            const { rgb, a } = layers[k];
            base = base.map((c, i) => (rgb[i] * a) + (c * (1 - a)));
          }
          return base;
        };
        const unreadable = [];
        const offscreen = [];
        const describe = (el) => {
          const chain = [];
          for (let n = el; n && n !== document.body; n = n.parentElement) {
            chain.unshift(`${n.tagName.toLowerCase()}${(n.className || '').toString().trim() ? '.' + n.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : ''}`);
          }
          return chain.slice(-4).join(' > ');
        };
        for (const el of document.querySelectorAll('body *')) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          // aria-hidden subtrees are decoration, not content. The slash backdrop
          // is a deliberate mirror whose plain text is transparent by design; a
          // reader is never meant to see it, so judging it as unreadable is a
          // false positive that would train the next person to ignore this list.
          if (el.closest('[aria-hidden="true"]')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          // Does this element paint its OWN text (not just its children's)?
          const ownText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
          const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
          const value = isField ? el.value : '';
          if (ownText || value) {
            const colorParts = parse(style.color);
            const alpha = colorParts.length > 3 ? colorParts[3] : 1;
            const delta = Math.abs(lum(colorParts) - lum(composite(el)));
            if (alpha < 0.4 || delta < 0.12) {
              unreadable.push(`${describe(el)} color=${style.color} delta=${delta.toFixed(3)} text="${(ownText || value).slice(0, 30)}"`);
            }
          }
          // Interactive things must be reachable on screen.
          if (['BUTTON', 'A', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'button') {
            if (rect.right < 1 || rect.bottom < 1 || rect.left > window.innerWidth - 1 || rect.top > window.innerHeight - 1) {
              offscreen.push(`${describe(el)} at ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            }
          }
        }
        return { unreadable, offscreen, viewport: [window.innerWidth, window.innerHeight] };
      });

      await fx.page.screenshot({ path: screenshotPath('perception-conversation.png'), fullPage: false });
      // eslint-disable-next-line no-console
      console.log('PERCEPTION REPORT ' + JSON.stringify(report, null, 1));
      expect(report.unreadable, `unreadable text:\n${report.unreadable.join('\n')}`).toEqual([]);
      expect(report.offscreen, `offscreen controls:\n${report.offscreen.join('\n')}`).toEqual([]);
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  // rel-4. The gate drove ONE size, 430x932, which is the DEVICE height of the
  // phone and not the height the app ever gets: as an installed PWA the web
  // view starts below the 59pt status bar, so the app sees 873. A gate laying
  // the app out 59px taller than the phone cannot see anything pushed under
  // the fold, which is most of what goes wrong on a phone.
  //
  // The answer is not a better single number. It is that the layout must not
  // depend on the number at all, so every size in SIZES (real portrait, the old
  // device height, and landscape) has to satisfy the same invariants.
  for (const size of SIZES) {
    test(`layout holds at ${size.name} ${size.width}x${size.height}`, async () => {
      const fx = await makeUiFixture();
      let electronApp;
      try {
        ({ electronApp, page: fx.page } = await launchPhone(fx, { size }));
        // rel-5: zero console errors is one of the DONE WHEN clauses, and it can
        // only be observed by listening from the moment the page exists.
        const consoleErrors = [];
        fx.page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
        fx.page.on('pageerror', (err) => consoleErrors.push(String(err?.message || err)));
        await fx.page.locator('.conv-assistant').waitFor();

        const metrics = await fx.page.evaluate(() => {
          const vw = window.innerWidth;
          const overflow = [];
          const smallTargets = [];
          const truncated = [];
          const tinyText = [];
          const lowContrast = [];

          // rel-5. Contrast needs the colour actually PAINTED behind the text,
          // which is the nearest ancestor with a non-transparent background, not
          // the element's own (usually transparent) one.
          const parseRgb = (value) => {
            const m = String(value).match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            if (parts.length < 3 || parts.some(Number.isNaN)) return null;
            return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
          };
          const paintedBackground = (el) => {
            for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
              const bg = parseRgb(getComputedStyle(node).backgroundColor);
              if (bg && bg.a > 0.5) return bg;
            }
            const root = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
            return root && root.a > 0.5 ? root : { r: 0, g: 0, b: 0, a: 1 };
          };
          const luminance = ({ r, g, b }) => {
            const channel = (c) => {
              const v = c / 255;
              return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          };
          const contrast = (fg, bg) => {
            const a = luminance(fg); const b = luminance(bg);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          };
          for (const el of document.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const decorative = el.getAttribute('aria-hidden') === 'true';
            if (!decorative && (r.right > vw + 1 || r.left < -1)) {
              overflow.push(`${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/)[0]}`);
            }
            if (el.matches('button, a, input, textarea, select, [role="button"]')
              && (r.width < 44 || r.height < 44)) {
              smallTargets.push(`${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/)[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
            const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            if (ownText && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow === 'ellipsis') {
              truncated.push(`${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/)[0]}`);
            }
            if (ownText && !decorative) {
              const label = `${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/)[0]}`;
              const size = parseFloat(cs.fontSize);
              // 11px is the floor below which a phone label stops being
              // readable at arm's length, and it is the one this sweep was
              // asked for.
              if (size && size < 11) tinyText.push(`${label} ${size}px`);
              const fg = parseRgb(cs.color);
              if (fg && fg.a > 0.5) {
                const ratio = contrast(fg, paintedBackground(el));
                // WCAG AA: 3:1 for large text (18.66px bold or 24px), else 4.5:1.
                const bold = Number(cs.fontWeight) >= 700;
                const large = size >= 24 || (bold && size >= 18.66);
                const floor = large ? 3 : 4.5;
                if (ratio < floor) lowContrast.push(`${label} ${ratio.toFixed(2)}:1 (needs ${floor})`);
              }
            }
          }
          const composer = document.querySelector('.composer').getBoundingClientRect();
          return {
            overflow,
            smallTargets,
            truncated,
            tinyText,
            lowContrast,
            docScrollWidth: document.documentElement.scrollWidth,
            docScrollHeight: document.documentElement.scrollHeight,
            vw,
            composerBottom: Math.round(composer.bottom),
            vh: window.innerHeight,
          };
        });

        // The page itself never scrolls sideways.
        expect(metrics.docScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.vw);
        expect(metrics.overflow, JSON.stringify(metrics.overflow)).toEqual([]);
        // Apple's 44px floor. A header that pays for a second row out of its
        // own tap target is the exact trade this catches.
        expect(metrics.smallTargets, JSON.stringify(metrics.smallTargets)).toEqual([]);
        // Nothing is ellipsised with no way to read it: on a touch device a
        // title attribute is not a recovery, because nothing hovers.
        expect(metrics.truncated, JSON.stringify(metrics.truncated)).toEqual([]);
        // The control you type into is on the screen at every size.
        expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.vh);
        // rel-5's remaining DONE WHEN clauses, which had never been gated.
        // The PAGE never scrolls vertically either: the shell sizes to the
        // visual viewport, and a document taller than it is the bug that once
        // pushed the composer off a real phone entirely.
        expect(metrics.docScrollHeight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.vh + 1);
        expect(metrics.tinyText, JSON.stringify(metrics.tinyText)).toEqual([]);
        expect(metrics.lowContrast, JSON.stringify(metrics.lowContrast)).toEqual([]);
        // Nothing may have thrown while rendering any of it.
        expect(consoleErrors, JSON.stringify(consoleErrors)).toEqual([]);

        await fx.page.screenshot({ path: screenshotPath(`layout-${size.name}-${size.width}x${size.height}.png`) });
      } finally {
        await closeUi(fx, electronApp);
      }
    });
  }

  test('the composer stays on screen no matter how long the transcript is', async () => {
    // The spec above passed throughout a period when a real phone could open a
    // long conversation and have NO WAY TO REPLY TO IT: .app-shell used
    // min-height:100% with no cap, so the shell grew with the transcript, the
    // scroll happened at the document level, and the composer (the last child)
    // ended up ~1200px below the bottom of the screen. Measured on the live
    // client at composer top=2141. Content clearance cannot see that, because
    // the composer is not content; the
    // assertion has to be about the CONTROL still being reachable.
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      // Two-sided on purpose: under this env the pre-fix rules come back and
      // this spec MUST fail, so a future refactor cannot make it pass by
      // making the composer unreachable in some new way.
      if (process.env.HARBOR_E2E_PRE_SHELL_HEIGHT_CSS === '1') {
        await fx.page.addStyleTag({
          content: 'body { overflow: visible !important; }'
            + '.app-shell { height: auto !important; min-height: 100% !important; }'
            + '.conv { min-height: auto !important; }',
        });
      }
      await fx.page.getByRole('button', { name: 'Switch session' }).click();
      await fx.page.getByText('Picked mobile session', { exact: true }).click();
      await fx.page.locator('.conv-assistant').waitFor();

      // A transcript far taller than the phone, which is the ordinary case.
      await fx.page.evaluate(() => {
        const body = document.querySelector('.conv-body');
        for (let i = 0; i < 60; i += 1) {
          const p = document.createElement('p');
          p.textContent = `Filler line ${i} that makes this transcript much taller than the viewport.`;
          body.appendChild(p);
        }
      });
      await fx.page.waitForTimeout(300);

      const geometry = await fx.page.evaluate(() => {
        const composer = document.querySelector('.composer');
        const c = composer.getBoundingClientRect();
        return {
          composerTop: Math.round(c.top),
          composerBottom: Math.round(c.bottom),
          viewportH: window.innerHeight,
          docScrollable: document.documentElement.scrollHeight > window.innerHeight + 1,
        };
      });

      expect(geometry.composerTop, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
      expect(geometry.composerBottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportH);
      // The DOCUMENT must never be the scroller: that is the shape the bug took.
      expect(geometry.docScrollable, JSON.stringify(geometry)).toBe(false);
      // And it has to be typeable, not merely present.
      await fx.page.getByLabel('Message', { exact: true }).fill('still reachable');
      await expect(fx.page.getByLabel('Message', { exact: true })).toHaveValue('still reachable');
    } finally {
      await closeUi(fx, electronApp);
    }
  });
});

// ---------------------------------------------------------------------------
// The 2026-08-08 flapping-phone family. All three specs describe ONE incident
// from different ends: a client-side request storm sank the connection, and
// everything the connection was holding died with it, silently.
// ---------------------------------------------------------------------------
test.describe('MOBILE-STORM connection survival gate', () => {
  test('a viewport event that changes nothing costs no RPC, and the poll keeps polling', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx, { keyboard: true }));
      await fx.page.getByLabel('Message', { exact: true }).waitFor({ timeout: 15000 });
      // Let the first render settle so the count below is the steady state.
      await fx.page.waitForTimeout(1200);

      const NUDGES = 40;
      const before = fx.menuCalls.length;
      // One per animation frame, the way the phone delivers them. Fired in one
      // synchronous loop instead, React batches them into a single render and
      // the measurement says nothing about a real device.
      await fx.page.evaluate((n) => new Promise((resolve) => {
        let i = 0;
        const step = () => {
          if (i >= n) { resolve(); return; }
          i += 1;
          window.__harborViewportNudge();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }), NUDGES);
      await fx.page.waitForTimeout(300);
      const afterNudges = fx.menuCalls.length - before;

      // 40 identical events used to buy exactly 40 `session:menu-state` calls
      // (measured against this same client before the fix). The 700ms poll runs
      // through this window too, so the ceiling is the poll's own budget, not
      // zero: ~40 frames is well under a second.
      expect(
        afterNudges,
        `${NUDGES} no-op viewport events produced ${afterNudges} session:menu-state calls`,
      ).toBeLessThanOrEqual(3);

      // TWO-SIDED ON PURPOSE. A card that has stopped polling altogether would
      // sail through the assertion above, and would be a worse bug than the one
      // being fixed: Pat could not answer a question at all.
      const beforePoll = fx.menuCalls.length;
      await fx.page.waitForTimeout(2500);
      const polls = fx.menuCalls.length - beforePoll;
      expect(polls, 'the 700ms answer-card poll must still be running').toBeGreaterThanOrEqual(2);
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  test('a send whose socket dies reports it, instead of spinning forever', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      const field = fx.page.getByLabel('Message', { exact: true });
      await field.waitFor({ timeout: 15000 });

      fx.holdNextSend();
      await field.fill('/clear');
      await fx.page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => fx.sent.length, { timeout: 10000 }).toBe(1);

      // Sink the connection the way production sank it: uncoalesced pushes
      // past the queue limit, which closes 1013 with the send still in flight.
      for (let i = 0; i < 40; i += 1) {
        fx.sendEmitter.emit('status', { sessionId: FIRST_SESSION, phase: 'noise', detail: `n${i}` });
      }

      // The spinner has to stop and the button has to come back, or the
      // composer is dead for the life of the page. This is the exact state Pat
      // photographed: "sending: /clear", a turning spinner, his text still in
      // the box, forever.
      await expect(fx.page.locator('.composer-send-spinner')).toHaveCount(0, { timeout: 20000 });
      await expect(fx.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 20000 });
      // And it must SAY so. A silent re-enable is a message the user believes
      // was delivered.
      await expect(fx.page.locator('.composer-status.error')).toContainText(/connection dropped/i, { timeout: 20000 });
      // The typed text is never thrown away: an undeliverable message the user
      // can still press Send on is the whole point of reporting rather than
      // swallowing.
      await expect(field).toHaveValue('/clear');
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  test('the transcript re-opens itself after a reconnect and keeps receiving updates', async () => {
    const fx = await makeUiFixture();
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      await fx.page.getByText('Drive the real phone flow.', { exact: true }).waitFor({ timeout: 15000 });
      // Settle past the open-retry ticker, which stops on its first success.
      await fx.page.waitForTimeout(2000);
      const opensBefore = fx.opens.filter((id) => id === FIRST_SESSION).length;

      // Sink it, then let the client's 4s reconnect land.
      for (let i = 0; i < 40; i += 1) {
        fx.sendEmitter.emit('status', { sessionId: FIRST_SESSION, phase: 'noise', detail: `n${i}` });
      }
      await fx.page.locator('.app-shell[data-connection="offline"]').waitFor({ timeout: 20000 });
      await fx.page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 30000 });

      // THE ASSERTION IS THE RE-OPEN ITSELF, not a rendered push.
      //
      // `transcript:open` is refcounted per clientId server-side and released
      // when a socket closes, so the reconnected client holds nothing and gets
      // no further updates for this session until it asks again. A spec that
      // merely emitted an update and looked for it on screen proves nothing,
      // because a stubbed transcript provider pushes through the router
      // regardless of what any client holds: that version passed against the
      // unfixed code.
      await expect
        .poll(() => fx.opens.filter((id) => id === FIRST_SESSION).length - opensBefore, { timeout: 20000 })
        .toBeGreaterThanOrEqual(1);


      // And the re-opened view still renders what arrives.
      fx.transcriptEmitter.emit('update', {
        sessionId: FIRST_SESSION,
        replace: [{ key: 'after-reconnect', kind: 'assistant', text: 'Landed after the reconnect.' }],
        header: { working: false },
      });
      await expect(fx.page.getByText('Landed after the reconnect.', { exact: true })).toHaveCount(1, { timeout: 15000 });
    } finally {
      await closeUi(fx, electronApp);
    }
  });

  // A CLAUDE SESSION'S ID IS MINTED BY HARBOR, so a client that has just
  // launched one already knows which session it started. This client instead
  // polled `sidebar:get-state` every 400ms for up to twelve seconds and matched
  // by folder plus recency. Three things wrong with that, and the fixture is
  // deliberately set to the case that shows all three: the launched session is
  // NOT published to the sidebar model, which is simply what "a session that
  // has not started writing yet" looks like.
  //
  //   - it never resolves, so the sheet sits on "Starting…" for twelve seconds
  //     and then opens nothing;
  //   - each attempt is an uncoalesced ~680KB `rpc:response` (891 sessions
  //     across 77 projects on Pat's machine), up to thirty of them, which is
  //     the exact shape that overflowed his connection twice;
  //   - matching by folder and recency can return an EXISTING session in that
  //     folder rather than the one just started.
  test('starting a session opens the id the launch minted, without polling for it', async () => {
    const fx = await makeUiFixture({ listLaunchedSession: false });
    let electronApp;
    try {
      ({ electronApp, page: fx.page } = await launchPhone(fx));
      await fx.page.getByRole('button', { name: 'Switch session' }).click();
      await fx.page.getByRole('button', { name: 'New session' }).click();
      await fx.page.locator('.newsession-sheet').waitFor();
      await fx.page.waitForTimeout(500);
      const readsBefore = fx.stateReads.length;

      const startedAt = Date.now();
      await fx.page.getByRole('button', { name: 'Start session' }).click();
      await expect.poll(() => fx.launches.length, { timeout: 15000 }).toBe(1);
      await expect(fx.page.locator('.newsession-sheet')).toHaveCount(0, { timeout: 15000 });
      const elapsed = Date.now() - startedAt;

      const argv = fx.launches[0].argv || [];
      const mintedId = argv[argv.indexOf('--session-id') + 1];
      expect(mintedId, `launch argv carried no --session-id: ${argv.join(' ')}`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // The session that opens is the one just started, even though nothing has
      // listed it yet.
      await expect
        .poll(() => fx.page.evaluate(() => localStorage.getItem('harbor-web-active')), { timeout: 15000 })
        .toBe(mintedId);

      // Fast, and cheap. The old path spent the full twelve-second timeout here
      // and thirty sidebar reads to arrive at null.
      expect(elapsed, `the sheet took ${elapsed}ms to close`).toBeLessThan(6000);
      const reads = fx.stateReads.length - readsBefore;
      expect(reads, `starting a session made ${reads} sidebar:get-state reads`).toBeLessThanOrEqual(4);
    } finally {
      await closeUi(fx, electronApp);
    }
  });
});

// Kept in its own spec module so the keyboard state has a named gate, while
// registering here avoids importing mobile.spec.js twice (that file also owns
// the MOBILE-9 security suite).
require('./mobile-keyboard.spec.js').registerMobileKeyboardSpecs({
  test,
  expect,
  makeUiFixture,
  launchPhone,
  closeUi,
  screenshotPath,
});
