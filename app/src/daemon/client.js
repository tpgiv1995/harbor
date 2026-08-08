'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { readRecords, writeRecord } = require('./ndjson.js');
const { resolvePaths, listenAddress } = require('./paths.js');

class SessionClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.socketPath = options.socketPath || resolvePaths().socket;
    this.socket = null;
    this.pending = new Map();
    this.connecting = null;
    const configured = options.requestTimeoutMs ?? Number(process.env.HARBOR_SESSIOND_REQUEST_TIMEOUT_MS || 10000);
    this.requestTimeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10000;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(listenAddress(this.socketPath));
      const fail = (error) => { this.connecting = null; reject(error); };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        this.socket = socket;
        this.connecting = null;
        readRecords(socket, (record) => this._record(record), (error) => this.emit('error', error));
        socket.on('error', (error) => this._disconnect(error));
        socket.on('close', () => this._disconnect(new Error('session daemon connection closed')));
        resolve();
      });
    });
    return this.connecting;
  }

  _record(record) {
    if (record.type === 'event') {
      this.emit('event', record.event);
      return;
    }
    const pending = this.pending.get(record.request_id);
    if (!pending) return;
    this.pending.delete(record.request_id);
    clearTimeout(pending.timer);
    if (record.ok) pending.resolve(record.result);
    else pending.reject(new Error(record.error || 'session daemon request failed'));
  }

  _disconnect(error) {
    if (!this.socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  onEvent(listener) {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  async request(verb, params = {}) {
    await this.connect();
    const requestId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`${verb} request timed out after ${this.requestTimeoutMs}ms`);
        error.code = 'SESSIOND_REQUEST_TIMEOUT';
        reject(error);
        this.socket?.destroy();
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    writeRecord(this.socket, { type: 'request', request_id: requestId, verb, params });
    return promise;
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

module.exports = { SessionClient };
