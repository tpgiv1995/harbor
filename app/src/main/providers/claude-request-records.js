'use strict';

// Claude Code 2.1.300 stores a copy of every API request in the transcript:
// `api-request`, `api-request-blob` and `api-request-shape` (see the CLI review
// of 2026-10-15 in docs/claude/providers.md). They are never conversation, the
// readers that classify by `type` already ignore them once parsed, and they are
// large: 14 to 36 percent of a transcript's bytes, single records of 60 KB to
// several MB. Recognising one from the start of its LINE lets a reader skip it
// before decoding or JSON.parse, which is the whole cost, and keeps it out of
// any reader that counts lines (a tail window grown until it holds N records).
//
// The CLI writes `type` as the record's first key (every one of 8,974 request
// records in 60 real transcripts, 2026-10-19); the 256-character window allows
// a key or two ahead of it. A conversation message that QUOTES the marker
// cannot match: inside a JSON string its quotes are escaped
// (`\"type\":\"api-request`).
const MARKER = '"type":"api-request';
const MARKER_BYTES = Buffer.from(MARKER);
const WINDOW = 256;

function isApiRequestRecordLine(line) {
  if (typeof line !== 'string' || line.length < MARKER.length) return false;
  return line.lastIndexOf(MARKER, WINDOW) !== -1;
}

// The same test on raw bytes, for readers that split a Buffer on 0x0a and
// should not decode a multi-megabyte record only to drop it.
function isApiRequestRecordBytes(buffer, start = 0, end = buffer.length) {
  const stop = Math.min(end, start + WINDOW + MARKER_BYTES.length);
  if (stop - start < MARKER_BYTES.length) return false;
  return buffer.subarray(start, stop).indexOf(MARKER_BYTES) !== -1;
}

module.exports = { isApiRequestRecordLine, isApiRequestRecordBytes };
