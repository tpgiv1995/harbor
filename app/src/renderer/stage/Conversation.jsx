import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from './md.jsx';
import { providerIdentity, ProfileBadge } from '../providers.js';

// The designed conversation surface (Slate): user bubbles, assistant prose,
// tool-action rows, and the working shimmer. Pure presentation; blocks arrive
// parsed from the main-process transcript tailer.

const STICK_THRESHOLD_PX = 56;

function ImageLightbox({ src, alt, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="conv-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={onClose}
    >
      <img className="conv-lightbox-img" src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}

function ConvImages({ images, onImageLoad }) {
  const [lightbox, setLightbox] = useState(null);
  if (!images?.length) return null;
  return (
    <div className="conv-images">
      {images.map((img, i) => (
        <button
          key={i}
          type="button"
          className="conv-img-btn"
          onClick={() => setLightbox(img)}
          aria-label="View image full size"
        >
          <img
            className="conv-img"
            src={img.dataUri}
            alt=""
            loading="lazy"
            onLoad={onImageLoad}
          />
        </button>
      ))}
      {lightbox ? (
        <ImageLightbox
          src={lightbox.dataUri}
          alt={lightbox.mediaType || 'Image'}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

const ActionBlock = memo(function ActionBlock({ block }) {
  return (
    <div className={`conv-act status-${block.status}`}>
      <div className="conv-act-row">
        <span className={`conv-act-k ${block.status}`} aria-hidden="true" />
        <span className="conv-act-verb">{block.verb}</span>
        {block.chip ? (
          <span className="conv-act-chip" title={block.chipTitle || undefined}>{block.chip}</span>
        ) : null}
        {block.pill ? (
          <span className={`conv-act-pill tone-${block.pill.tone}`}>{block.pill.text}</span>
        ) : block.cv ? (
          <span className="conv-act-cv">{block.cv}</span>
        ) : null}
      </div>
      {block.diff ? (
        <div className="conv-act-code">
          {block.diff.map((line, i) => (
            <div key={i} className={`diff-${line.t}`} title={line.s}>{line.s}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function countVerb(blocks, verb) {
  return blocks.reduce((n, block) => n + (block.verb === verb ? 1 : 0), 0);
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

// Summarize a run of tool-action rows in ~10 words: verb buckets first, then
// optional file basenames when there is room.
function summarizeActions(blocks) {
  const ran = countVerb(blocks, 'Ran');
  const edited = countVerb(blocks, 'Edited') + countVerb(blocks, 'Wrote') + countVerb(blocks, 'NotebookEdit');
  const read = countVerb(blocks, 'Read');
  const searched = countVerb(blocks, 'Searched') + countVerb(blocks, 'Globbed') + countVerb(blocks, 'Searched web');
  const fetched = countVerb(blocks, 'Fetched');
  const delegated = countVerb(blocks, 'Delegated');
  const bucketed = ran + edited + read + searched + fetched + delegated;
  const other = blocks.length - bucketed;

  const parts = [];
  if (ran) parts.push(`Ran ${ran} command${ran === 1 ? '' : 's'}`);
  if (edited) parts.push(`edited ${edited} file${edited === 1 ? '' : 's'}`);
  if (read) parts.push(`read ${read} file${read === 1 ? '' : 's'}`);
  if (searched) parts.push(`ran ${searched} search${searched === 1 ? '' : 'es'}`);
  if (fetched) parts.push(`fetched ${fetched} page${fetched === 1 ? '' : 's'}`);
  if (delegated) parts.push(`delegated ${delegated} task${delegated === 1 ? '' : 's'}`);
  if (other) parts.push(`ran ${other} tool${other === 1 ? '' : 's'}`);

  if (!parts.length) return `${blocks.length} actions`;

  let summary = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const next = `${summary}, ${parts[i]}`;
    if (wordCount(next) > 10) break;
    summary = next;
  }

  if (wordCount(summary) <= 8) {
    const chips = [...new Set(blocks.map((b) => b.chip).filter(Boolean))];
    if (chips.length === 1 && chips[0]) {
      const withChip = `${summary}, ${chips[0]}`;
      if (wordCount(withChip) <= 10) summary = withChip;
    } else if (chips.length === 2) {
      const withChips = `${summary}, ${chips.join(', ')}`;
      if (wordCount(withChips) <= 10) summary = withChips;
    }
  }
  return summary;
}

function groupConversationBlocks(blocks) {
  const items = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind !== 'action') {
      items.push({ type: 'block', block });
      i += 1;
      continue;
    }
    const start = i;
    while (i < blocks.length && blocks[i].kind === 'action') i += 1;
    const actions = blocks.slice(start, i);
    if (actions.length === 1) {
      items.push({ type: 'block', block: actions[0] });
    } else {
      items.push({ type: 'action-group', groupKey: actions[0].key, blocks: actions });
    }
  }
  return items;
}

const ActionGroup = memo(function ActionGroup({ groupKey, blocks, expanded, onToggle }) {
  const running = blocks.some((block) => block.status === 'run');
  const summary = summarizeActions(blocks);
  return (
    <div
      className={`conv-act-group${expanded ? ' expanded' : ''}`}
      data-group-key={groupKey}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className="conv-act-group-toggle"
        aria-expanded={expanded}
        onClick={() => onToggle(groupKey)}
      >
        <span className={`conv-act-group-caret${running ? ' run' : ''}`} aria-hidden="true" />
        {/* The summary ellipsizes in a narrow window, and nothing else on
            screen carries the full string, so without a title it is simply
            unreadable (audit: unreachableText). */}
        <span className="conv-act-group-summary" title={summary}>{summary}</span>
        <span className="conv-act-group-count">{blocks.length}</span>
      </button>
      {expanded ? (
        <div className="conv-act-group-items">
          {blocks.map((block) => (
            <ActionBlock key={block.key} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

const Block = memo(function Block({ block, provider, home, profiles, onImageLoad }) {
  if (block.kind === 'note') {
    return <div className={`conv-note${block.tone === 'warn' ? ' warn' : ''}`}>{block.text}</div>;
  }
  if (block.kind === 'user') {
    return (
      <div className={`conv-user${block.command ? ' command' : ''}`}>
        {/* Composed formatting reads back formatted (2026-07-26). A command
            block stays verbatim: `/compact` is a literal string the CLI parses,
            and markdown-rendering it would only misrepresent what was sent. */}
        {block.text ? (
          block.command
            ? <span className="conv-user-text">{block.text}</span>
            : <span className="conv-user-text"><Markdown text={block.text} preserveBreaks /></span>
        ) : null}
        <ConvImages images={block.images} onImageLoad={onImageLoad} />
      </div>
    );
  }
  if (block.kind === 'assistant') {
    const identity = providerIdentity(provider);
    return (
      <div className="conv-assistant">
        <div className="conv-assistant-who">
          <img className="conv-sig" src={identity.logo} alt="" aria-hidden="true" />
          <span className="conv-provider" style={{ color: identity.color }}>{identity.label}</span>
          {provider === 'claude' && home ? (
            <ProfileBadge profileId={home} profiles={profiles} className="conv-acct" />
          ) : null}
        </div>
        {block.text ? <Markdown text={block.text} /> : null}
        <ConvImages images={block.images} onImageLoad={onImageLoad} />
      </div>
    );
  }
  if (block.kind === 'action') return <ActionBlock block={block} />;
  return null;
});

function distFromBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

export const Conversation = memo(function Conversation({
  blocks, header, provider = 'claude', home = null, profiles = [], empty, emptyAction = null,
}) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const stickRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  const toggleGroup = useCallback((groupKey) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const items = useMemo(() => groupConversationBlocks(blocks), [blocks]);

  const scrollToTail = useCallback(() => {
    const node = scrollRef.current;
    if (!node || !stickRef.current) return;
    programmaticScrollRef.current = true;
    stickRef.current = true;
    node.scrollTop = node.scrollHeight;
    // Content can grow in the same frame (markdown wrap, working shimmer); a
    // second pass after layout settles keeps the tail pinned.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
      programmaticScrollRef.current = false;
    });
  }, []);

  // Track whether the reader is pinned to the tail; new content only
  // auto-scrolls when they are (scrolling up to read history must hold).
  const onScroll = () => {
    if (programmaticScrollRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    stickRef.current = distFromBottom(node) < STICK_THRESHOLD_PX;
  };

  useLayoutEffect(() => {
    scrollToTail();
  }, [blocks, header?.working, scrollToTail]);

  useEffect(() => {
    scrollToTail();
  }, [scrollToTail]);

  // Streamed blocks can grow the scroll height without a new blocks reference
  // (same key, longer text). ResizeObserver on the content column re-pins.
  useEffect(() => {
    const node = contentRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollToTail();
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [scrollToTail]);

  return (
    <div className="conv" ref={scrollRef} onScroll={onScroll}>
      <div className="conv-body" ref={contentRef}>
        {blocks.length === 0 ? (
          <div className="conv-empty">
            <span>{empty || 'No conversation yet.'}</span>
            {emptyAction}
          </div>
        ) : (
          items.map((item) => {
            if (item.type === 'action-group') {
              return (
                <ActionGroup
                  key={item.groupKey}
                  groupKey={item.groupKey}
                  blocks={item.blocks}
                  expanded={expandedGroups.has(item.groupKey)}
                  onToggle={toggleGroup}
                />
              );
            }
            return (
              <Block
                key={item.block.key}
                block={item.block}
                provider={provider}
                home={home}
                profiles={profiles}
                onImageLoad={scrollToTail}
              />
            );
          })
        )}
        {header?.working ? (
          <div className="conv-working">
            <span className="conv-spinner" aria-hidden="true" />
            <span className="conv-working-text">{header.workingText || header.text || 'Working…'}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});
