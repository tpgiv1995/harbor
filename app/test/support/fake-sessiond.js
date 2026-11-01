'use strict';

// A stand-in session daemon for specs and drive scripts that need the REAL
// sidebar bridge to see live panes without touching a real daemon.
//
// It speaks the daemon's NDJSON protocol on the isolated pipe/socket a harness
// names (listenAddress derives the Windows pipe name from the socket path, so
// two stores never collide). It answers only the verbs the rail reads (list,
// dormant, health) and refuses every other with an error, so a spec that needs
// a verb it lacks fails loudly instead of hanging. Nothing here spawns a
// process, so there is nothing to leak or to signal.
//
// `sessions` is the daemon's own record shape: { id, cwd, pid, agent,
// agent_session, argv, created_at }. Pass an array, or a function returning one
// when a spec changes the panes mid-test.

const net = require('node:net');
const { readRecords, writeRecord } = require('../../src/daemon/ndjson.js');
const { listenAddress } = require('../../src/daemon/paths.js');

async function startFakeSessiond(socketPath, sessions = []) {
  const sockets = new Set();
  const current = () => (typeof sessions === 'function' ? sessions() : sessions);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    readRecords(socket, (record) => {
      const answer = (result) => writeRecord(socket, { type: 'response', request_id: record.request_id, ok: true, result });
      if (record.verb === 'list') answer({ sessions: current() });
      else if (record.verb === 'dormant') answer({ sessions: {} });
      else if (record.verb === 'health') answer({ ok: true });
      else writeRecord(socket, { type: 'response', request_id: record.request_id, ok: false, error: `fake daemon has no ${record.verb}` });
    }, () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenAddress(socketPath), resolve); });
  // server.close() waits for every client to leave, and the bridge's clients
  // never do on their own, so the fake ends them.
  server.shutdown = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  return server;
}

module.exports = { startFakeSessiond };
