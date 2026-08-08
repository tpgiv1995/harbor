'use strict';

// Herdr pane stream supervisor.
//
// The terminal bridge (docs/upstream-herdr-docs/persistence-remote.mdx,
// cli-reference.mdx) exposes two per-pane child processes:
//
//   herdr terminal session observe <pane> --cols N --rows M
//       Read-only. Prints NDJSON {type:'terminal.frame', bytes:<base64 ansi>}
//       records, then {type:'terminal.closed'} when the server closes it.
//       Any number of observers can watch one pane without taking ownership.
//
//   herdr terminal session control <pane> [--takeover] --cols N --rows M
//       Writable. Prints the same frame records AND reads NDJSON commands on
//       stdin: {type:'terminal.input', text|bytes}, {type:'terminal.resize',
//       cols, rows}, {type:'terminal.scroll', ...}, {type:'terminal.release'}.
//       Exactly one controller owns input and resize at a time. A second
//       controller without --takeover is refused (the child prints a record
//       with a "reason" mentioning "already has an attached client" and exits);
//       with --takeover it displaces the incumbent, whose child then exits.
//
// This supervisor spawns those children, decodes frames, routes input/resize,
// and enforces the acquire-on-focus / release-on-blur discipline (REQUIREMENTS
// S5): at most one controlled pane per supervisor. acquireControl() for a
// different pane throws until the current one is released, mirroring the GUI's
// "control only the focused pane" rule.
//
// It is an EventEmitter. Events:
//   frame              { paneId, source: 'observe'|'control', bytes:Buffer, text:string }
//   closed             { paneId, source, reason }
//   denied             { paneId, source, reason, record }   control refused (no takeover)
//   observer-attached  { paneId }
//   control-acquired   { paneId, takeover }
//   control-released   { paneId }
//   exit               { paneId, source, code, signal }
//   stderr             { paneId, source, text }
//   parse-error        { paneId, source, line, error }
//   error              Error (with paneId, source attached)
//
// The socket path is injectable for tests: pass { socketPath } (or set
// HERDR_SOCKET_PATH) and every child targets that isolated named session.
//
// Part of /home/you/dev/harbor (see README.md).

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { platform } = require('../platform/index.js');

const DEFAULT_HERDR_BIN = platform.herdrBin();
const DEFAULT_SIZE = { cols: 80, rows: 24 };

class PaneStreamSupervisor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.herdrBin = opts.herdrBin || DEFAULT_HERDR_BIN;
    this.socketPath = opts.socketPath || process.env.HERDR_SOCKET_PATH || platform.herdrTransport();
    this.observers = new Map(); // paneId -> entry
    this.controller = null; // single { paneId, child, size, source:'control' }
    this._pendingRelease = null; // { paneId, timer }
    this._sizing = new Map(); // paneId -> in-flight ensureDialogSize promise
    this.sizeTimeoutMs = opts.sizeTimeoutMs || 2500;
  }

  cancelScheduledRelease() {
    if (!this._pendingRelease) return;
    clearTimeout(this._pendingRelease.timer);
    this._pendingRelease = null;
  }

  _childEnv() {
    const env = Object.assign({}, process.env);
    if (this.socketPath) env.HERDR_SOCKET_PATH = this.socketPath;
    return env;
  }

  _spawn(args) {
    return spawn(this.herdrBin, args, { env: this._childEnv() });
  }

  _wire(entry) {
    const { child, paneId, source } = entry;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (e) { this.emit('parse-error', { paneId, source, line, error: e }); continue; }
        if (rec.type === 'terminal.frame') {
          const bytes = Buffer.from(rec.bytes, 'base64');
          entry.frames++;
          this.emit('frame', { paneId, source, bytes, text: bytes.toString('utf8') });
        } else if (rec.type === 'terminal.closed') {
          this.emit('closed', { paneId, source, reason: rec.reason });
          // Denial semantics (verified live 2026-07-17): a refused control
          // attach closes immediately with an "attach failed"-style reason.
          // A NORMAL release closes with reason "detached", and children we
          // released ourselves (entry.released) or that were superseded by a
          // swap must never mark the pane externally controlled.
          const isCurrentController = source === 'control' && this.controller === entry;
          const normalClose = entry.released || rec.reason === 'detached';
          const paneGone = /attach ended|not found/i.test(rec.reason || '');
          if (rec.reason && paneGone) {
            // The pane itself ended while we held control: a closure, never a
            // denial (round-2 live-proven reason: "terminal attach ended:
            // terminal ... not found").
            if (this.controller === entry) this.controller = null;
            this.emit('pane-gone', { paneId, source, reason: rec.reason });
          } else if (rec.reason && !normalClose && (isCurrentController || source === 'control' && entry.frames === 0)) {
            if (this.controller === entry) this.controller = null;
            if (entry.retryOnRefusal && !entry.retried) {
              // Likely racing our own just-released child; retry once plain.
              entry.denied = true;
              this.emit('control-retry', { paneId });
              setTimeout(() => {
                if (this.closed || (this.controller && this.controller.paneId === paneId)) return;
                const retryEntry = this.acquireControl(paneId, entry.size, { _isRetry: true });
                if (retryEntry) retryEntry.retried = true;
              }, 450).unref?.();
            } else {
              entry.denied = true;
              this.emit('denied', { paneId, source, reason: rec.reason, record: rec });
            }
          }
        } else if (rec.reason && !entry.released && source === 'control' && this.controller === entry) {
          // control refused via a bare reason record (defensive)
          entry.denied = true;
          this.controller = null;
          this.emit('denied', { paneId, source, reason: rec.reason, record: rec });
        } else {
          this.emit('record', { paneId, source, record: rec });
        }
      }
    });
    child.stderr.on('data', (d) => this.emit('stderr', { paneId, source, text: d.toString('utf8') }));
    child.on('error', (e) => { e.paneId = paneId; e.source = source; this.emit('error', e); });
    // stdin is a Socket, and a write racing the pane's death EMITS 'error'
    // (EPIPE) on it asynchronously; with no listener that is an unhandled
    // 'error' event, which killed the whole harbor-server process on
    // 2026-08-03 05:27 (requestFocusPane -> resize -> _writeControl on a pane
    // that had just died). The synchronous writable check in _writeControl
    // cannot close that race; only a listener can.
    if (child.stdin) {
      child.stdin.on('error', (e) => {
        this.emit('warning', { type: 'stdin-error', paneId, source, error: e });
      });
    }
    child.on('exit', (code, signal) => this.emit('exit', { paneId, source, code, signal }));
  }

  // Attach a read-only observer. Idempotent per pane within this supervisor
  // (the GUI runs one observer per visible pane). Multi-observer safety across
  // the pane itself is provided by Herdr; use separate supervisors (or callers)
  // when two independent observers of one pane are wanted.
  attachObserver(paneId, size = {}) {
    if (this.observers.has(paneId)) return this.observers.get(paneId);
    const cols = size.cols || DEFAULT_SIZE.cols;
    const rows = size.rows || DEFAULT_SIZE.rows;
    const child = this._spawn(['terminal', 'session', 'observe', paneId, '--cols', String(cols), '--rows', String(rows)]);
    const entry = { paneId, child, size: { cols, rows }, source: 'observe', frames: 0 };
    this.observers.set(paneId, entry);
    this._wire(entry);
    child.on('exit', () => { if (this.observers.get(paneId) === entry) this.observers.delete(paneId); });
    this.emit('observer-attached', { paneId });
    return entry;
  }

  // Acquire exclusive control of a pane (call on focus). Enforces the single
  // controller discipline: throws if this supervisor already controls a
  // different pane. opts.takeover replaces whatever controller Herdr currently
  // has for the pane (possibly one owned by another client, e.g. the TUI).
  acquireControl(paneId, size = {}, opts = {}) {
    this.cancelScheduledRelease();
    if (this.controller && this.controller.paneId !== paneId) {
      // Focus moved before the previous blur finished releasing: swap
      // gracefully instead of throwing (rapid pane-to-pane clicks race the
      // async release path).
      this.emit('warning', { type: 'control-swap', from: this.controller.paneId, to: paneId });
      this.releaseControl(this.controller.paneId);
    }
    if (this.controller && this.controller.paneId === paneId) return this.controller;
    const cols = size.cols || DEFAULT_SIZE.cols;
    const rows = size.rows || DEFAULT_SIZE.rows;
    // NEVER blind-takeover on reclaim: between our release and this acquire
    // another client (the TUI) may have legitimately attached, and takeover
    // would kick it (round-2 adversary proved this live). Instead, a refusal
    // shortly after our own release triggers ONE plain retry (the released
    // child is SIGTERMed at 300ms); see the denied handler wired below.
    const recentSelfRelease = this._lastSelfRelease
      && this._lastSelfRelease.paneId === paneId
      && Date.now() - this._lastSelfRelease.at < 3000;
    const args = ['terminal', 'session', 'control', paneId];
    if (opts.takeover) args.push('--takeover');
    args.push('--cols', String(cols), '--rows', String(rows));
    const child = this._spawn(args);
    const entry = {
      paneId, child, size: { cols, rows }, source: 'control', frames: 0, denied: false,
      retryOnRefusal: recentSelfRelease && !opts._isRetry,
      retried: !!opts._isRetry,
    };
    this.controller = entry;
    this._wire(entry);
    child.on('exit', () => {
      if (this.controller === entry) {
        this.controller = null;
        if (!entry.released && !entry.denied) {
          this.emit('control-released', { paneId: entry.paneId, unexpected: true });
        }
      }
    });
    this.emit('control-acquired', { paneId, takeover: !!opts.takeover });
    return entry;
  }

  // True once the daemon has started streaming to the control child: the
  // attach handshake is complete and stdin input can no longer be dropped
  // pre-grant (input written between spawn and the first frame vanishes
  // silently; live-caught as capability-menu sends landing nowhere).
  controllerReady(paneId) {
    return Boolean(this.controller
      && this.controller.paneId === paneId
      && !this.controller.denied
      && this.controller.frames > 0);
  }

  _writeControl(paneId, cmd) {
    if (!this.controller || this.controller.paneId !== paneId) {
      throw new Error(`not controlling ${paneId}: acquireControl(${paneId}) first`);
    }
    const child = this.controller.child;
    if (!child.stdin || !child.stdin.writable) throw new Error(`controller stdin for ${paneId} is not writable`);
    child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  // Send input to the controlled pane. `input` is a string (sent as text; the
  // caller includes the submit character, "\r" for Enter), or { text } / { bytes }.
  // Note: LF ("\n") does not submit a shell line; use "\r" or client.sendKeys.
  sendInput(paneId, input) {
    let cmd;
    if (typeof input === 'string') {
      cmd = { type: 'terminal.input', text: input };
    } else if (input && input.bytes != null) {
      const b = Buffer.isBuffer(input.bytes) ? input.bytes.toString('base64') : input.bytes;
      cmd = { type: 'terminal.input', bytes: b };
    } else {
      cmd = { type: 'terminal.input', text: input.text };
    }
    this._writeControl(paneId, cmd);
  }

  // Resize a pane. On the controlled pane this sends terminal.resize (control
  // owns resize). On an observe-only pane the observer child is respawned at the
  // new viewport, since observers cannot resize.
  resize(paneId, size) {
    const cols = size.cols;
    const rows = size.rows;
    if (this.controller && this.controller.paneId === paneId) {
      this.controller.size = { cols, rows };
      this._writeControl(paneId, { type: 'terminal.resize', cols, rows });
      return;
    }
    const obs = this.observers.get(paneId);
    if (obs) {
      obs.child.kill('SIGTERM');
      this.observers.delete(paneId);
      this.attachObserver(paneId, { cols, rows });
      return;
    }
    // No stream attached (pane went offscreen or detached mid-resize): a
    // no-op is correct; the next attach uses the fresh size.
    this.emit('warning', { type: 'resize-unattached', paneId });
    return false;
  }

  // Grow a pane's PTY so a dialog fits in it, then let go.
  //
  // The root cause of every "the question scrolled out of the terminal view"
  // report (four of them, 2026-07-21 through 2026-07-27) measured at last:
  // a fresh herdr pane is 23 rows x 54 columns, and Claude Code's
  // AskUserQuestion dialog needs about 35 rows at that width. The question,
  // the tab strip and option 1 scroll off the top, and the pane buffer holds
  // only the visible screen, so they are gone. Everything built on top of that
  // (the clipped parse, the offscreen rows, the honesty note) was decorating a
  // pane that was simply too small.
  //
  // Proven on a real dialog in an isolated pane: at 23x54 the capture is
  // byte-identical to Pat's screenshot; resizing the pty to 120x60 makes
  // Claude redraw the whole dialog live, question, "❯" on option 1 and all.
  // Ink re-renders on SIGWINCH, so this heals a dialog that is ALREADY up.
  //
  // Only a controller can resize (an observer attach provably cannot), so when
  // this supervisor is not already controlling the pane it attaches a
  // short-lived control child of its own, waits for the frame that proves the
  // grant, and releases. It never touches this.controller: the single
  // controller discipline is about INPUT ownership, and herdr's own rule is
  // one controller per PANE, so sizing pane A cannot disturb control of B.
  // A pane someone else controls (the TUI) refuses the attach; that is a skip,
  // not an error.
  ensureDialogSize(paneId, size = {}) {
    const cols = size.cols || DEFAULT_SIZE.cols;
    const rows = size.rows || DEFAULT_SIZE.rows;
    if (this.controller && this.controller.paneId === paneId && !this.controller.denied) {
      try {
        this.resize(paneId, { cols, rows });
        return Promise.resolve({ ok: true, via: 'controller', cols, rows });
      } catch (error) {
        return Promise.resolve({ ok: false, reason: error.message });
      }
    }
    if (this._sizing.has(paneId)) return this._sizing.get(paneId);
    const timeoutMs = this.sizeTimeoutMs;
    const run = new Promise((resolve) => {
      let child;
      try {
        child = this._spawn(['terminal', 'session', 'control', paneId, '--cols', String(cols), '--rows', String(rows)]);
      } catch (error) {
        resolve({ ok: false, reason: error.message });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.stdin?.writable && child.stdin.write(JSON.stringify({ type: 'terminal.release' }) + '\n'); } catch { /* already gone */ }
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        resolve(result);
      };
      // The first frame is the proof the daemon granted control; the resize
      // rides on the attach itself, so nothing more has to be written.
      child.stdout?.on('data', (chunk) => {
        if (String(chunk).includes('terminal.frame')) finish({ ok: true, via: 'transient', cols, rows });
      });
      child.on('error', (error) => finish({ ok: false, reason: error.message }));
      child.on('exit', () => finish({ ok: false, reason: 'control attach ended before the pane was sized' }));
      const timer = setTimeout(() => finish({ ok: false, reason: 'timed out sizing the pane' }), timeoutMs);
      timer.unref?.();
    }).then((result) => {
      this._sizing.delete(paneId);
      // Our own transient attach is a self-release like any other: herdr can
      // still be tearing it down when the next real acquireControl arrives and
      // refuse it. Recording it here routes that refusal into the existing
      // retry-once path instead of marking the pane externally controlled.
      if (result.ok) {
        this._lastSelfRelease = { paneId, at: Date.now() };
        this.emit('pane-sized', { paneId, cols, rows });
      }
      return result;
    });
    this._sizing.set(paneId, run);
    return run;
  }

  // The in-flight sizing for a pane, so a caller about to take real control can
  // wait it out instead of racing it. Herdr allows one controller per pane, so
  // an acquire landing on top of the sizer's transient attach is refused, and a
  // refusal marks the pane externally-controlled: a retry can paper over it,
  // waiting removes it.
  sizingFor(paneId) {
    return this._sizing.get(paneId) || null;
  }

  // Scroll the controlled pane's viewport. Params are passed through to the
  // terminal.scroll command (e.g. { rows: -3 }).
  scroll(paneId, params = {}) {
    this._writeControl(paneId, Object.assign({ type: 'terminal.scroll' }, params));
  }

  // Release control (call on blur). Sends terminal.release, ends stdin, and
  // ensures the child exits. opts.immediate skips any scheduled debounce.
  releaseControl(paneId, opts = {}) {
    if (opts.immediate !== false) this.cancelScheduledRelease();
    if (!this.controller) return;
    if (paneId && this.controller.paneId !== paneId) return;
    const entry = this.controller;
    entry.released = true;
    this.controller = null;
    this._lastSelfRelease = { paneId: entry.paneId, at: Date.now() };
    try {
      if (entry.child.stdin && entry.child.stdin.writable) {
        entry.child.stdin.write(JSON.stringify({ type: 'terminal.release' }) + '\n');
        entry.child.stdin.end();
      }
    } catch (e) { /* ignore: child may already be gone */ }
    setTimeout(() => { if (entry.child.exitCode === null) entry.child.kill('SIGTERM'); }, 300).unref();
    this.emit('control-released', { paneId: entry.paneId });
  }

  // Debounced release for blur churn: a quick reselect cancels the timer and
  // reuses the warm attach (recentSelfRelease retry) instead of paying a full
  // release-then-acquire round trip.
  scheduleReleaseControl(paneId, delayMs = 450) {
    if (!this.controller || this.controller.paneId !== paneId) return;
    this.cancelScheduledRelease();
    const timer = setTimeout(() => {
      this._pendingRelease = null;
      if (this.controller && this.controller.paneId === paneId) {
        this.releaseControl(paneId);
      }
    }, delayMs);
    timer.unref?.();
    this._pendingRelease = { paneId, timer };
  }

  // Tear down streams. detach(paneId) stops that pane's observer and, if held,
  // its controller. detach() with no argument stops everything this supervisor
  // owns. Kills children directly so no herdr child processes leak.
  detach(paneId) {
    this.cancelScheduledRelease();
    if (paneId) {
      const obs = this.observers.get(paneId);
      if (obs) { obs.child.kill('SIGTERM'); this.observers.delete(paneId); }
      if (this.controller && this.controller.paneId === paneId) {
        const c = this.controller;
        this.controller = null;
        c.child.kill('SIGTERM');
      }
      return;
    }
    for (const entry of this.observers.values()) entry.child.kill('SIGTERM');
    this.observers.clear();
    if (this.controller) { this.controller.child.kill('SIGTERM'); this.controller = null; }
  }

  // PIDs of every child this supervisor currently owns (for leak assertions).
  childPids() {
    const pids = [];
    for (const entry of this.observers.values()) if (entry.child.pid) pids.push(entry.child.pid);
    if (this.controller && this.controller.child.pid) pids.push(this.controller.child.pid);
    return pids;
  }
}

module.exports = { PaneStreamSupervisor, DEFAULT_HERDR_BIN };
