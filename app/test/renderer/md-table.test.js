'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeRow,
  isSeparatorLine,
  parseTableLines,
} = require('../../src/renderer/stage/md-table.cjs');

test('a header + separator + body parses into a table', () => {
  const t = parseTableLines([
    '| # | Item | State |',
    '|---|---|---|',
    '| 1 | Plan seamlessness | Fixed |',
    '| 2 | Vault | Better than feared |',
  ]);
  assert.deepEqual(t.header, ['#', 'Item', 'State']);
  assert.deepEqual(t.rows, [
    ['1', 'Plan seamlessness', 'Fixed'],
    ['2', 'Vault', 'Better than feared'],
  ]);
});

test('no separator on line two means prose, never a table', () => {
  assert.equal(parseTableLines([
    '| a | b |',
    '| c | d |',
  ]), null);
  assert.equal(parseTableLines(['just prose with a | pipe']), null);
});

test('alignment colons carry through and pad to header width', () => {
  const t = parseTableLines([
    'Name | Count | Share',
    ':--- | :---: | ---:',
    'x | 1 | 50%',
  ]);
  assert.deepEqual(t.align, ['left', 'center', 'right']);
});

test('ragged rows pad short and glue long tails into the last cell', () => {
  const t = parseTableLines([
    '| a | b | c |',
    '|---|---|---|',
    '| only |',
    '| 1 | 2 | 3 | extra | more |',
  ]);
  assert.deepEqual(t.rows[0], ['only', '', '']);
  assert.deepEqual(t.rows[1], ['1', '2', '3 | extra | more']);
});

test('a lone pipe inside prose is not a row; a piped line is', () => {
  assert.equal(looksLikeRow('use grep | tail carefully'), false);
  assert.equal(looksLikeRow('| a | b |'), true);
  assert.equal(isSeparatorLine('|---|:---:|'), true);
  assert.equal(isSeparatorLine('|--|--|'), false);
});
