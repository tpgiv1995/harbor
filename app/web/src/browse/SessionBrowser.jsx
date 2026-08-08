import React, {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import { loadSettings } from '../rpc/client.js';
import { useOptionalRpc } from '../rpc/rpc-context.jsx';
import { SessionRow } from '../rail/SessionRow.jsx';
import { ProjectIcon } from '../rail/ProjectIcon.jsx';
import { useSidebar } from '../rail/useSidebar.js';
import { useProjectIcons } from '../rail/useProjectIcons.js';
import {
  BROWSER_FILTER_OPTIONS,
  buildBrowserRows,
  filterMatches,
  loadBrowserPrefs,
  loadCollapsedProjects,
  saveBrowserPrefs,
  saveCollapsedProjects,
  splitBrowserRows,
} from './rows.js';
import './browser.css';

function Chevron({ collapsed }) {
  return (
    <svg className="project-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={collapsed ? 'M6 4.5 10 8l-4 3.5' : 'M4.5 6 8 10l3.5-4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SessionBrowser({
  open,
  model: modelProp,
  rows: _rows,
  activeSessionId,
  onPick,
  onClose,
  onNewSession,
}) {
  // AppShell already owns a loaded sidebar model. This component used to open
  // a SECOND useSidebar subscription and fall back to the pre-built `rows`
  // prop whenever that second one was empty, which it is on the live app: the
  // prop is built by AppShell with no filter, grouping or collapse state, so
  // every control here computed its answer and then threw it away. Measured
  // against the live server: 31 rows before and after switching 48h -> All,
  // and 31 before and after collapsing a project. Prefer the model handed
  // down; keep the local subscription only as a fallback.
  const client = useOptionalRpc();
  const { model: ownModel } = useSidebar(client);
  const model = modelProp?.projects?.length ? modelProp : ownModel;
  const { serverUrl } = loadSettings();
  const { iconUrl } = useProjectIcons(client, serverUrl);

  const [query, setQuery] = useState('');
  const [prefs, setPrefs] = useState(loadBrowserPrefs);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects);
  const [expandedOlder, setExpandedOlder] = useState(() => new Set());

  useEffect(() => {
    if (!open) setControlsOpen(false);
  }, [open]);

  const updatePrefs = useCallback((partial) => {
    setPrefs((previous) => {
      const next = { ...previous, ...partial };
      saveBrowserPrefs(next);
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((label) => {
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  const displayRows = useMemo(
    () => {
      // Only fall back to the unfiltered prop when there is genuinely no model
      // at all, never when the user has actually chosen a filter or collapsed
      // something: falling back there is what made the controls inert.
      const source = (model?.projects?.length ? model : null);
      if (!source) return _rows?.length ? _rows : [];
      return buildBrowserRows(source, {
        iconUrl,
        filter: prefs.filter,
        grouping: prefs.grouping,
        query,
        collapsedProjects,
        expandedOlder,
      });
    },
    [model, _rows, iconUrl, prefs, query, collapsedProjects, expandedOlder],
  );

  const { pinned, list } = useMemo(
    () => splitBrowserRows(displayRows),
    [displayRows],
  );

  const hasSessions = displayRows.some((row) => row.kind === 'session');
  const showProject = prefs.grouping === 'date';
  const activeFilterLabel = BROWSER_FILTER_OPTIONS.find(
    (option) => filterMatches(option.filter, prefs.filter),
  )?.label || '48h';

  if (!open) return null;

  return (
    <div className="session-browser" role="dialog" aria-modal="true" aria-label="Sessions">
      <header className="session-browser-head">
        <button type="button" className="session-browser-close" onClick={onClose} aria-label="Back">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2 className="session-browser-title">Sessions</h2>
        {onNewSession ? (
          <button type="button" className="session-browser-add" onClick={onNewSession} aria-label="New session">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </header>

      <div className="session-browser-toolbar">
        <div className="session-browser-search">
          <svg className="sb-search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="m10.2 10.2 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
        </div>
        <button
          type="button"
          className={`browser-filter-toggle${controlsOpen ? ' open' : ''}`}
          aria-expanded={controlsOpen}
          aria-controls="browser-filter-panel"
          onClick={() => setControlsOpen((value) => !value)}
        >
          <span className="browser-filter-label">{activeFilterLabel}</span>
          <span className="browser-filter-sep">·</span>
          <span className="browser-filter-group">{prefs.grouping === 'date' ? 'Date' : 'Project'}</span>
        </button>
      </div>

      {controlsOpen ? (
        <div id="browser-filter-panel" className="browser-filter-panel" role="region" aria-label="Filter and group sessions">
          <div className="browser-filter-chips" role="group" aria-label="Time window">
            {BROWSER_FILTER_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`browser-filter-chip${filterMatches(option.filter, prefs.filter) ? ' active' : ''}`}
                data-filter={option.label.toLowerCase()}
                aria-pressed={filterMatches(option.filter, prefs.filter)}
                onClick={() => updatePrefs({ filter: option.filter })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="browser-grouping-toggle" role="group" aria-label="Group sessions by">
            {['project', 'date'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={prefs.grouping === mode ? 'active' : ''}
                data-grouping={mode}
                aria-pressed={prefs.grouping === mode}
                onClick={() => updatePrefs({ grouping: mode })}
              >
                {mode === 'project' ? 'Project' : 'Date'}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {pinned.length > 0 ? (
        <div className="session-browser-pinned" aria-label="Needs your answer">
          {pinned.map((row) => {
            if (row.kind === 'answer-section') {
              return (
                <div key={row.key} className="answer-section-header">
                  <span className="answer-section-label">Needs your answer</span>
                  <span className="answer-section-count">{row.count}</span>
                </div>
              );
            }
            return (
              <SessionRow
                key={row.key}
                row={row}
                selected={row.session.id === activeSessionId}
                iconUrl={row.iconUrl}
                showProject={showProject}
                onSelect={(session) => {
                  onPick(session);
                  onClose();
                }}
              />
            );
          })}
        </div>
      ) : null}

      <div className="session-browser-list">
        {!hasSessions ? (
          <div className="empty-state">
            <p>No sessions match.</p>
          </div>
        ) : null}
        {list.map((row) => {
          if (row.kind === 'project') {
            const count = row.project.sessionCount ?? row.project.sessions?.length ?? 0;
            return (
              <button
                key={row.key}
                type="button"
                className={`project-header${row.collapsed ? ' collapsed' : ''}`}
                aria-expanded={!row.collapsed}
                onClick={() => toggleCollapse(row.project.label)}
              >
                <Chevron collapsed={row.collapsed} />
                <ProjectIcon label={row.project.label} url={row.iconUrl} />
                <span className="project-label">{row.project.label}</span>
                <span className="project-count">{count}</span>
                {row.project.hasLive ? <span className="project-live">live</span> : null}
              </button>
            );
          }
          if (row.kind === 'older') {
            return (
              <button
                key={row.key}
                type="button"
                className="older-row"
                onClick={() => setExpandedOlder((prev) => new Set([...prev, row.project.label]))}
              >
                {row.hiddenCount} older sessions
              </button>
            );
          }
          return (
            <SessionRow
              key={row.key}
              row={row}
              selected={row.session.id === activeSessionId}
              iconUrl={row.iconUrl}
              showProject={showProject}
              onSelect={(session) => {
                onPick(session);
                onClose();
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
