'use strict';

/** @type {import('@playwright/test').PlaywrightTestConfig} */
const path = require('node:path');

module.exports = {
  testDir: __dirname,
  testMatch: 'harbor.spec.js',
  timeout: 180000,
  expect: { timeout: 30000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: path.join(__dirname, 'results.json') }]],
  use: {
    trace: 'off',
  },
};
