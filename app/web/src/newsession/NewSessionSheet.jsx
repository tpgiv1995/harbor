import React, {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import { CONNECTION } from '../rpc/client.js';
import { sessionEffortOptions } from '../../../src/renderer/session-model-options.cjs';
import './newsession.css';
import { providerPlans, selectedPlan } from '../../../src/shared/plan-options.cjs';
import { folderLabel, groupFolderCandidates } from '../../../src/shared/project-root.cjs';
import { isOrchestrationCwd } from '../../../src/shared/sidebar-model.js';
import { PlanChoices } from '../capability/PlanChoices.jsx';

const PROVIDER_LABEL = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

function Chevron({ open }) {
  return (
    <svg className="newsession-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={open ? 'M4.5 6 8 10l3.5-4' : 'M6 4.5 10 8l-4 3.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The group holding `folder` as a sub-folder, so the sheet can open on it.
function groupKeyHolding(folders, folder) {
  return groupFolderCandidates(folders, { isOrchestration: isOrchestrationCwd })
    .find((group) => group.children.some((child) => child.folder === folder))?.key || null;
}

// WAIT ON THE PUSH, NEVER ON A REFETCH LOOP.
//
// This used to call `sidebar:get-state` every 400ms for twelve seconds. That
// sidebar model is ~680KB on Pat's machine (891 sessions across 77 projects),
// and an RPC RESPONSE is never coalesced the way a push is, so pressing Start
// on a phone could mean up to thirty uncoalesced ~680KB round trips: the exact
// shape that overflowed the connection queue on 2026-08-07 and again on
// 2026-08-08, still alive in this one path. The server already emits
// `sidebar:update` whenever a session appears, carrying the same model, so the
// answer arrives for free.
//
// Only reached for codex and cursor. A claude session's id is MINTED by Harbor
// before the CLI is launched (`claude --session-id <uuid>`) and `new-session`
// returns it, so for claude there is nothing to wait for and nothing to guess.
function waitForSessionInFolder(client, folder, { timeoutMs = 12000, sinceMs } = {}) {
  const pickFrom = (model) => {
    const sessions = (model?.projects || []).flatMap((project) => project.sessions || []);
    const match = sessions
      .filter((session) => session.cwd === folder)
      .sort((left, right) => (right.lastActiveMs || 0) - (left.lastActiveMs || 0))[0];
    if (!match?.id) return null;
    if (sinceMs != null && (match.lastActiveMs || 0) < sinceMs - 2000) return null;
    return match.id;
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const unsubscribe = client.onChannel('sidebar:update', (payload) => {
      const id = pickFrom(payload?.model);
      if (id) finish(id);
    });
    // One read for the case where the session was already listed before the
    // subscription existed. One, not thirty.
    client.call('sidebar:get-state')
      .then((state) => { const id = pickFrom(state?.model); if (id) finish(id); })
      .catch(() => {});
  });
}

export function NewSessionSheet({
  open,
  onClose,
  onCreated,
  client,
}) {
  const [options, setOptions] = useState(null);
  const [folders, setFolders] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [folder, setFolder] = useState('');
  const [folderQuery, setFolderQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [account, setAccount] = useState('');
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState('opus');
  const [effort, setEffort] = useState('xhigh');
  const [starting, setStarting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const connected = client?.getState() === CONNECTION.connected;
  const providerKeys = useMemo(
    () => Object.keys(options?.providers || {}),
    [options],
  );
  const providerOptions = options?.providers?.[provider];
  const modelOptions = providerOptions?.models || [];
  const { levels: effortLevels, effort: selectedEffort } = sessionEffortOptions({ providerOptions, model, effort });
  const profileOptions = providerPlans(options, provider);
  const plan = selectedPlan(options, provider, account);
  const folderGroups = useMemo(
    () => groupFolderCandidates(folders, { query: folderQuery, isOrchestration: isOrchestrationCwd }),
    [folders, folderQuery],
  );
  const toggleGroup = (key) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  useEffect(() => {
    if (!open || !client || !connected) return undefined;
    let cancelled = false;
    setLoadError(null);
    setSubmitError(null);
    Promise.all([
      client.call('new-session:options'),
      client.call('new-session:folder'),
    ])
      .then(([nextOptions, nextFolders]) => {
        if (cancelled) return;
        setOptions(nextOptions);
        const candidates = Array.isArray(nextFolders) ? nextFolders : [];
        setFolders(candidates);
        const defaults = nextOptions?.defaults || {};
        const defaultProvider = defaults.provider || 'claude';
        const defaultModel = defaults.model || 'opus';
        const defaultEffort = defaults.effort || 'xhigh';
        const defaultProfile = selectedPlan(nextOptions, defaultProvider)?.id || '';
        setProvider(defaultProvider);
        setModel(defaultModel);
        setEffort(defaultEffort);
        setAccount(defaultProfile);
        setFolder(candidates[0] || '');
        setFolderQuery('');
        const holding = candidates[0] ? groupKeyHolding(candidates, candidates[0]) : null;
        setExpanded(new Set(holding ? [holding] : []));
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error.message || error));
      });
    return () => { cancelled = true; };
  }, [open, client, connected]);

  useEffect(() => {
    if (!open || !client || !connected) return undefined;
    let active = true;
    const off = client.onChannel('provider-models:changed', () => {
      client.call('new-session:options').then((value) => { if (active) setOptions(value); }).catch(() => {});
    });
    return () => { active = false; off(); };
  }, [open, client, connected]);

  useEffect(() => {
    if (!open || !providerOptions) return;
    if (!providerOptions.models?.some((row) => row.value === model)) {
      setModel(providerOptions.defaultModel || providerOptions.models?.[0]?.value || 'default');
    }
    if (selectedEffort !== effort) setEffort(selectedEffort);
  }, [open, provider, providerOptions, model, effort]);

  const onBackdrop = useCallback((event) => {
    if (event.target === event.currentTarget && !starting) onClose();
  }, [onClose, starting]);

  const submit = async (event) => {
    event.preventDefault();
    if (!client || !connected || !folder || !providerOptions || starting) return;
    setStarting(true);
    setSubmitError(null);
    const sinceMs = Date.now();
    try {
      const launched = await client.call('new-session', {
        account: plan?.id || '',
        folder,
        provider,
        model,
        effort: selectedEffort,
      });
      // HARBOR MINTS A CLAUDE SESSION'S ID, so the launch already answered the
      // question this used to spend twelve seconds guessing at. Guessing was
      // also WRONG: it matched on folder plus recency, so starting a second
      // session in a folder that already had a live one could hand back the
      // existing session and open that instead.
      const sessionId = launched?.sessionId
        || await waitForSessionInFolder(client, folder, { sinceMs });
      onCreated?.({ sessionId, folder, provider, model, effort: selectedEffort });
      onClose();
    } catch (error) {
      setSubmitError(String(error.message || error));
    } finally {
      setStarting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="newsession-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      onMouseDown={onBackdrop}
    >
      <form className="newsession-panel" onSubmit={submit}>
        <header className="newsession-head">
          <h2 className="newsession-title">New session</h2>
          <button
            type="button"
            className="newsession-close"
            onClick={onClose}
            disabled={starting}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {loadError ? <div className="newsession-error" role="alert">{loadError}</div> : null}
        {submitError ? <div className="newsession-error" role="alert">{submitError}</div> : null}

        <div className="newsession-body">
          <fieldset className="newsession-field">
            <legend>Provider</legend>
            <div className="newsession-providers">
              {providerKeys.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`newsession-provider${provider === key ? ' on' : ''}`}
                  onClick={() => { setProvider(key); setAccount(selectedPlan(options, key)?.id || ''); }}
                >
                  {PROVIDER_LABEL[key] || key}
                </button>
              ))}
            </div>
          </fieldset>

          {provider !== 'cursor' && profileOptions.length > 0 ? <fieldset className="newsession-field"><legend>Plan</legend><PlanChoices plans={profileOptions} value={plan?.id} onChange={setAccount} disabled={starting} /></fieldset> : null}

          <fieldset className="newsession-field">
            <legend>Model</legend>
            <select
              className="newsession-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              aria-label="Model"
            >
              {modelOptions.map((row) => (
                <option key={row.value} value={row.value}>{row.label || row.value}</option>
              ))}
            </select>
          </fieldset>

          {effortLevels.length ? (
            <fieldset className="newsession-field">
              <legend>Effort</legend>
              <div className="newsession-efforts">
                {effortLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`newsession-effort${selectedEffort === level ? ' on' : ''}`}
                    onClick={() => setEffort(level)}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="newsession-field">
            <legend>Project folder</legend>
            {folders.length ? (
              <>
                <div className="newsession-search">
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                    <path d="m10.2 10.2 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  <input
                    type="search"
                    placeholder="Search projects"
                    value={folderQuery}
                    onChange={(event) => setFolderQuery(event.target.value)}
                    aria-label="Search project folders"
                    enterKeyHint="search"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  {folderQuery ? (
                    <button type="button" className="newsession-search-clear" onClick={() => setFolderQuery('')} aria-label="Clear search">
                      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      </svg>
                    </button>
                  ) : null}
                </div>
                <div className="newsession-folder-list" role="group" aria-label="Project folders">
                  {folderGroups.length ? folderGroups.map((group) => {
                    const open = group.open || expanded.has(group.key);
                    const count = group.open ? group.children.length : group.total;
                    const holdsSelection = !open && group.children.some((child) => child.folder === folder);
                    return (
                      <div key={group.key} className="newsession-group">
                        <div className="newsession-group-row">
                          {group.folder ? (
                            <button
                              type="button"
                              aria-pressed={group.folder === folder}
                              className={`newsession-folder${group.folder === folder ? ' on' : ''}`}
                              onClick={() => setFolder(group.folder)}
                            >
                              <span className="newsession-folder-label">{group.label}</span>
                              <span className="newsession-folder-path">{group.folder}</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-expanded={open}
                              className={`newsession-folder newsession-folder-heading${holdsSelection ? ' holds' : ''}`}
                              onClick={() => toggleGroup(group.key)}
                            >
                              <span className="newsession-folder-label">{group.label}</span>
                              <span className="newsession-folder-path">{count} {count === 1 ? 'folder' : 'folders'}</span>
                              <Chevron open={open} />
                            </button>
                          )}
                          {group.folder && group.children.length ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${open ? 'Hide' : 'Show'} ${count} ${count === 1 ? 'subfolder' : 'subfolders'} of ${group.label}`}
                              className={`newsession-group-toggle${holdsSelection ? ' holds' : ''}`}
                              onClick={() => toggleGroup(group.key)}
                            >
                              <span>{count}</span>
                              <Chevron open={open} />
                            </button>
                          ) : null}
                        </div>
                        {open && group.children.length ? (
                          <div className="newsession-subfolders">
                            {group.children.map((child) => (
                              <button
                                key={child.folder}
                                type="button"
                                aria-pressed={child.folder === folder}
                                className={`newsession-folder sub${child.folder === folder ? ' on' : ''}`}
                                onClick={() => setFolder(child.folder)}
                              >
                                <span className="newsession-folder-label">{child.label}</span>
                                <span className="newsession-folder-path">{child.folder}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : (
                    <p className="newsession-empty">No project folders match.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="newsession-empty">No candidate folders from the server.</p>
            )}
          </fieldset>

        </div>

        <footer className="newsession-foot">
          <p className="newsession-summary">{PROVIDER_LABEL[provider] || provider}{plan && provider !== 'cursor' ? ` · ${plan.label || plan.id}` : ''} · {modelOptions.find(row => row.value === model)?.label || model}{folder ? ` · ${folderLabel(folder)}` : ''}</p>
          <button
            type="submit"
            className="btn-primary newsession-start"
            disabled={!folder || !providerOptions || starting || !connected}
          >
            {starting ? 'Starting…' : 'Start session'}
          </button>
        </footer>
      </form>
    </div>
  );
}
