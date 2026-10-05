'use strict';

const fs = require('node:fs');

function readBytesFromTail(file, maxBytes) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer;
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// A keeper's log is created fresh per session, so when it dies during startup
// the diagnosis is at the TOP: node prints the source line, the caret and the
// error message before the stack frames. Tailing that file returns the least
// useful end of a crash, which is how a `listen ENOENT` arrived as four
// anonymous stack frames.
function readLogHead(file, lines = 40, maxBytes = 64 * 1024) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(handle).size, maxBytes);
    if (!size) return '';
    const buffer = Buffer.alloc(size);
    fs.readSync(handle, buffer, 0, size, 0);
    const parts = buffer.toString('utf8').split('\n');
    if (parts.at(-1) === '') parts.pop();
    return parts.slice(0, Math.max(1, lines)).join('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function readLogTail(file, lines = 100, maxBytes = 256 * 1024) {
  const bytes = readBytesFromTail(file, maxBytes);
  let text = bytes.toString('utf8');
  if (!text) return '';
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (size > bytes.length) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline < 0) return '';
    text = text.slice(firstNewline + 1);
  }
  const parts = text.split('\n');
  const trailing = parts.at(-1) === '';
  if (trailing) parts.pop();
  const selected = parts.slice(-Math.max(1, lines)).join('\n');
  return selected ? `${selected}${trailing ? '\n' : ''}` : '';
}

function appendLog(file, message, options = {}) {
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  const line = `${new Date().toISOString()} ${message}\n`;
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (size + Buffer.byteLength(line) > maxBytes) {
    const retained = readBytesFromTail(file, maxBytes);
    fs.writeFileSync(`${file}.1`, retained, { mode: 0o600 });
    fs.writeFileSync(file, '', { mode: 0o600 });
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}

module.exports = { appendLog, readLogTail, readLogHead };
