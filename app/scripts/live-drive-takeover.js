'use strict';
/* Drive Take over on the LIVE app against a REAL outside-terminal claude
   session. argv: <sessionId> <ownerPid>.
   Phase A (refusal): tee moved aside -> Take over must surface an honest
   error and must NOT kill anything. Phase B (real): tee restored -> armed
   copy -> confirm -> owner pid dies -> window becomes drivable -> a bar
   message gets a real reply. Screenshots at every state. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const OUT = process.env.HARBOR_DRIVE_OUT
  || '/tmp/claude-1000/-home-you-dev-harbor/afa9ccb7-a5de-4803-8de7-c9b5a7436654/scratchpad';
const SID = process.argv[2];
const OWNER = Number(process.argv[3]);
const TEE = path.join(os.homedir(), '.cache/harbor/context', `${SID}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  if (!SID || !OWNER) throw new Error('usage: node live-drive-takeover.js <sessionId> <ownerPid>');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  // The CDP port accepts before the BrowserWindow exists on a cold boot;
  // wait for a live renderer page instead of grabbing contexts()[0] blind.
  let page = null;
  const pageDeadline = Date.now() + 30000;
  while (Date.now() < pageDeadline) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.isClosed()) || null;
    if (page) break;
    await sleep(500);
  }
  if (!page) throw new Error('no renderer page appeared over CDP');
  await page.waitForSelector('.rail', { timeout: 30000 });
  const report = { sid: SID, owner: OWNER, steps: [] };
  const note = (k, v) => { report.steps.push({ k, v }); console.log(k, JSON.stringify(v)); };

  // Open the session's window: wait for the indexer to list the row, then click it.
  const row = page.locator(`.sr[data-session-id="${SID}"]`);
  const deadline = Date.now() + 120000;
  let found = false;
  while (Date.now() < deadline) {
    await page.locator('.rail-find').fill('README');
    await sleep(1200);
    if (await row.count() > 0) { found = true; break; }
    await page.locator('.rail-find').fill('');
    await sleep(2000);
  }
  if (!found) throw new Error('session row never appeared in the rail');
  await row.click();
  await page.waitForSelector(`.win2[data-session-id="${SID}"]`, { timeout: 15000 });
  await sleep(4000); // header liveness poll settles (5s cadence)

  const stateWord = await page.locator('.ubar-status .ustat-dot').getAttribute('aria-label').catch(() => null);
  note('state-word', stateWord);
  await page.screenshot({ path: `${OUT}/take-01-watchonly.png` });

  // No Take over chip exists (Pat's veto 2026-07-20): the send itself adopts.
  note('chip-count-must-be-zero', await page.locator('.takeover-chip').count());

  // ---- Phase A: refusal with the tee moved aside ----
  fs.renameSync(TEE, `${TEE}.hidden`);
  try {
    await page.locator('.ubar-input').fill('refusal probe');
    await page.locator('.ubar-input').press('Enter');
    await sleep(2500);
    const phase = await page.locator('.ubar-status .ustat-phase').innerText().catch(() => null);
    note('refusal-phase', phase);
    note('owner-still-alive-after-refusal', alive(OWNER));
    note('draft-kept-after-refusal', await page.locator('.ubar-input').inputValue().catch(() => ''));
    await page.screenshot({ path: `${OUT}/take-03-refusal.png` });
  } finally {
    fs.renameSync(`${TEE}.hidden`, TEE);
  }
  if (!alive(OWNER)) throw new Error('refusal path killed the owner; ABORT');

  // ---- Phase B: the real adopt-on-send. The message rides the adoption:
  // kill, resume, link, focus, deliver, all from one Enter. ----
  await sleep(1500);
  await page.locator('.ubar-input').fill('Reply with exactly the single word: ADOPTED');
  await page.locator('.ubar-input').press('Enter');

  // Owner must die within the kill budget.
  let died = null;
  const killDeadline = Date.now() + 15000;
  while (Date.now() < killDeadline) {
    if (!alive(OWNER)) { died = true; break; }
    await sleep(200);
  }
  note('owner-died', died === true);

  // The window upgrades to drivable once the fresh pane links.
  let drivable = false;
  const adoptDeadline = Date.now() + 90000;
  while (Date.now() < adoptDeadline) {
    const word = await page.locator('.ubar-status .ustat-dot').getAttribute('aria-label').catch(() => null);
    if (word && word.includes('drivable')) { drivable = true; break; }
    await sleep(1500);
  }
  note('drivable', drivable);
  await page.screenshot({ path: `${OUT}/take-04-adopted.png` });
  if (!drivable) { fs.writeFileSync(`${OUT}/takeover-report.json`, JSON.stringify(report, null, 2)); throw new Error('window never became drivable'); }

  // The adopt delivered the message; wait for the REAL reply in the conversation.
  let replied = false;
  const replyDeadline = Date.now() + 120000;
  while (Date.now() < replyDeadline) {
    const text = await page.locator(`.win2[data-session-id="${SID}"] .conv`).innerText().catch(() => '');
    if (/\bADOPTED\b/.test(text) && text.split('ADOPTED').length > 2) { replied = true; break; }
    await sleep(2000);
  }
  note('real-reply-in-conversation', replied);
  await page.screenshot({ path: `${OUT}/take-05-replied.png` });

  fs.writeFileSync(`${OUT}/takeover-report.json`, JSON.stringify(report, null, 2));
  console.log('DONE', JSON.stringify({ died, drivable, replied }));
  await browser.close();
})();
