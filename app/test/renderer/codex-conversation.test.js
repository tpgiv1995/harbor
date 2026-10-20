'use strict';
// Codex windows show the parsed codex data: the live work meter runs for codex
// from the rollout alone (no pane line to poll), and the conversation draws
// request_user_input questions and path-only image attachments on desktop and
// phone. Source assertions, like the other renderer suites; the parsed shapes
// themselves are proven in test/providers/transcript-codex.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const tile = read('src/renderer/stage/SessionTile.jsx');
const conversation = read('src/renderer/stage/Conversation.jsx');
const phone = read('web/src/conversation/Conversation.jsx');
const styles = read('src/renderer/styles.css');

test('the work meter runs for codex without polling the pane, and a steer never restarts it', () => {
  assert.match(tile, /const readsPane = provider === 'claude';/);
  assert.match(tile, /const active = Boolean\(working && \(readsPane \? paneId : provider === 'codex'\)\);/);
  assert.match(tile, /const next = readsPane\s*\n\s*\? await window\.harbor\?\.session\?\.workMeter/, 'only a claude window reads the pane');
  assert.match(tile, /blocks\[i\]\.kind === 'user' && !blocks\[i\]\.queued && !blocks\[i\]\.steer/, 'the meter times the prompt that started the task');
});

test('a codex question renders with its options and an open, answered or closed state', () => {
  assert.match(conversation, /block\.kind === 'question'/);
  assert.match(conversation, /className="conv-question-option"/);
  assert.match(conversation, /if \(block\.answered\) return 'Answered';\s*\n\s*return block\.closed \? 'Not answered' : 'Waiting for your answer';/);
  assert.match(conversation, /const settled = block\.answered \|\| block\.closed;/, 'a closed question is settled, not open');
  for (const selector of ['.conv-question-list', '.conv-question-option', '.conv-question-state', '.conv-attachments']) {
    assert.ok(styles.includes(`${selector} {`), `${selector} is styled`);
  }
  assert.match(phone, /block\.kind === 'question'/, 'the phone keeps the question text too');
  assert.match(phone, /block\.answered \? 'Answered' : block\.closed \? 'Not answered' : 'Waiting for your answer'/);
});

test('path-only attachments are named, never dropped', () => {
  assert.match(conversation, /<ConvAttachments attachments=\{block\.attachments\} \/>/);
  assert.match(conversation, /title=\{file\.path\}/);
  assert.match(phone, /block\.attachments\?\.length/);
});

test('a codex delete-only patch counts as an edit in a collapsed action group', () => {
  assert.match(conversation, /countVerb\(blocks, 'Deleted'\)/);
  assert.match(phone, /countVerb\(blocks, 'Deleted'\)/);
});
