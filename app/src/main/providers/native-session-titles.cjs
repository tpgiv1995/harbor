'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function readCodexTitles(configHome) {
  const titles = new Map();
  let text;
  try { text = await fs.promises.readFile(path.join(configHome, 'session_index.jsonl'), 'utf8'); }
  catch { return titles; }
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (typeof record.id !== 'string' || typeof record.thread_name !== 'string' || !record.thread_name.trim()) continue;
    const stamp = Date.parse(record.updated_at) || 0;
    if (!titles.has(record.id) || titles.get(record.id).stamp <= stamp) {
      titles.set(record.id, { title: record.thread_name.trim(), stamp });
    }
  }
  return new Map([...titles].map(([id, value]) => [id, value.title]));
}

// Claude appends names to its transcript. Keep an offset in Harbor's own index
// so continued sessions scan only newly appended bytes, never the whole chat.
function readClaudeTitles(file, previous = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const resume = Number.isInteger(previous.title_offset) && previous.title_offset <= size;
    let position = resume ? previous.title_offset : 0;
    let offset = position;
    let custom = resume ? previous.native_title || null : null;
    let summary = resume ? previous.native_summary || null : null;
    let pending = Buffer.alloc(0);
    const buffer = Buffer.alloc(64 * 1024);
    const consume = line => {
      if (!line.includes('custom-title') && !line.includes('"summary"')) return;
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) custom = record.customTitle.trim();
      if (record.type === 'summary' && typeof record.summary === 'string' && record.summary.trim()) summary = record.summary.trim();
    };
    while (position < size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let start = 0;
      for (let end; (end = pending.indexOf(10, start)) !== -1; start = end + 1) {
        consume(pending.subarray(start, end).toString('utf8'));
        offset += end - start + 1;
      }
      pending = pending.subarray(start);
    }
    // A valid final record need not have a newline. Re-read it on the next
    // append so an incomplete record is never skipped permanently.
    if (pending.length) consume(pending.toString('utf8'));
    return { native_title: custom, native_summary: summary, title_offset: offset };
  } finally { fs.closeSync(fd); }
}
module.exports = { readCodexTitles, readClaudeTitles };
