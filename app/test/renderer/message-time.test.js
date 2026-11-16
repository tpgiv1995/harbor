'use strict';

// The time on each prompt and reply (2026-11-16, Pat: "time stamps on messages
// ... needs to be in my timezone"): src/renderer/stage/message-time.cjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { messageTime, localDayKey } = require('../../src/renderer/stage/message-time.cjs');

const CT = { locale: 'en-US', timeZone: 'America/Chicago' };
// Monday 2026-11-16 3:38 PM Central (21:38 UTC).
const NOW = Date.parse('2026-11-16T21:38:00Z');
const at = (iso, extra = {}) => messageTime(iso, { ...CT, now: NOW, ...extra });

test('today is the bare time, in the zone, not UTC', () => {
  assert.equal(at('2026-11-16T21:38:00Z').label, '3:38 PM');
  assert.equal(at('2026-11-16T06:05:00Z').label, '12:05 AM', 'after local midnight');
});

test('yesterday says so, including the UTC "today" that is still yesterday in Central', () => {
  assert.equal(at('2026-11-15T15:05:00Z').label, 'Yesterday 9:05 AM');
  assert.equal(at('2026-11-16T04:30:00Z').label, 'Yesterday 10:30 PM', 'a UTC-date of today, Central yesterday');
});

test('within the week the weekday, then the date, then the year', () => {
  assert.equal(at('2026-11-12T18:00:00Z').label, 'Thu 12:00 PM');
  assert.equal(at('2026-11-09T18:00:00Z').label, 'Nov 9, 12:00 PM', 'seven days back is a date');
  assert.equal(at('2025-12-31T18:00:00Z').label, 'Dec 31, 2025, 12:00 PM');
});

test('the hover title carries the whole date and the zone', () => {
  const t = at('2026-11-16T21:38:12Z');
  assert.match(t.title, /Monday, November 16, 2026/);
  assert.match(t.title, /3:38:12\s?PM/);
  assert.match(t.title, /CST/);
  assert.equal(t.iso, '2026-11-16T21:38:12.000Z');
});

test('daylight time is honoured on its own date', () => {
  const summer = messageTime('2026-07-04T17:00:00Z', { ...CT, now: Date.parse('2026-07-04T23:00:00Z') });
  assert.equal(summer.label, '12:00 PM');
  assert.match(summer.title, /CDT/);
});

test('another zone prints its own wall clock', () => {
  const ny = messageTime('2026-11-16T21:38:00Z', { locale: 'en-US', timeZone: 'America/New_York', now: NOW });
  assert.equal(ny.label, '4:38 PM');
});

test('a missing or broken time prints nothing', () => {
  assert.equal(messageTime(null), null);
  assert.equal(messageTime('not a date'), null);
  assert.equal(messageTime(undefined), null);
});

test('the day key turns at local midnight', () => {
  const before = localDayKey(Date.parse('2026-11-17T05:59:00Z'), 'America/Chicago');
  const after = localDayKey(Date.parse('2026-11-17T06:01:00Z'), 'America/Chicago');
  assert.notEqual(before, after);
  assert.equal(localDayKey(Date.parse('2026-11-16T21:38:00Z'), 'America/Chicago'), before);
});
