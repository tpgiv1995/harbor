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
    // `ready` settles once the daemon's relay is up (its observe reply comes
    // after the keeper registered the observer), true or false and never a
    // rejection, so a caller can wait for "frames will reach me" before it
    // makes the pane repaint (terminal-bridge's return to the live bottom).
    entry.ready = this.client.request('observe', { id: paneId }).then(
      () => { this.emit('observer-attached', { paneId }); return true; },
      (error) => { this.emit('error', Object.assign(error, { paneId, source: 'observe' })); return false; },
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
    // `purpose: 'dialog'` lets the daemon refuse this while any client shows
    // the pane raw (daemon.js, 2026-11-06); a refusal is not a success, so the
    // bridge retries on its cooldown instead of marking the pane sized. An
    // older daemon ignores the field and resizes as before.
    return this.client.request('resize', { id: paneId, cols, rows, purpose: 'dialog' })
      .then((result) => (result?.resized === false
        ? { ok: false, reason: result.reason || 'refused by the daemon' }
        : { ok: true, via: 'sessiond', cols, rows }));
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
  // A pane detach tells the DAEMON too (2026-10-14). It used to forget the pane
  // only here, so the daemon kept relaying every frame of it for the life of
  // the connection, and each later attach added another relay of the same
  // pane. A daemon older than `unobserve` answers "unsupported verb", which is
  // fine: it has nothing better to offer.
  detach(paneId) {
    if (paneId) {
      this.observers.delete(paneId);
      this.releaseControl(paneId);
      this.client.request('unobserve', { id: paneId }).catch(() => {});
      return;
    }
    this.reset();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Drop every stream and the connection, but KEEP LISTENING: the reconnect
  // path re-attaches through this same supervisor. It used to call detach(),
  // which also removed the one event listener, so after any daemon reconnect
  // every >_ view stopped receiving frames until the app restarted (2026-10-14).
  reset() {
    this.observers.clear();
    this.controller = null;
    this.client.close();
  }
  childPids() { return []; }
}

module.exports = { SessionStreamSupervisor };
