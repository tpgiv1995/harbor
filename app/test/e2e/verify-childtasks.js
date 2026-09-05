'use strict';

// One-off end-to-end driver for the orchestration child-task nesting + read-only
// preview. Launches the REAL app against the REAL session index, but with the
// daemon disabled and launch calls faked, so it never touches the live herdr
// daemon and never resumes a session. Screenshots go to verify/e2e/.
const path = require('node:path');
const { launchHarbor, closeHarbor, screenshot } = require('./helpers/electron.js');

function fail(msg) {
  console.error('VERIFY_CHILDTASKS_FAIL', msg);
  process.exitCode = 1;
  throw new Error(msg);
}

(async () => {
  const { electronApp, page } = await launchHarbor({
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: '/tmp/harbor-verify-nosocket.sock',
  });

  try {
    // Pick a project that actually has finished child tasks in the real index.
    const target = await page.evaluate(async () => {
      const state = await window.harbor.sidebar.getState();
      const projects = state.model.projects || [];
      let best = null;
      for (const p of projects) {
        const kids = (p.sessions || []).filter((s) => s.isChildTask && !s.isLive).length;
        if (kids > 0 && (!best || kids > best.kids)) best = { label: p.label, kids };
      }
      return best;
    });
    if (!target) fail('no project with child tasks found in the real index');
    console.log('VERIFY_CHILDTASKS_TARGET', JSON.stringify(target));

    // Make sure the target project group is expanded (click its row if collapsed).
    await page.evaluate((label) => {
      const rows = Array.from(document.querySelectorAll('.sidebar-project-row'));
      const row = rows.find((r) => r.querySelector('.sidebar-project-label')?.textContent === label);
      if (row && row.querySelector('.sidebar-caret')?.textContent.includes('▸')) row.click();
    }, target.label);
    await page.waitForTimeout(500);

    // The child-group row must exist and show the count. VirtualList renders only
    // visible rows, so scroll the list until it appears.
    const groupSel = '.sidebar-child-group';
    let groupFound = false;
    for (let i = 0; i < 20; i += 1) {
      groupFound = await page.evaluate((sel) => !!document.querySelector(sel), groupSel);
      if (groupFound) break;
      await page.evaluate(() => {
        const list = document.querySelector('.sidebar-virtual-list');
        if (list) list.scrollTop += 300;
      });
      await page.waitForTimeout(150);
    }
    if (!groupFound) fail('child-group row never rendered');

    const groupText = await page.evaluate((sel) => document.querySelector(sel)?.textContent || '', groupSel);
    console.log('VERIFY_CHILDTASKS_GROUP_TEXT', JSON.stringify(groupText));
    if (!/\d/.test(groupText)) fail('child-group has no count');

    console.log('SHOT', await screenshot(page, 'childtasks-01-collapsed.png'));

    // Expand the child-group and confirm indented child rows appear.
    await page.evaluate((sel) => document.querySelector(sel)?.click(), groupSel);
    await page.waitForTimeout(500);
    const childCount = await page.evaluate(() => document.querySelectorAll('.sidebar-session-row.child').length);
    console.log('VERIFY_CHILDTASKS_CHILD_ROWS', childCount);
    if (childCount < 1) fail('no child rows rendered after expanding the group');
    console.log('SHOT', await screenshot(page, 'childtasks-02-expanded.png'));

    // Click the first child row -> read-only preview panel (NOT a resume).
    await page.evaluate(() => document.querySelector('.sidebar-session-row.child')?.click());
    await page.waitForSelector('.preview-panel', { timeout: 8000 });
    await page.waitForTimeout(1200); // let the preview text load
    const preview = await page.evaluate(async () => ({
      title: document.querySelector('.preview-panel-title')?.textContent || '',
      textLen: (document.querySelector('.preview-text')?.textContent || '').length,
      hasResume: !!document.querySelector('.preview-resume'),
      hasCopy: !!document.querySelector('.preview-copy'),
      // Critical safety assertion: opening a child must NOT have spawned a resume.
      launchCalls: await window.harbor.e2e.getLaunchCalls(),
    }));
    console.log('VERIFY_CHILDTASKS_PREVIEW', JSON.stringify({
      title: preview.title,
      textLen: preview.textLen,
      hasResume: preview.hasResume,
      hasCopy: preview.hasCopy,
      launchCallCount: preview.launchCalls.length,
    }));
    if (preview.textLen < 20) fail('preview text did not load');
    if (!preview.hasResume || !preview.hasCopy) fail('preview missing secondary actions');
    if (preview.launchCalls.length !== 0) fail('opening a child task triggered a launch/resume call');
    console.log('SHOT', await screenshot(page, 'childtasks-03-preview.png'));

    console.log('VERIFY_CHILDTASKS_OK');
  } finally {
    await closeHarbor(electronApp, page);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
