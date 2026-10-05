'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Three separate test files landed the same defect in one night: a real Chrome
// launch inside the plain unit suite. `npm test` has no xvfb and no session bus,
// so on a machine with no display the launch blocks FOREVER, and on a machine
// with one it opens Chrome on the user's live desktop, which this repo forbids.
//
// It is not a theoretical cost. shell-layout.test.js sat in ep_poll for 18
// minutes holding its own batch, and once merged it silenced BOTH sprint-2
// cursor workers until the dispatch supervisor killed their process groups at
// 1801s with "Last output: (none)". Two batches were lost to a test that cannot
// fail, only hang.
//
// Those browser-driven tests were gated on HARBOR_BROWSER_TESTS, but no script
// anywhere in this repo ever set that variable, so they never ran anywhere,
// not even under `npm run test:e2e:mobile`, which their own skip message
// pointed at. Dead code that only pretends to run does not get to stay: the
// browser-driven files that used to live here (composer.test.js,
// new-session-sheet.test.js, parity.test.js, session-browser.test.js,
// shell-layout.test.js all carried at least one such test) had their
// browser-driven blocks removed. The real browser-driven proof of these
// surfaces lives in test/e2e/mobile-ui.spec.js, which runs for real under the
// Playwright Electron gate (`npm run test:e2e`), not here.
//
// So the rule for this directory is no longer "gate and bound a browser
// launch"; it is simpler and stricter: test/web/ never launches a browser at
// all. A comment did not stop the first three copies of the old defect, so
// the rule is still a test, not a comment.

const TEST_ROOT = __dirname;

function testFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

test('no test file under test/web/ launches a browser', () => {
  const offenders = [];
  for (const file of testFiles(TEST_ROOT)) {
    // Exclude this file: it names the launch patterns in order to police
    // them, which would otherwise flag itself.
    if (path.resolve(file) === path.resolve(__filename)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const hits = [];
    if (/\bchromium\.launch\s*\(/.test(source)) hits.push('chromium.launch(...)');
    if (/\bbrowserType\.launch\s*\(/.test(source)) hits.push('browserType.launch(...)');
    if (/\b(?:firefox|webkit|puppeteer)\.launch\s*\(/.test(source)) hits.push('a *.launch(...) call');
    if (/channel:\s*['"]chrome['"]/.test(source)) hits.push(`a channel: 'chrome' launch option`);
    if (hits.length) offenders.push(`${path.relative(TEST_ROOT, file)}: ${hits.join('; ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `test/web/ must never launch a browser (browser-driven mobile proof belongs in test/e2e/mobile-ui.spec.js):\n  ${offenders.join('\n  ')}`,
  );
});
