import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProjectIcon } from '../stage/ProjectIcon.jsx';
import { artifactUrl } from '../../shared/artifact-url.js';
import { isOrchestrationCwd, ORCHESTRATION_PROJECT } from '../../shared/sidebar-model.js';
import { planArtifactsView, normalizeGroupBy, normalizeSortBy } from './artifacts-view-model.cjs';

// The Artifacts view: what agents produced for a human to LOOK at (HTML
// reports, images, PDFs, renders), browsable in the main pane and grouped by
// project exactly like the rail groups sessions. Discovery is main-side
// (providers/artifacts.js, transcript-driven); this view only renders the
// index. HTML renders live in a sandboxed iframe through the allowlisted
// harbor-artifact:// scheme; nothing here can navigate the app shell.

const KIND_FILTERS = [
  ['all', 'All'],
  ['html', 'HTML'],
  ['image', 'Images'],
  ['pdf', 'PDF'],
  ['video', 'Video'],
];

const KIND_GLYPH = { html: '⌗', pdf: '⎘', video: '▶', image: '▧' };
const PREVIEW_CAP = 8;
// Group/sort choices persist (search deliberately does not: a stale search on
// reopen reads as missing files). Decisions live in artifacts-view-model.cjs.
const VIEW_OPTS_KEY = 'harbor-artifacts-view';
const GROUP_OPTIONS = [['project', 'Project'], ['day', 'Day'], ['none', 'None']];
const SORT_OPTIONS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['largest', 'Largest'], ['name', 'Name']];

function loadViewOpts() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_OPTS_KEY) || '{}');
    return { groupBy: normalizeGroupBy(raw.groupBy), sortBy: normalizeSortBy(raw.sortBy) };
  } catch {
    return { groupBy: 'project', sortBy: 'newest' };
  }
}

// Re-exported because this view is where the URL rule used to live; the rule
// itself is shared with the main process now (src/shared/artifact-url), so the
// handler that serves the bytes cannot disagree with the tag that requests them.
export { artifactUrl };

// A project folder's leaf name, whichever separator the OS that recorded the
// cwd uses. Splitting on '/' alone left a whole Windows cwd as the label.
function folderLeaf(cwd) {
  return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || null;
}

function relativeTime(ms, now = Date.now()) {
  const delta = Math.max(0, now - ms);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function ArtifactCard({ artifact, sessionTitle, thumbPath, onOpen }) {
  // Every card gets a real preview: images render themselves, everything else
  // shows its generated thumbnail the moment the main side has one; the glyph
  // is only the placeholder while (or if) no preview exists.
  const previewSrc = artifact.kind === 'image'
    ? artifactUrl(artifact.path)
    : thumbPath ? artifactUrl(thumbPath) : null;
  return (
    <button
      type="button"
      className={`artifact-card kind-${artifact.kind}`}
      onClick={() => onOpen(artifact)}
      title={`${artifact.path}${sessionTitle ? `\nSession: ${sessionTitle}` : ''}`}
    >
      <span className="artifact-thumb" aria-hidden="true">
        {previewSrc ? (
          <img src={previewSrc} alt="" loading="lazy" />
        ) : (
          <span className="artifact-glyph">{KIND_GLYPH[artifact.kind] || '▧'}</span>
        )}
      </span>
      <span className="artifact-name">{artifact.name}</span>
      <span className="artifact-meta">
        {relativeTime(artifact.mtimeMs)}
        {' · '}
        {formatBytes(artifact.bytes)}
      </span>
    </button>
  );
}

function ArtifactViewer({ artifact, sessionTitle, projectLabel, onClose }) {
  const [actionNote, setActionNote] = useState(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const act = async (fn) => {
    setActionNote(null);
    const result = await fn().catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    if (!result?.ok) setActionNote(result?.reason || 'action failed');
  };

  return createPortal(
    <div className="artifact-viewer" role="dialog" aria-label={`Artifact ${artifact.name}`}>
      <button type="button" tabIndex={-1} className="artifact-viewer-backdrop" aria-label="Close artifact" onClick={onClose} />
      <div className="artifact-viewer-panel">
        <div className="artifact-viewer-head">
          <span className="artifact-viewer-name" title={artifact.path}>{artifact.name}</span>
          <span className="artifact-viewer-sub">
            {projectLabel}
            {sessionTitle ? ` · ${sessionTitle}` : ''}
            {` · ${relativeTime(artifact.mtimeMs)}`}
          </span>
          <span className="artifact-viewer-actions">
            <button type="button" onClick={() => act(() => window.harbor.artifacts.openExternal({ path: artifact.path }))}>
              Open externally
            </button>
            <button type="button" onClick={() => act(() => window.harbor.artifacts.showInFolder({ path: artifact.path }))}>
              Show in folder
            </button>
            <button type="button" className="artifact-viewer-close" aria-label="Close" onClick={onClose}>×</button>
          </span>
        </div>
        {actionNote ? <div className="artifact-viewer-note" role="alert">{actionNote}</div> : null}
        <div className="artifact-viewer-body">
          {artifact.kind === 'html' ? (
            // allow-scripts only: no same-origin, no popups, no top navigation.
            // The main process additionally refuses http(s)/file subframe
            // documents, will-navigate, and window.open, so this frame can
            // never take the app anywhere.
            <iframe
              className="artifact-frame"
              sandbox="allow-scripts"
              src={artifactUrl(artifact.path)}
              title={artifact.name}
            />
          ) : artifact.kind === 'image' ? (
            <img className="artifact-full" src={artifactUrl(artifact.path)} alt={artifact.name} />
          ) : artifact.kind === 'pdf' ? (
            // Chromium's built-in PDF viewer renders the PDF INSIDE Harbor.
            // This frame is deliberately unsandboxed (a sandboxed frame gets
            // no plugins, so the PDF would download instead of render); it can
            // still go nowhere: the scheme allowlist bounds what loads here,
            // main cancels http(s)/file subframe documents, will-navigate
            // refuses top navigation, and window.open is denied.
            <iframe
              className="artifact-frame pdf"
              src={artifactUrl(artifact.path)}
              title={artifact.name}
            />
          ) : (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              className="artifact-full"
              controls
              preload="metadata"
              src={artifactUrl(artifact.path)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ArtifactsView({ sessionsById }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [{ groupBy, sortBy }, setViewOpts] = useState(loadViewOpts);
  useEffect(() => {
    try { localStorage.setItem(VIEW_OPTS_KEY, JSON.stringify({ groupBy, sortBy })); } catch { /* quota */ }
  }, [groupBy, sortBy]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [open, setOpen] = useState(null);
  const [thumbs, setThumbs] = useState(() => new Map());
  const requestedThumbsRef = useRef(new Set());

  useEffect(() => {
    let live = true;
    const pull = () => {
      window.harbor.artifacts.list()
        .then((result) => {
          if (!live) return;
          if (result?.ok) { setData(result); setError(null); } else setError('artifact scan failed');
        })
        .catch((e) => { if (live) setError(String(e?.message || e)); });
    };
    pull();
    const timer = setInterval(pull, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const artifacts = data?.artifacts || [];

  // Ask main for a preview once per file version; results land as they
  // generate (the main side serializes and disk-caches them).
  useEffect(() => {
    for (const artifact of artifacts) {
      if (artifact.kind === 'image') continue;
      const key = `${artifact.path}:${artifact.mtimeMs}`;
      if (requestedThumbsRef.current.has(key)) continue;
      requestedThumbsRef.current.add(key);
      window.harbor.artifacts.thumb({ path: artifact.path, mtimeMs: artifact.mtimeMs, kind: artifact.kind })
        .then((result) => {
          if (result?.ok && result.thumbPath) {
            setThumbs((prev) => new Map(prev).set(key, result.thumbPath));
          }
        })
        .catch(() => {});
    }
  }, [artifacts]);

  const counts = useMemo(() => {
    const c = { all: artifacts.length };
    for (const a of artifacts) c[a.kind] = (c[a.kind] || 0) + 1;
    return c;
  }, [artifacts]);

  const plan = useMemo(() => {
    const entries = artifacts.map((artifact) => {
      const session = sessionsById?.get?.(artifact.sessionId) || null;
      // Orchestration debris folds into one group here for the same reason it
      // does on the rail: this view groups by project "exactly like the rail
      // groups sessions", so it shares the rail's rule.
      const orch = isOrchestrationCwd({ cwd: artifact.cwd, label: session?.project });
      return {
        artifact,
        sessionTitle: session?.title || null,
        projectLabel: orch ? ORCHESTRATION_PROJECT : (session?.project || folderLeaf(artifact.cwd) || 'unknown project'),
        projectKey: orch ? ORCHESTRATION_PROJECT : (artifact.cwd || session?.project || 'unknown project'),
        cwd: artifact.cwd,
      };
    });
    return planArtifactsView({ entries, kind: filter, search, groupBy, sortBy, nowMs: Date.now() });
  }, [artifacts, filter, search, groupBy, sortBy, sessionsById]);
  const groups = plan.groups;

  const openMeta = open
    ? groups.flatMap((g) => g.items).find((entry) => entry.artifact.path === open)
    || { artifact: artifacts.find((a) => a.path === open), sessionTitle: null }
    : null;
  const openProjectLabel = openMeta?.artifact
    ? (sessionsById?.get?.(openMeta.artifact.sessionId)?.project
      || folderLeaf(openMeta.artifact.cwd)
      || 'unknown project')
    : null;

  return (
    <div className="artifacts-view" aria-label="Files">
      <div className="artifacts-head">
        <div className="artifacts-title-block">
          {/* The tab has said "Files" since 2026-08-25; the page header now
              agrees (Pat, 2026-08-30: "we call it files in the toggle menu
              but in the page itself we call it artifacts"). Internal names
              (classes, IPC, providers/artifacts.js) deliberately keep the
              artifacts spelling: renaming channels would touch the auth
              classification for a cosmetic change. */}
          <h2 className="artifacts-title">Files</h2>
          <span className="artifacts-subtitle">
            Files your agents produced
            {data ? ` · ${artifacts.length} in the last 14 days` : ''}
            {search.trim() ? ` · ${plan.matched} matching` : ''}
          </span>
        </div>
        <div className="artifacts-filters" role="group" aria-label="Filter by type">
          {KIND_FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`artifacts-filter${filter === key ? ' active' : ''}`}
              onClick={() => setFilter(key)}
              disabled={key !== 'all' && !counts[key]}
            >
              {label}
              {counts[key] ? <span className="artifacts-filter-count">{counts[key]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="artifacts-toolbar">
        <input
          className="artifacts-search"
          type="search"
          placeholder="Search files, projects, sessions…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search artifacts"
        />
        <div className="artifacts-opts" role="group" aria-label="Group by">
          <span className="artifacts-opt-label">Group</span>
          {GROUP_OPTIONS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`artifacts-filter${groupBy === key ? ' active' : ''}`}
              onClick={() => setViewOpts((prev) => ({ ...prev, groupBy: key }))}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="artifacts-opts" role="group" aria-label="Sort by">
          <span className="artifacts-opt-label">Sort</span>
          {SORT_OPTIONS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`artifacts-filter${sortBy === key ? ' active' : ''}`}
              onClick={() => setViewOpts((prev) => ({ ...prev, sortBy: key }))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error ? <div className="artifacts-error" role="alert">{error}</div> : null}
      {!data && !error ? (
        <div className="artifacts-empty">
          <p className="artifacts-empty-title">Scanning transcripts…</p>
          <p className="artifacts-empty-hint">The first scan reads recent session history; later opens are instant.</p>
        </div>
      ) : null}
      {data && groups.length === 0 ? (
        <div className="artifacts-empty">
          <p className="artifacts-empty-title">
            {search.trim() || filter !== 'all' ? 'No files match' : 'No files found'}
          </p>
          <p className="artifacts-empty-hint">
            {search.trim() || filter !== 'all'
              ? 'Try a different search or filter.'
              : 'HTML, images, PDFs and videos your sessions wrote in the last 14 days appear here automatically.'}
          </p>
        </div>
      ) : null}
      <div className="artifacts-groups">
        {groups.map((group) => {
          const isExpanded = expanded.has(group.key);
          const visible = isExpanded ? group.items : group.items.slice(0, PREVIEW_CAP);
          const hidden = group.items.length - visible.length;
          return (
            <section className="artifacts-group" key={group.key}>
              {group.label ? (
                <div className="artifacts-group-head" title={group.cwd || group.label}>
                  {group.mode === 'project'
                    ? <ProjectIcon label={group.label} iconClass="pj-icon" dotClass="pjdot" />
                    : null}
                  <span className="artifacts-group-label">{group.label}</span>
                  <span className="artifacts-group-count">{group.items.length}</span>
                </div>
              ) : null}
              <div className="artifacts-grid">
                {visible.map(({ artifact, sessionTitle }) => (
                  <ArtifactCard
                    key={artifact.path}
                    artifact={artifact}
                    sessionTitle={sessionTitle}
                    thumbPath={thumbs.get(`${artifact.path}:${artifact.mtimeMs}`) || null}
                    onOpen={(a) => setOpen(a.path)}
                  />
                ))}
              </div>
              {hidden > 0 ? (
                <button
                  type="button"
                  className="artifacts-more"
                  onClick={() => setExpanded((prev) => new Set(prev).add(group.key))}
                >
                  Show {hidden} more
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
      {openMeta?.artifact ? (
        <ArtifactViewer
          artifact={openMeta.artifact}
          sessionTitle={openMeta.sessionTitle}
          projectLabel={openProjectLabel}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
