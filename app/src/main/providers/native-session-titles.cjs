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
//
// The scan matches RAW BYTES and decodes only the lines that carry a marker
// (2026-10-06). A busy machine's store runs to ~15 GB over ~2,300 transcripts
// with no title records at all, and decoding every line to a string to find
// two rare record types costs minutes of CPU on a first pass. Buffer.indexOf
// skips the rest at memory speed. A transcript is scanned from the start once,
// the first time it changes after this shipped, and from its offset after that;
// the index cache version is deliberately NOT bumped, so no launch re-reads the
// whole store.
const TITLE_MARKS = [Buffer.from('custom-title'), Buffer.from('"summary"')];
const SCAN_CHUNK = 1024 * 1024;

function readClaudeTitles(file, previous = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const resume = Number.isInteger(previous.title_offset) && previous.title_offset <= size;
    let position = resume ? previous.title_offset : 0;
    let offset = position;
    let custom = resume ? previous.native_title || null : null;
    let summary = resume ? previous.native_summary || null : null;
    const consume = line => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) custom = record.customTitle.trim();
      if (record.type === 'summary' && typeof record.summary === 'string' && record.summary.trim()) summary = record.summary.trim();
    };
    // `lines` holds whole lines only. Matching lines are decoded in file order,
    // so a later rename still wins over an earlier one.
    const scan = (lines) => {
      const starts = new Map();
      for (const mark of TITLE_MARKS) {
        for (let at = lines.indexOf(mark); at !== -1;) {
          const start = at === 0 ? 0 : lines.lastIndexOf(10, at - 1) + 1;
          let end = lines.indexOf(10, at);
          if (end === -1) end = lines.length;
          starts.set(start, end);
          at = lines.indexOf(mark, end);
        }
      }
      for (const start of [...starts.keys()].sort((a, b) => a - b)) {
        consume(lines.toString('utf8', start, starts.get(start)));
      }
    };
    let pending = Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    while (position < size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!count) break;
      position += count;
      const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, count)]) : buffer.subarray(0, count);
      const last = data.lastIndexOf(10);
      if (last === -1) { pending = Buffer.from(data); continue; }
      scan(data.subarray(0, last + 1));
      offset += last + 1;
      // A copy: `buffer` is reused by the next read.
      pending = Buffer.from(data.subarray(last + 1));
    }
    // A valid final record need not have a newline. Re-read it on the next
    // append so an incomplete record is never skipped permanently.
    if (pending.length) scan(pending);
    return { native_title: custom, native_summary: summary, title_offset: offset };
  } finally { fs.closeSync(fd); }
}
module.exports = { readCodexTitles, readClaudeTitles };
