import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import harborIcon from '../../assets/icon-128.png';
import { AppMenu } from './AppMenu.jsx';
import { MemoryChip } from './MemoryChip.jsx';
import { armedConfirmClick, DISARM_MS } from './armed-confirm.cjs';
import { ago, formatWindow, formatResets } from './plan-usage-format.cjs';

export function PlanUsageButton() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const button = useRef(null);
  const panel = useRef(null);
  const pending = useRef(false);
  const generation = useRef(0);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const refresh = async () => {
    // Reopening while a request is pending must not start a second read.
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const version = generation.current;
    try {
      const next = await window.harbor.usage.getPlans();
      if (!Array.isArray(next?.plans)) throw new Error('Missing usage data');
      if (version === generation.current) setData(next);
    } catch {
      if (version === generation.current) setError('Could not refresh plan usage. Try again.');
    } finally {
      pending.current = false;
      if (version === generation.current) setBusy(false);
    }
  };
  // Ignore a late response after the title bar unmounts.
  useEffect(() => () => {
    generation.current += 1;
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const position = () => {
      const r = button.current?.getBoundingClientRect();
      if (r) {
        setPos({
          top: r.bottom + 6,
          left: Math.max(8, Math.min(r.right - 360, window.innerWidth - 368)),
          maxHeight: Math.max(100, window.innerHeight - r.bottom - 14),
        });
      }
    };
    const key = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        // The scroll region is a keyboard stop so short windows expose every plan.
        const targets = [...(panel.current?.querySelectorAll('[tabindex="0"], button:not(:disabled)') || [])];
        const index = targets.indexOf(document.activeElement);
        let next = (index + 1) % targets.length;
        if (event.shiftKey) next = index <= 0 ? targets.length - 1 : index - 1;
        event.preventDefault();
        targets[next]?.focus();
      }
    };
    position();
    panel.current?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    refresh();
  };
  const nowMs = Date.now();
  return <>
    <button ref={button} type="button" className={`titlebar-btn${open ? ' open' : ''}`} aria-label="Plan usage"
      title="Usage and reset times for all plans" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
        <path d="M2.7 12.5a6.1 6.1 0 1 1 10.6 0M8 3v1M3.5 6l.9.5M12.5 6l-.9.5M8 10l3-3M4 13h8" />
        <circle cx="8" cy="10" r="1" />
      </svg>
    </button>
    {open ? createPortal(<>
      <button className="menu-backdrop" type="button" tabIndex={-1} aria-label="Close plan usage" onClick={close} />
      <div ref={panel} className="plan-usage-menu" style={pos || undefined} role="dialog" aria-modal="true" aria-label="All plan usage" tabIndex={-1}>
        <div className="plan-usage-title">Plan usage</div>
        <div className="plan-usage-scroll" tabIndex={0} aria-label="Plan details, scroll for more" aria-busy={busy}>
          {error ? <p className="plan-usage-message" role="alert">{error}</p> : null}
          {!data ? <p className="plan-usage-message">{busy ? 'Reading plan usage...' : 'Usage unavailable'}</p> : null}
          {data && !data.plans.length ? <p className="plan-usage-message">No plans found.</p> : null}
          {['claude', 'codex', 'cursor'].map((provider) => {
            const plans = data?.plans.filter((p) => p.provider === provider) || [];
            return plans.length ? <section key={provider} aria-label={`${provider} plans`}>
              <h3 className="plan-usage-provider">{{ claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }[provider]}</h3>
              {plans.map((plan) => {
                const freshness = [];
                if (plan.unavailable) freshness.push('Unavailable');
                else if (plan.stale) freshness.push('Stale');
                if (plan.updatedAt) freshness.push(`as of ${ago(plan.updatedAt, nowMs)}`);
                else if (!plan.unavailable) freshness.push('time unknown');
                const account = [plan.email, plan.planType].filter(Boolean).join(' · ');
                let resetsTitle = plan.resetsReason || 'Available reset credits reported by the provider';
                if (!plan.resetsReason && plan.resets?.nextExpiresAt) {
                  resetsTitle = new Date(plan.resets.nextExpiresAt * 1000).toLocaleString();
                }
                return <div className="plan-usage-row" key={plan.id}>
                  <div className="plan-usage-identity">
                    <strong title={plan.label}>{plan.label}</strong>
                    <span className={`plan-usage-age${plan.stale || plan.unavailable ? ' is-stale' : ''}`} title={plan.reason || plan.updatedAt || 'No sample yet'}>
                      {freshness.join(' · ')}
                    </span>
                  </div>
                  {account ? <div className="plan-usage-account" title={account}>{account}</div> : null}
                  {plan.unavailable ? <div className="plan-usage-unavailable" title={plan.reason}>Usage unavailable</div> : null}
                  {plan.windows.map((w, i) => {
                    const f = formatWindow(w, nowMs);
                    return <div className="plan-usage-window" key={`${w.kind}-${i}`} title={f.tooltip}>
                      <span className="plan-usage-bar" aria-hidden="true">
                        <span style={{ width: `${f.width}%`, background: f.color }} />
                      </span>
                      <span className="plan-usage-percent">{f.label}</span>
                      <span className="plan-usage-reset">{f.reset}</span>
                    </div>;
                  })}
                  {provider === 'codex' ? <div className="plan-usage-resets" title={resetsTitle}>
                    {formatResets(plan.resets)}
                  </div> : null}
                </div>;
              })}
            </section> : null;
          })}
        </div>
        <div className="plan-usage-footer"><span>{data?.generatedAt ? `refreshed ${ago(data.generatedAt, nowMs)}` : 'Not refreshed'}</span>
          <button type="button" className="upd-btn" disabled={busy} onClick={refresh}>{busy ? 'Reading...' : 'Refresh'}</button>
        </div>
      </div>
    </>, document.body) : null}
  </>;
}

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

// Provider CLI updates (2026-09-03). The chip is the whole notice: it appears
// only when a provider CLI has a newer version the user has not skipped, and
// nothing here installs anything until a click says so. The menu shows WHAT the
// update changes (the release-note lines for exactly the versions being
// crossed) and WHAT IT MAY BREAK IN HARBOR (lines matching a Harbor contract
// are highlighted with the reason and the proof command), because "an update
// reverted something we built and we burned a day on it" is the failure this
// exists to prevent.
function relAgo(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function isNewerVersion(latest, installed) {
  if (!latest || !installed) return false;
  const parse = (value) => {
    const text = String(value).trim();
    const dash = text.indexOf('-');
    const core = (dash < 0 ? text : text.slice(0, dash)).split('.').map((p) => parseInt(p, 10) || 0);
    return { core, suffix: dash < 0 ? '' : text.slice(dash + 1) };
  };
  const a = parse(latest);
  const b = parse(installed);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const d = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (d) return d > 0;
  }
  return Boolean(!a.suffix && b.suffix);
}

function pendingList(state) {
  const providers = state?.providers || {};
  return ['claude', 'codex', 'cursor']
    .map((id) => providers[id])
    .filter((p) => p && isNewerVersion(p.latest, p.installed) && !(p.dismissed || []).includes(p.latest));
}

// Providers with a recent successful install still worth reviewing. Config drift
// usually shows on the CLI's FIRST RUN after an update, hours later, so the chip
// must stay reachable for a few days after an install, otherwise the compare and
// restore controls vanish the instant the install succeeds (2026-09-03).
const REVIEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
function reviewList(state, now = Date.now()) {
  const providers = state?.providers || {};
  return ['claude', 'codex', 'cursor']
    .map((id) => providers[id])
    .filter((p) => {
      const last = p?.history?.[0];
      return Boolean(last && last.ok && last.at && (now - Date.parse(last.at)) < REVIEW_WINDOW_MS);
    });
}

function ProviderRow({ provider, onChanged }) {
  const [notes, setNotes] = useState(null);
  const [openNotes, setOpenNotes] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [diff, setDiff] = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(null);
  const [error, setError] = useState('');

  // Three states, not two. A SKIPPED update must never render as "up to date":
  // the newer version still exists and the user chose not to take it, and
  // saying otherwise is the kind of quiet lie that costs a day later.
  const hasNewer = isNewerVersion(provider.latest, provider.installed);
  const skipped = hasNewer && (provider.dismissed || []).includes(provider.latest);
  const pending = hasNewer && !skipped;

  // The target moved (a Check now found a newer version): drop the notes cached
  // for the old target so "What's new" cannot show one version's notes beside an
  // Install button for another (2026-09-03).
  const latestRef = useRef(provider.latest);
  latestRef.current = provider.latest;
  useEffect(() => {
    setNotes(null);
    setOpenNotes(false);
  }, [provider.latest]);

  const loadNotes = async () => {
    if (openNotes) { setOpenNotes(false); return; }
    setOpenNotes(true);
    if (notes) return;
    setBusy('notes');
    const target = provider.latest;
    try {
      const fetched = await window.harbor.cliUpdates.notes({ provider: provider.id });
      // Only commit if the target has not moved out from under this request; a
      // stale response would otherwise re-cache notes for a version no longer
      // being installed (2026-09-03 round-2 fix).
      if (latestRef.current === target) setNotes(fetched);
    } catch (e) {
      setError(String(e?.message || e));
    }
    setBusy('');
  };

  const runInstall = async () => {
    setBusy('install');
    setError('');
    try {
      const r = await window.harbor.cliUpdates.install({ provider: provider.id, version: provider.latest });
      setResult(r);
      if (!r?.ok) setError(r?.error || r?.reason || 'install failed');
    } catch (e) {
      setError(String(e?.message || e));
    }
    setBusy('');
    onChanged?.();
  };

  const runSkip = async () => {
    setBusy('skip');
    try {
      await window.harbor.cliUpdates.dismiss({ provider: provider.id, version: provider.latest });
    } catch (e) {
      setError(String(e?.message || e));
    }
    setBusy('');
    onChanged?.();
  };

  const runDiff = async () => {
    setBusy('diff');
    setError('');
    try {
      const r = await window.harbor.cliUpdates.configDiff({ provider: provider.id });
      setDiff(r);
      if (!r?.ok) setError(r.reason || 'no snapshot to compare');
    } catch (e) {
      setError(String(e?.message || e));
    }
    setBusy('');
  };

  const runRestore = async () => {
    const prior = confirmRestore;
    const { armed, fire } = armedConfirmClick(prior, Date.now(), { id: provider.id });
    if (!fire) {
      setConfirmRestore(armed);
      setTimeout(() => setConfirmRestore((cur) => (cur === armed ? null : cur)), DISARM_MS);
      return;
    }
    setConfirmRestore(null);
    setBusy('restore');
    try {
      const r = await window.harbor.cliUpdates.restoreConfig({ provider: provider.id, snapshotId: diff?.snapshotId });
      setDiff({ ...diff, restored: r });
      if (!r?.ok) setError(r?.reason || 'restore failed');
    } catch (e) {
      setError(String(e?.message || e));
    }
    setBusy('');
  };

  const verify = notes?.verify || [];

  return (
    <div className={`upd-row${pending ? ' pending' : ''}`}>
      <div className="upd-row-head">
        <span className="upd-name">{provider.label || provider.id}</span>
        <span className="upd-versions">
          <span className="upd-from">{provider.installed || 'not installed'}</span>
          {/* The arrow only earns its place when the two versions differ; an
              up-to-date CLI pointing at itself is noise. */}
          {hasNewer ? (
            <>
              <span className="upd-arrow" aria-hidden="true">{'→'}</span>
              <span className={`upd-to${pending ? ' new' : ''}`}>{provider.latest}</span>
            </>
          ) : null}
        </span>
      </div>
      {provider.error ? <div className="upd-note-error">{provider.error}</div> : null}
      {!hasNewer && !provider.error ? (
        <div className="upd-uptodate">
          {provider.latest ? 'up to date' : 'latest version unknown; use the CLI’s own update command'}
        </div>
      ) : null}
      {skipped ? (
        <div className="upd-uptodate">
          {`${provider.latest} is available, skipped. The chip stays quiet; you can still install it here.`}
        </div>
      ) : null}
      {hasNewer ? (
        <>
          <div className="upd-actions">
            <button type="button" className="upd-btn primary" disabled={Boolean(busy)} onClick={runInstall}>
              {busy === 'install' ? 'Installing…' : 'Install'}
            </button>
            {skipped ? null : (
              <button type="button" className="upd-btn" disabled={Boolean(busy)} onClick={runSkip}>
                {busy === 'skip' ? '…' : 'Skip this version'}
              </button>
            )}
            <button
              type="button"
              className={`upd-btn upd-notes-toggle${openNotes ? ' on' : ''}`}
              aria-expanded={openNotes}
              onClick={loadNotes}
            >
              {openNotes ? 'Hide what’s new' : 'What’s new'}
            </button>
          </div>
          {provider.flags?.length ? (
            <div className="upd-flagsummary">
              {`may affect Harbor: ${provider.flags.join(', ')}`}
            </div>
          ) : null}
        </>
      ) : null}
      {openNotes ? (
        <div className="upd-notes">
          {busy === 'notes' ? <div className="upd-empty">Loading release notes…</div> : null}
          {notes?.unavailable ? <div className="upd-note-error">{notes.unavailable}</div> : null}
          {(notes?.sections || []).map((section) => (
            <div className="upd-section" key={section.version}>
              <div className="upd-section-title">{section.version}</div>
              {section.lines.map((line, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div className={`upd-line${line.flags.length ? ' flagged' : ''}`} key={`${section.version}-${i}`}>
                  <div className="upd-line-text">{line.text}</div>
                  {line.flags.map((flag) => (
                    <div className="upd-why" key={flag.id}>
                      <span className="upd-why-tag">{flag.id}</span>
                      <span className="upd-why-text">{`may affect Harbor: ${flag.why}`}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
          {notes && !notes.sections?.length && !notes.unavailable ? (
            <div className="upd-empty">No release notes for the versions being crossed.</div>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div className={`upd-result${result.ok ? ' ok' : ' bad'}`}>
          <div>{result.ok ? `Installed ${result.installed}` : `Install failed: ${result.error || 'unknown'}`}</div>
          {result.command ? <div className="upd-cmd">{result.command}</div> : null}
          {result.output ? <pre className="upd-output">{result.output}</pre> : null}
          {verify.length ? (
            <div className="upd-verify">
              <div className="upd-verify-title">Verify what this touched</div>
              {verify.map((flag) => (
                <div className="upd-verify-row" key={flag.id}>
                  <span className="upd-why-tag">{flag.id}</span>
                  <code>{flag.verify}</code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {provider.history?.length || result ? (
        <div className="upd-actions">
          <button type="button" className="upd-btn" disabled={Boolean(busy)} onClick={runDiff}>
            {busy === 'diff' ? '…' : 'Compare config since update'}
          </button>
          {diff?.ok ? (
            <button
              type="button"
              className={`upd-btn danger${confirmRestore ? ' confirm' : ''}`}
              disabled={Boolean(busy)}
              onClick={runRestore}
            >
              {confirmRestore ? 'Restore? click again' : 'Restore snapshot'}
            </button>
          ) : null}
        </div>
      ) : null}
      {diff?.ok ? (
        <div className="upd-diff">
          <div className="upd-diff-head">
            {`snapshot ${diff.snapshotId} · ${diff.changedCount} file${diff.changedCount === 1 ? '' : 's'} changed since`}
          </div>
          {diff.files.map((file) => (
            <div className="upd-diff-file" key={file.source}>
              <div className="upd-diff-path">{file.source}</div>
              {file.missing ? <div className="upd-diff-line removed">file is gone</div> : null}
              {file.diff?.kind === 'text' ? (
                <div className="upd-diff-line">
                  {file.diff.changed ? `changed (${file.diff.lineDelta >= 0 ? '+' : ''}${file.diff.lineDelta} lines)` : 'unchanged'}
                </div>
              ) : null}
              {file.diff?.kind === 'json' ? (
                <>
                  {file.diff.added.map((entry) => (
                    <div className="upd-diff-line added" key={`a-${entry.key}`}>{`+ ${entry.key}: ${entry.value}`}</div>
                  ))}
                  {file.diff.removed.map((entry) => (
                    <div className="upd-diff-line removed" key={`r-${entry.key}`}>{`- ${entry.key}: ${entry.value}`}</div>
                  ))}
                  {file.diff.changed.map((entry) => (
                    <div className="upd-diff-line changed" key={`c-${entry.key}`}>{`~ ${entry.key}: ${entry.from} → ${entry.to}`}</div>
                  ))}
                  {!file.diff.added.length && !file.diff.removed.length && !file.diff.changed.length ? (
                    <div className="upd-diff-line">unchanged</div>
                  ) : null}
                </>
              ) : null}
            </div>
          ))}
          {diff.restored ? (
            <div className={`upd-result${diff.restored.ok ? ' ok' : ' bad'}`}>
              {diff.restored.ok ? `Restored ${diff.restored.restored.length} file(s)` : 'Restore failed'}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="upd-note-error" role="alert">{error}</div> : null}
    </div>
  );
}

function UpdatesChip() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [state, setState] = useState(null);
  const [checking, setChecking] = useState(false);
  const chipRef = useRef(null);

  const refresh = async () => {
    try {
      setState(await window.harbor?.cliUpdates?.getState?.());
    } catch { /* the chip simply stays hidden */ }
  };

  useEffect(() => {
    refresh();
    const off = window.harbor?.cliUpdates?.onChanged?.((next) => setState(next));
    return () => { if (off) off(); };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const pending = pendingList(state);
  const reviewable = reviewList(state);
  // The chip shows for a pending update OR for a recent install still worth a
  // config review, so the compare and restore controls do not disappear the
  // instant an install succeeds (2026-09-03).
  const visible = pending.length > 0 || reviewable.length > 0;
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);

  const toggle = () => {
    if (!open && chipRef.current) {
      const rect = chipRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 452)),
      });
    }
    setOpen((o) => !o);
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      setState(await window.harbor.cliUpdates.check());
    } catch { /* the last-checked stamp simply does not move */ }
    setChecking(false);
  };

  if (!visible) return null;
  const rows = ['claude', 'codex', 'cursor']
    .map((id) => state?.providers?.[id])
    .filter(Boolean);
  // Amber and a count while an update is pending; a quiet "review" once nothing
  // is pending but a recent install can still be checked for config drift.
  const reviewOnly = pending.length === 0;
  const chipTitle = reviewOnly
    ? 'A CLI was updated recently: review what it changed or restore its config here'
    : 'A provider CLI has an update available (nothing installs until you click Install)';

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`updates-chip${open ? ' open' : ''}${reviewOnly ? ' review' : ''}`}
        onClick={toggle}
        title={chipTitle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="updates-dot" aria-hidden="true" />
        {reviewOnly ? (
          <span className="updates-count">review</span>
        ) : (
          <>
            <span className="updates-count">{pending.length}</span>
            {pending.length === 1 ? 'update' : 'updates'}
          </>
        )}
      </button>
      {open ? createPortal(
        <>
          <button type="button" tabIndex={-1} className="menu-backdrop" aria-label="Close CLI updates" onClick={() => setOpen(false)} />
          <div className="updates-menu" style={pos ? { top: pos.top, left: pos.left } : undefined} aria-label="CLI updates">
            <div className="updates-menu-head">
              <span className="updates-menu-title">CLI updates</span>
              <span className="updates-checked">{`checked ${relAgo(state?.checkedAt)}`}</span>
              <button type="button" className="upd-btn" disabled={checking} onClick={checkNow}>
                {checking ? 'Checking…' : 'Check now'}
              </button>
            </div>
            <div className="updates-note">
              Harbor never installs a CLI update on its own. Read what changes first.
            </div>
            {rows.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} onChanged={refresh} />
            ))}
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
      || event.target.closest('.workers-chip')
      || event.target.closest('.updates-chip')
      || event.target.closest('.mem-chip')) return;
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
        <MemoryChip />
        <UpdatesChip />
        <WorkersChip workers={workers} onOpenWorker={onOpenWorker} />
        <span className="live-pill" title={`${liveCount} live session${liveCount === 1 ? '' : 's'}`}>
          <span className={`pulse${liveCount ? '' : ' off'}`} aria-hidden="true" />
          {`${liveCount} live`}
        </span>
      </div>
      <div className="titlebar-controls" role="group" aria-label="Window controls">
        <PlanUsageButton />
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
