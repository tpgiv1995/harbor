'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScreenModel } = require('../../src/daemon/screen.js');

for (const cols of [24, 80]) {
  for (const terminator of ['\x07', '\x1b\\']) {
    test(`OSC 8 leaves multiline question text and cursor intact at ${cols} columns with ${terminator === '\x07' ? 'BEL' : 'ST'}`, async () => {
      const url = 'https://example.invalid/diagnostics?view=full';
      const prefix = 'Run this command:\r\n\r\nprintf diagnostic\r\nThen review ';
      const suffix = '?\r\n\r\n> Draft';
      const plain = new ScreenModel({ cols, rows: 16 });
      const linked = new ScreenModel({ cols, rows: 16 });
      try {
        await plain.write(prefix + url + suffix);
        await linked.write(prefix + `\x1b]8;;${url}${terminator}${url}\x1b]8;;${terminator}` + suffix);
        const expected = await plain.read();
        assert.match(expected.visible, /Run this command:/);
        assert.match(expected.visible, /> Draft/);
        assert.deepEqual(await linked.read(), expected);
      } finally {
        plain.terminal.dispose();
        linked.terminal.dispose();
      }
    });
  }
}
