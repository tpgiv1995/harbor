'use strict';

const { EventEmitter } = require('node:events');
const { SessionClient } = require('../../daemon/client.js');
const { resolvePaths } = require('../../daemon/paths.js');

class SessionStreamSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    // Same rule as the control client: the socket comes from THIS supervisor's
    // env, never the process's, or a caller that pointed at a throwaway store
    // still streams bytes from the real daemon.
    this.env = options.env || process.env;
    this.client = options.client || new SessionClient({
      ...options,
      socketPath: options.socketPath || resolvePaths(this.env).socket,
    });
    this.observers = new Map();
    this.controller = null;
    this._pendingRelease = null;
    this.unsubscribe = this.client.onEvent((event) => this._event(event));
  }

  _event(event) {
    const paneId = event.id;
    if (!this.observers.has(paneId) && this.controller?.paneId !== paneId) return;
    if (event.type === 'frame') {
      const bytes = event.bytes ? Buffer.from(event.bytes, 'base64') : Buffer.from(event.text || '');
      this.emit('frame', { paneId, source: this.controller?.paneId === paneId ? 'control' : 'observe', bytes, text: bytes.toString('utf8') });
    } else if (event.type === 'exit') {
      this.emit('closed', { paneId, source: 'observe', reason: 'session exited' });
      this.emit('exit', { paneId, source: 'observe', code: event.exit?.code, signal: event.exit?.signal });
    } else if (event.type === 'stream-degraded') {
      this.emit('warning', { paneId, ...event });
    } else this.emit('record', { paneId, record: event });
  }

  attachObserver(paneId) {
    if (this.observers.has(paneId)) return this.observers.get(paneId);
    const entry = { paneId };
    this.observers.set(paneId, entry);
    this.client.request('observe', { id: paneId }).then(
      () => this.emit('observer-attached', { paneId }),
      (error) => this.emit('error', Object.assign(error, { paneId, source: 'observe' })),
    );
    return entry;
  }

  acquireControl(paneId, size = {}) {
    this.cancelScheduledRelease();
    this.controller = { paneId, size, frames: 1, source: 'control' };
    this.emit('control-acquired', { paneId, takeover: false });
    if (size.cols && size.rows) this.resize(paneId, size);
    return this.controller;
  }
  controllerReady(paneId) { return this.controller?.paneId === paneId; }
  sendInput(paneId, input) {
    if (!this.controllerReady(paneId)) throw new Error(`not controlling ${paneId}: acquireControl(${paneId}) first`);
    const params = typeof input === 'string'
      ? { text: input }
      : Buffer.isBuffer(input?.bytes)
        ? { ...input, bytes: input.bytes.toString('base64') }
        : input;
    this.client.request('input', { id: paneId, ...params }).catch((error) => this.emit('error', error));
  }
  resize(paneId, size) {
    this.client.request('resize', { id: paneId, cols: size.cols, rows: size.rows }).then(
      () => this.emit('pane-sized', { paneId, ...size }),
      (error) => this.emit('error', error),
    );
  }
  ensureDialogSize(paneId, size = {}) {
    const cols = size.cols || 120;
    const rows = size.rows || 60;
    return this.client.request('resize', { id: paneId, cols, rows })
      .then(() => ({ ok: true, via: 'sessiond', cols, rows }));
  }
  sizingFor() { return null; }
  releaseControl(paneId) {
    if (!this.controller || paneId && this.controller.paneId !== paneId) return;
    const released = this.controller.paneId;
    this.controller = null;
    this.emit('control-released', { paneId: released });
  }
  scheduleReleaseControl(paneId, delayMs = 450) {
    this.cancelScheduledRelease();
    const timer = setTimeout(() => { this._pendingRelease = null; this.releaseControl(paneId); }, delayMs);
    timer.unref?.();
    this._pendingRelease = { paneId, timer };
  }
  cancelScheduledRelease() { if (this._pendingRelease) clearTimeout(this._pendingRelease.timer); this._pendingRelease = null; }
  detach(paneId) {
    if (paneId) { this.observers.delete(paneId); this.releaseControl(paneId); return; }
    this.observers.clear();
    this.controller = null;
    this.unsubscribe?.();
    this.client.close();
  }
  childPids() { return []; }
}

module.exports = { SessionStreamSupervisor };
