'use strict';

const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const VERIFY_E2E_DIR = path.join(APP_ROOT, 'verify', 'e2e');

module.exports = {
  APP_ROOT,
  REPO_ROOT,
  VERIFY_E2E_DIR,
};
