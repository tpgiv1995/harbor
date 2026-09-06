import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import harborIcon from '../../assets/icon-128.png';
import { AppMenu } from './AppMenu.jsx';
import { armedConfirmClick, DISARM_MS } from './armed-confirm.cjs';

function WorkersChip({ workers, onOpenWorker }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [confirmClose, setConfirmClose] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  const chipRef = useRef(null);

  useEffect(() => { if (!workers.length) setOpen(false); }, [workers.length]);

  const toggle = () => {
    if (!open && chipRef.current) {
      const rect = chipRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)) });
    }
    setOpen((o) => !o);
  };

  const runClose = async (worker, force) => {
    setOutcomes((current) => ({ ...current, [worker.id]: { busy: true, error: null } }));
    let result;
    try {
      result = await window.harbor.workers.close({
        paneId: worker.paneId,
        sessionId: worker.id,
        force,
      });
    } catch (error) {
      result = { ok: false, reason: String(error?.message || error) };
    }
    if (!result?.ok) {
      setOutcomes((current) => ({
        ...current,
        [worker.id]: { busy: false, error: result?.reason || 'Worker close failed' },
      }));
    }
  };

  const closeWorker = async (worker, event) => {
    event.stopPropagation();
    const prior = confirmClose?.id === worker.id ? confirmClose : null;
    const { armed, fire } = armedConfirmClick(prior, Date.now(), { id: worker.id });
    if (!fire) {
      setConfirmClose(armed);
      setTimeout(() => setConfirmClose((cur) => (cur === armed ? null : cur)), DISARM_MS);
      return;
    }
    setConfirmClose(null);
    await runClose(worker, false);
  };

  if (!workers.length) return null;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`workers-chip${open ? ' open' : ''}`}
        onClick={toggle}
        title="Orchestration workers (click to list)"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span aria-hidden="true">⚙</span>
        <span className="workers-count">{workers.length}</span>
        {workers.length === 1 ? 'worker' : 'workers'}
      </button>
      {open ? createPortal(
        <>
          <button type="button" tabIndex={-1} className="menu-backdrop" aria-label="Close worker list" onClick={() => setOpen(false)} />
          <div className="workers-menu" style={pos ? { top: pos.top, left: pos.left } : undefined} aria-label="Workers">
            <div className="workers-menu-title">Orchestration workers</div>
            {workers.map((worker) => {
              const outcome = outcomes[worker.id];
              return (
                <div key={worker.id} className={`workers-menu-item${outcome?.error ? ' error' : ''}`}>
                  <div className="workers-menu-row">
                    <button
                      type="button"
                      className="workers-menu-open"
                      title={worker.childTitle || worker.title}
                      onClick={() => { setOpen(false); onOpenWorker(worker); }}
                    >
                      {worker.childTitle || worker.title}
                    </button>
                    <button
                      type="button"
                      className={`workers-menu-close${confirmClose?.id === worker.id ? ' confirm' : ''}`}
                      title={confirmClose?.id === worker.id ? 'Click again to close this worker' : 'Close this worker (kills its session)'}
                      aria-label={`Close ${worker.childTitle || worker.title}`}
                      disabled={outcome?.busy}
                      onClick={(e) => closeWorker(worker, e)}
                    >
                      {outcome?.busy ? '…' : (confirmClose?.id === worker.id ? 'close?' : '×')}
                    </button>
                  </div>
                  {outcome?.error ? (
                    <div className="workers-menu-error" role="alert">
                      <span>{outcome.error}</span>
                      <button type="button" disabled={outcome.busy} onClick={() => runClose(worker, true)}>
                        Force close
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>,
        document.body,
      ) : null}
    </>
  );
}

// Slate title bar: brand left, live status right, window controls far right.
// Still the frameless window's drag region.
// One obvious button to open/close the session rail; state mirrors the
// Sidebar's persisted hidden flag via window events (Ctrl+Shift+B does the same).
function RailToggle() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const onState = (event) => setHidden(Boolean(event.detail?.hidden));
    window.addEventListener('harbor-rail-state', onState);
    return () => window.removeEventListener('harbor-rail-state', onState);
  }, []);
  return (
    <button
      type="button"
      className={`rail-toggle-btn${hidden ? ' closed' : ''}`}
      title={hidden ? 'Show the session rail (Ctrl+Shift+B)' : 'Hide the session rail (Ctrl+Shift+B)'}
      aria-label={hidden ? 'Show the session rail' : 'Hide the session rail'}
      aria-pressed={!hidden}
      onClick={() => window.dispatchEvent(new CustomEvent('harbor-rail-toggle'))}
    >
      <span className="rail-toggle-glyph" aria-hidden="true">{hidden ? '◧' : '◨'}</span>
    </button>
  );
}

export function TitleBar({ onOpenHelp, onNewSession, liveCount, workers, onOpenWorker, profiles }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    let gotEvent = false;
    const off = window.harbor.win?.onMaximizeChange?.((m) => { gotEvent = true; setMaximized(Boolean(m)); });
    window.harbor.win?.isMaximized?.()
      .then((m) => { if (active && !gotEvent) setMaximized(Boolean(m)); })
      .catch(() => {});
    return () => { active = false; if (off) off(); };
  }, []);

  const minimize = () => window.harbor.win?.minimize?.();
  const toggleMaximize = () => window.harbor.win?.toggleMaximize?.();
  const close = () => window.harbor.win?.close?.();

  const onDoubleClick = (event) => {
    if (event.target.closest('.titlebar-controls') || event.target.closest('.app-menu')
      || event.target.closest('.workers-chip')) return;
    toggleMaximize();
  };

  return (
    <div className="titlebar" onDoubleClick={onDoubleClick}>
      <div className="titlebar-left">
        <AppMenu onOpenHelp={onOpenHelp} onNewSession={onNewSession} profiles={profiles} />
        <RailToggle />
      </div>
      <div className="titlebar-brand">
        <img className="titlebar-mark" src={harborIcon} alt="" aria-hidden="true" />
        <span className="titlebar-wordmark">Harbor</span>
      </div>
      <div className="titlebar-spacer" aria-hidden="true" />
      <div className="titlebar-status">
        <WorkersChip workers={workers} onOpenWorker={onOpenWorker} />
        <span className="live-pill" title={`${liveCount} live session${liveCount === 1 ? '' : 's'}`}>
          <span className={`pulse${liveCount ? '' : ' off'}`} aria-hidden="true" />
          {`${liveCount} live`}
        </span>
      </div>
      <div className="titlebar-controls" role="group" aria-label="Window controls">
        <button type="button" className="titlebar-btn" aria-label="Help" title="Quick guide (F1)" onClick={onOpenHelp}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M3.8 4.2 A2.2 2.2 0 1 1 6 6.6 V7.4 M6 9.4 V9.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button type="button" className="titlebar-btn" aria-label="Minimize" title="Minimize" onClick={minimize}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.6" width="8" height="0.9" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={toggleMaximize}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.4" y="2.6" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="0.9" />
              <path d="M3.4 2.6 V1.4 H8.6 V6.6 H7.4" fill="none" stroke="currentColor" strokeWidth="0.9" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.4" y="1.4" width="7.2" height="7.2" fill="none" stroke="currentColor" strokeWidth="0.9" />
            </svg>
          )}
        </button>
        <button type="button" className="titlebar-btn titlebar-btn-close" aria-label="Close" title="Close" onClick={close}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.6 1.6 L8.4 8.4 M8.4 1.6 L1.6 8.4" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
