import React, {
  useCallback, useMemo, useState,
} from 'react';
import { ProjectIcon } from './ProjectIcon.jsx';
import { SessionRow } from './SessionRow.jsx';
import {
  BROWSER_FILTER_OPTIONS,
  buildBrowserRows,
  filterMatches,
  loadBrowserPrefs,
  loadCollapsedProjects,
  saveBrowserPrefs,
  saveCollapsedProjects,
  splitBrowserRows,
} from '../browse/rows.js';

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

export function SessionSheet({
  open,
  model,
  selectedId,
  onSelect,
  onClose,
  iconUrl,
}) {
  const [query, setQuery] = useState('');
  const [prefs, setPrefs] = useState(loadBrowserPrefs);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects);
  const [expandedOlder, setExpandedOlder] = useState(() => new Set());

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
    () => buildBrowserRows(model, {
      iconUrl,
      filter: prefs.filter,
      grouping: prefs.grouping,
      query,
      collapsedProjects,
      expandedOlder,
    }),
    [model, iconUrl, prefs, query, collapsedProjects, expandedOlder],
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
    <div className="sheet-root" role="presentation">
      <button type="button" className="sheet-scrim" aria-label="Close session list" onClick={onClose} />
      <div className="sheet-panel" role="dialog" aria-label="Sessions">
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <h2 className="sheet-title">Sessions</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="session-browser-toolbar">
          <div className="sheet-search">
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
            onClick={() => setControlsOpen((value) => !value)}
          >
            <span className="browser-filter-label">{activeFilterLabel}</span>
            <span className="browser-filter-sep">·</span>
            <span className="browser-filter-group">{prefs.grouping === 'date' ? 'Date' : 'Project'}</span>
          </button>
        </div>
        {controlsOpen ? (
          <div className="browser-filter-panel" role="region" aria-label="Filter and group sessions">
            <div className="browser-filter-chips" role="group" aria-label="Time window">
              {BROWSER_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={`browser-filter-chip${filterMatches(option.filter, prefs.filter) ? ' active' : ''}`}
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
                  selected={row.session.id === selectedId}
                  iconUrl={row.iconUrl}
                  showProject={showProject}
                  onSelect={(session) => {
                    onSelect(session);
                    onClose();
                  }}
                />
              );
            })}
          </div>
        ) : null}
        <div className="sheet-list">
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
                  <ProjectIcon label={row.project.label} url={iconUrl(row.project.label)} />
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
                selected={row.session.id === selectedId}
                iconUrl={iconUrl(row.project?.label || row.session.project)}
                showProject={showProject}
                onSelect={(session) => {
                  onSelect(session);
                  onClose();
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
