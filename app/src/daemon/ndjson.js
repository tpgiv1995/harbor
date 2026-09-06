'use strict';

function writeRecord(socket, record) {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(`${JSON.stringify(record)}\n`);
}

function readRecords(stream, onRecord, onError) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try { onRecord(JSON.parse(line)); }
      catch (error) { onError(error); }
    }
  });
}

module.exports = { readRecords, writeRecord };
