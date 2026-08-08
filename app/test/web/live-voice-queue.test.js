'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../web/src/voice/use-live-voice.js'), 'utf8');

test('live voice queues tool output until response.done', () => {
  assert.match(source, /if \(activeResponseRef\.current\) return/);
  assert.match(source, /queueRef\.current\.push/);
  assert.match(source, /case 'response\.done':[\s\S]*flush\(\)/);
  assert.match(source, /conversation_already_has_active_response|response\.create/);
});
