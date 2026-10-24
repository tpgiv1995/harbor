'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pastTense, progressive } = require('../../src/main/providers/plain-english.js');

// Every case is a real description shape from the 2026-10-24 survey.
test('a described command reads in the past tense once it has run', () => {
  const cases = [
    ['Install py-spy into C:\\tools for stack dumps', 'Installed py-spy into C:\\tools for stack dumps'],
    ['Find the session transcript across config homes', 'Found the session transcript across config homes'],
    ['Stop the stale keeper', 'Stopped the stale keeper'],
    ['Re-run tests, then verify the build', 'Re-ran tests, then verified the build'],
    ['Commit, push and publish', 'Committed, pushed and published'],
    ['Commit the port and list the changes', 'Committed the port and listed the changes'],
    ['Install dependencies and start Meeting Assistant', 'Installed dependencies and started Meeting Assistant'],
    ['Tie off the loose ends', 'Tied off the loose ends'],
    ['Copy the file to C:\\out', 'Copied the file to C:\\out'],
    ['Syntax-check both Python files', 'Syntax-checked both Python files'],
    ['Summarize the last 40 transcript entries', 'Summarized the last 40 transcript entries'],
  ];
  for (const [said, done] of cases) assert.equal(pastTense(said), done, said);
});

test('a running command reads the way the CLI says it', () => {
  assert.equal(progressive('Install py-spy into C:\\tools for stack dumps'), 'Installing py-spy into C:\\tools for stack dumps');
  assert.equal(progressive('Run the gate'), 'Running the gate');
  assert.equal(progressive('Tie off the loose ends'), 'Tying off the loose ends');
  assert.equal(progressive('Queue the batch'), 'Queuing the batch');
  assert.equal(progressive('Commit, push and publish'), 'Committing, pushing and publishing');
});

test('nouns after "and" are left alone', () => {
  assert.equal(pastTense('Check Dropbox install and sync state'), 'Checked Dropbox install and sync state');
  assert.equal(pastTense('Identify the GPU, driver version and install date'), 'Identified the GPU, driver version and install date');
  assert.equal(pastTense('Read the plan and test output'), 'Read the plan and test output');
});

test('a description that does not open with a known verb is kept as written', () => {
  for (const said of ['Final pass over the logs', 'Dry-run the publish', 'See how it binds', 'Full verification and export test', '']) {
    assert.equal(pastTense(said), null, said);
    assert.equal(progressive(said), null, said);
  }
});
