import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProjectIcon } from '../stage/ProjectIcon.jsx';

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

export function artifactUrl(filePath) {
  return `harbor-artifact://local${String(filePath).split('/').map(encodeURIComponent).join('/')}`;
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

  const groups = useMemo(() => {
    const filtered = filter === 'all' ? artifacts : artifacts.filter((a) => a.kind === filter);
    const byKey = new Map();
    for (const artifact of filtered) {
      const session = sessionsById?.get?.(artifact.sessionId) || null;
      const label = session?.project
        || (artifact.cwd ? artifact.cwd.split('/').filter(Boolean).pop() : null)
        || 'unknown project';
      const key = artifact.cwd || label;
      if (!byKey.has(key)) byKey.set(key, { key, label, cwd: artifact.cwd, artifacts: [] });
      byKey.get(key).artifacts.push({ artifact, sessionTitle: session?.title || null });
    }
    return [...byKey.values()].sort(
      (a, b) => (b.artifacts[0]?.artifact.mtimeMs || 0) - (a.artifacts[0]?.artifact.mtimeMs || 0),
    );
  }, [artifacts, filter, sessionsById]);

  const openMeta = open
    ? groups.flatMap((g) => g.artifacts).find((entry) => entry.artifact.path === open)
    || { artifact: artifacts.find((a) => a.path === open), sessionTitle: null }
    : null;
  const openProjectLabel = openMeta?.artifact
    ? (sessionsById?.get?.(openMeta.artifact.sessionId)?.project
      || (openMeta.artifact.cwd ? openMeta.artifact.cwd.split('/').filter(Boolean).pop() : 'unknown project'))
    : null;

  return (
    <div className="artifacts-view" aria-label="Artifacts">
      <div className="artifacts-head">
        <div className="artifacts-title-block">
          <h2 className="artifacts-title">Artifacts</h2>
          <span className="artifacts-subtitle">
            Files your agents produced, grouped by project
            {data ? ` · ${artifacts.length} in the last 14 days` : ''}
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
      {error ? <div className="artifacts-error" role="alert">{error}</div> : null}
      {!data && !error ? (
        <div className="artifacts-empty">
          <p className="artifacts-empty-title">Scanning transcripts…</p>
          <p className="artifacts-empty-hint">The first scan reads recent session history; later opens are instant.</p>
        </div>
      ) : null}
      {data && groups.length === 0 ? (
        <div className="artifacts-empty">
          <p className="artifacts-empty-title">No artifacts found</p>
          <p className="artifacts-empty-hint">
            HTML, images, PDFs and videos your sessions wrote in the last 14 days appear here automatically.
          </p>
        </div>
      ) : null}
      <div className="artifacts-groups">
        {groups.map((group) => {
          const isExpanded = expanded.has(group.key);
          const visible = isExpanded ? group.artifacts : group.artifacts.slice(0, PREVIEW_CAP);
          const hidden = group.artifacts.length - visible.length;
          return (
            <section className="artifacts-group" key={group.key}>
              <div className="artifacts-group-head" title={group.cwd || group.label}>
                <ProjectIcon label={group.label} iconClass="pj-icon" dotClass="pjdot" />
                <span className="artifacts-group-label">{group.label}</span>
                <span className="artifacts-group-count">{group.artifacts.length}</span>
              </div>
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
