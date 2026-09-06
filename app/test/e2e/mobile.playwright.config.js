'use strict';

/** @type {import('@playwright/test').PlaywrightTestConfig} */
const path = require('node:path');

module.exports = {
  testDir: __dirname,
  // mobile-ui imports mobile.spec to reuse isolatedFixture, which also keeps
  // the MOBILE-9 specs registered exactly once in this worker.
  testMatch: 'mobile-ui.spec.js',
  timeout: 120000,
  expect: { timeout: 30000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: path.join(__dirname, 'mobile-results.json') }]],
  use: { trace: 'off' },
};
