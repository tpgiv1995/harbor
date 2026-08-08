import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from 'react';
import composeDoc from './compose-doc.cjs';
import slashTokens from './slash-tokens.cjs';

const { serializeDoc, markdownToSpec, buildNodes } = composeDoc;
const { parseSlashTokens, classifySlashTokens } = slashTokens;

// The WYSIWYG composer. Real bold and real bullets on screen; markdown on the
// wire, because the destination is an agent's terminal and markdown is the only
// formatting that survives that trip.
//
// The contenteditable is UNCONTROLLED on purpose. Re-rendering it from React
// state on every keystroke would rebuild the DOM under the caret and destroy
// the selection, so the DOM is authoritative while typing and serializes OUT to
// the draft. The editor is rebuilt only when the draft changes from somewhere
// else (a session switch, voice transcription, a slash insert, a dropped file),
// which is detected by comparing against the last value this editor emitted.
//
// Two mechanisms the old textarea needed are deliberately gone rather than
// ported: the JS auto-grow (a contenteditable sizes itself) and the mirror
// layer that had to metric-match the textarea exactly. Slash colouring now uses
// the CSS Custom Highlight API, which paints ranges WITHOUT touching the DOM,
// so there is no caret to save and restore.

const HIGHLIGHT_OK = 'harbor-slash-ok';
const HIGHLIGHT_BAD = 'harbor-slash-bad';

// execCommand is deprecated but implemented, and Electron pins exactly one
// Chromium, so there is no cross-engine exposure. It is worth using because it
// brings list continuation, backspacing out of a bullet, and caret placement
// for free; hand-rolling those is where contenteditable editors go wrong.
const exec = (command, value = null) => {
  try { return document.execCommand(command, false, value); } catch { return false; }
};

function closestTag(node, tags, root) {
  let current = node;
  while (current && current !== root) {
    if (current.nodeType === 1 && tags.includes(current.nodeName)) return current;
    current = current.parentNode;
  }
  return null;
}

function caretToEnd(root) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Inline code has no execCommand, so it is the one mark done by hand.
function toggleInlineCode(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const existing = closestTag(range.commonAncestorContainer, ['CODE'], root);
  if (existing) {
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
    return;
  }
  if (range.collapsed) return;
  const code = document.createElement('code');
  try {
    range.surroundContents(code);
  } catch {
    // surroundContents refuses a range that only partly covers a node; taking
    // the contents out first always works.
    code.appendChild(range.extractContents());
    range.insertNode(code);
  }
}

// Build the editor's visible text plus a node/offset map, so a slash token
// found in that text can be turned back into a DOM Range. Block boundaries
// contribute a newline that belongs to no node: without it a token opening a
// new line would not match the tokenizer's "start or whitespace" rule.
function visibleTextMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans = [];
  let text = '';
  let previousBlock = null;
  let node = walker.nextNode();
  while (node) {
    const block = closestTag(node, ['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'], root) || root;
    if (previousBlock && block !== previousBlock) text += '\n';
    previousBlock = block;
    const value = node.textContent || '';
    spans.push({ node, start: text.length, end: text.length + value.length });
    text += value;
    node = walker.nextNode();
  }
  return { text, spans };
}

function pointAt(spans, offset) {
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) {
      return { node: span.node, offset: offset - span.start };
    }
  }
  return null;
}

function rangeFor(spans, start, end) {
  const from = pointAt(spans, start);
  const to = pointAt(spans, end);
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

// Chromium's block commands collapse the selection to the start of the block
// they just built: typing "first item" then clicking the bullet button leaves
// the caret at offset 0, so the next keystroke lands in front of the text
// (live-caught 2026-07-26, driven). None of the formatting commands change the
// TEXT, only its structure, so remembering the caret as a character offset and
// putting it back is exact.
function selectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const { spans } = visibleTextMap(root);
  const offsetOf = (node, offset) => {
    const span = spans.find((entry) => entry.node === node);
    return span ? span.start + offset : null;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start, end };
}

function restoreSelection(root, saved) {
  if (!saved) return;
  const { spans } = visibleTextMap(root);
  const range = rangeFor(spans, saved.start, saved.end);
  if (!range) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Run a BLOCK command with the caret where the user left it. A command that
// already landed the caret correctly restores to the same place, so this is a
// no-op rather than a second correction.
//
// Only block commands get this. An inline mark pressed with a COLLAPSED caret
// sets Chromium's pending typing style ("bold from here on"), and that pending
// style is discarded the moment anything touches the selection: restoring here
// would silently strip the formatting off text the user then types, which is
// exactly how Ctrl+B, type, Ctrl+B lost its bold (live-caught 2026-07-26).
function withCaretPreserved(root, run) {
  const saved = selectionOffsets(root);
  run();
  restoreSelection(root, saved);
}

// Blocks that count as content even when they hold no text: a bullet the user
// just added to an empty composer is something they made, not leftovers.
const STRUCTURAL = 'ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6';

// Emptying the composer leaves Chromium's pending typing style behind
// ("underlined from here on"), so the NEXT message comes out silently
// formatted even though the box looked blank (live-caught 2026-07-26: clearing
// an underlined draft and retyping produced <u>~~text~~</u> again). Nothing
// clears that style reliably, not removeFormat and not toggling the mark off,
// but replacing the contents gives a fresh caret with no style to inherit.
function resetIfBare(root) {
  if (!root || !root.childNodes.length) return;
  if (String(root.textContent || '').trim()) return;
  if (root.querySelector(STRUCTURAL)) return;
  const focused = document.activeElement === root;
  root.replaceChildren();
  // Emptying the node strands the selection outside the editor, and Chromium
  // then falls back to the LAST typing style it knew, which is the very thing
  // being cleared here. Putting a caret back inside recomputes the style from
  // the now-empty editor.
  if (focused) caretToEnd(root);
}

function paintSlashHighlights(root, knownNames) {
  // Absent in an older engine; the valid/unknown badge still reports the same
  // fact, so the loss is colour only.
  if (!window.CSS?.highlights || typeof window.Highlight !== 'function') return;
  const { text, spans } = visibleTextMap(root);
  const ok = [];
  const bad = [];
  // The ok/bad/plain rule lives in slash-tokens.cjs and nowhere else, so the
  // colour here can never drift from the valid/unknown badge beside it.
  for (const { start, token, kind } of classifySlashTokens(parseSlashTokens(text), knownNames)) {
    if (kind === 'plain') continue;
    const range = rangeFor(spans, start, start + token.length);
    if (!range) continue;
    (kind === 'ok' ? ok : bad).push(range);
  }
  window.CSS.highlights.set(HIGHLIGHT_OK, new window.Highlight(...ok));
  window.CSS.highlights.set(HIGHLIGHT_BAD, new window.Highlight(...bad));
}

function clearSlashHighlights() {
  if (!window.CSS?.highlights) return;
  window.CSS.highlights.delete(HIGHLIGHT_OK);
  window.CSS.highlights.delete(HIGHLIGHT_BAD);
}

// ── toolbar ─────────────────────────────────────────────────────────────────

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const IconBullets = () => (
  <Icon>
    <circle cx="5" cy="7" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="5" cy="17" r="1.4" fill="currentColor" stroke="none" />
    <path d="M10 7h9M10 12h9M10 17h9" />
  </Icon>
);

const IconNumbers = () => (
  <Icon>
    <path d="M10 7h9M10 12h9M10 17h9" />
    <text x="2" y="9" fontSize="7" fill="currentColor" stroke="none">1</text>
    <text x="2" y="14.5" fontSize="7" fill="currentColor" stroke="none">2</text>
    <text x="2" y="20" fontSize="7" fill="currentColor" stroke="none">3</text>
  </Icon>
);

const IconQuote = () => (
  <Icon>
    <path d="M5 6v12" strokeWidth="2.4" />
    <path d="M10 8h9M10 12h9M10 16h6" />
  </Icon>
);

const IconCode = () => (
  <Icon><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /></Icon>
);

const IconCodeBlock = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
  </Icon>
);

const IconLink = () => (
  <Icon><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></Icon>
);

const IconClear = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

// Everything here survives the trip to Claude as markdown. Font colour,
// highlight, and font size are deliberately absent even though Teams has them:
// Teams renders rich text, Harbor types into a terminal, so those would be
// controls that silently do nothing on the wire.
const TOOLBAR = [
  [
    { key: 'bold', title: 'Bold  (Ctrl+B)', label: 'B', state: 'bold', run: () => exec('bold') },
    { key: 'italic', title: 'Italic  (Ctrl+I)', label: 'I', state: 'italic', run: () => exec('italic') },
    { key: 'underline', title: 'Underline  (Ctrl+U)', label: 'U', state: 'underline', run: () => exec('underline') },
    { key: 'strike', title: 'Strikethrough  (Ctrl+Shift+X)', label: 'S', state: 'strikeThrough', run: () => exec('strikeThrough') },
  ],
  [
    { key: 'heading', block: true, title: 'Heading', label: 'H', run: (root) => exec('formatBlock', closestTag(window.getSelection()?.anchorNode, ['H2'], root) ? '<div>' : '<h2>') },
    { key: 'bullets', block: true, title: 'Bulleted list  (Ctrl+Shift+8)', icon: <IconBullets />, state: 'insertUnorderedList', run: () => exec('insertUnorderedList') },
    { key: 'numbers', block: true, title: 'Numbered list  (Ctrl+Shift+7)', icon: <IconNumbers />, state: 'insertOrderedList', run: () => exec('insertOrderedList') },
    { key: 'quote', block: true, title: 'Quote', icon: <IconQuote />, run: (root) => exec('formatBlock', closestTag(window.getSelection()?.anchorNode, ['BLOCKQUOTE'], root) ? '<div>' : '<blockquote>') },
  ],
  [
    { key: 'code', title: 'Inline code  (Ctrl+E)', icon: <IconCode />, run: (root) => toggleInlineCode(root) },
    { key: 'codeblock', block: true, title: 'Code block', icon: <IconCodeBlock />, run: (root) => exec('formatBlock', closestTag(window.getSelection()?.anchorNode, ['PRE'], root) ? '<div>' : '<pre>') },
    { key: 'link', title: 'Link', icon: <IconLink />, link: true },
  ],
  [
    { key: 'clear', block: true, title: 'Clear formatting', icon: <IconClear />, run: () => { exec('removeFormat'); exec('formatBlock', '<div>'); } },
  ],
];

// ── component ───────────────────────────────────────────────────────────────

export const ComposeEditor = forwardRef(function ComposeEditor({
  value,
  onChange,
  onSubmit,
  onPasteImage,
  onKeyDown,
  disabled,
  placeholder,
  ariaInvalid,
  formatOpen,
  knownCommandNames,
  className = '',
}, ref) {
  const editorRef = useRef(null);
  // What this editor last serialized out. Anything arriving in `value` that is
  // not this came from somewhere else and means "rebuild".
  const lastEmittedRef = useRef('');
  const [marks, setMarks] = useState({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const savedRangeRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus() { editorRef.current?.focus(); },
    get element() { return editorRef.current; },
  }), []);

  const emit = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    resetIfBare(root);
    const markdown = serializeDoc(root);
    lastEmittedRef.current = markdown;
    onChange?.(markdown);
  }, [onChange]);

  // Rebuild ONLY on an outside write. Comparing against the last emitted value
  // is what keeps this from fighting the caret on every keystroke.
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const incoming = String(value ?? '');
    if (incoming === lastEmittedRef.current) return;
    root.replaceChildren();
    if (incoming) root.appendChild(buildNodes(markdownToSpec(incoming), document));
    lastEmittedRef.current = incoming;
    if (document.activeElement === root) caretToEnd(root);
  }, [value]);

  // Slash colouring rides the value, so it repaints for typed AND inserted
  // text without a second trigger.
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    paintSlashHighlights(root, knownCommandNames);
  }, [value, knownCommandNames]);

  useEffect(() => () => clearSlashHighlights(), []);

  // Semantic tags, never styled spans. The serializer recognises <b>/<i>/<u>;
  // a <span style="font-weight:bold"> would render as bold on screen and then
  // silently arrive at the agent as plain text. Chromium already defaults this
  // way, but the default is per-document state that anything could flip.
  useEffect(() => {
    exec('styleWithCSS', false);
    exec('defaultParagraphSeparator', 'div');
  }, []);

  // What the toolbar should be showing as active right now.
  const readMarks = useCallback(() => {
    const root = editorRef.current;
    if (!root || !root.contains(document.getSelection()?.anchorNode ?? null)) return;
    const next = {};
    for (const group of TOOLBAR) {
      for (const item of group) {
        if (!item.state) continue;
        try { next[item.key] = document.queryCommandState(item.state); } catch { next[item.key] = false; }
      }
    }
    next.code = Boolean(closestTag(document.getSelection()?.anchorNode, ['CODE'], root));
    setMarks(next);
  }, []);

  // Toolbar lit-state follows the caret. selectionchange alone is NOT enough:
  // pressing B with a collapsed caret sets a typing style without moving the
  // selection, so the event never fires and the button stayed dark while bold
  // was in fact on (live-caught 2026-07-26). Every command re-reads directly.
  useEffect(() => {
    if (!formatOpen) return undefined;
    document.addEventListener('selectionchange', readMarks);
    readMarks();
    return () => document.removeEventListener('selectionchange', readMarks);
  }, [formatOpen, readMarks]);

  const runItem = (item) => {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    if (item.link) {
      const selection = window.getSelection();
      savedRangeRef.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      setLinkUrl('');
      setLinkOpen((open) => !open);
      return;
    }
    if (item.block) withCaretPreserved(root, () => item.run(root));
    else item.run(root);
    emit();
    readMarks();
  };

  const applyLink = () => {
    const root = editorRef.current;
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!root || !url) return;
    root.focus();
    const selection = window.getSelection();
    if (savedRangeRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRangeRef.current);
    }
    // With nothing selected there is no anchor text, so the URL becomes its own
    // label rather than producing an invisible empty link.
    if (selection?.isCollapsed) exec('insertText', url);
    const restored = window.getSelection();
    if (restored?.isCollapsed) {
      const range = restored.getRangeAt(0).cloneRange();
      range.setStart(range.startContainer, Math.max(0, range.startOffset - url.length));
      restored.removeAllRanges();
      restored.addRange(range);
    }
    exec('createLink', url);
    emit();
  };

  const handleKeyDown = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const root = editorRef.current;

    if (event.key === 'Enter' && !event.shiftKey) {
      // Enter ALWAYS submits, including inside a list. Send muscle memory
      // outranks list ergonomics; Shift+Enter makes the next bullet.
      event.preventDefault();
      onSubmit?.();
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      const inPre = closestTag(window.getSelection()?.anchorNode, ['PRE'], root);
      exec(inPre ? 'insertLineBreak' : 'insertParagraph');
      emit();
      return;
    }

    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    const shift = event.shiftKey;
    const command = (() => {
      if (!shift && key === 'b') return { run: () => exec('bold') };
      if (!shift && key === 'i') return { run: () => exec('italic') };
      if (!shift && key === 'u') return { run: () => exec('underline') };
      if (!shift && key === 'e') return { run: () => toggleInlineCode(root) };
      if (shift && key === 'x') return { run: () => exec('strikeThrough') };
      // With Shift held these arrive as their shifted characters on a US
      // layout, so both spellings are accepted.
      if (shift && (key === '8' || key === '*')) return { run: () => exec('insertUnorderedList'), block: true };
      if (shift && (key === '7' || key === '&')) return { run: () => exec('insertOrderedList'), block: true };
      return null;
    })();
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    if (command.block) withCaretPreserved(root, command.run);
    else command.run();
    emit();
    readMarks();
  };

  const handlePaste = (event) => {
    // The image branch calls preventDefault synchronously before it awaits.
    onPasteImage?.(event);
    if (event.defaultPrevented) return;
    // Everything else pastes as PLAIN TEXT. A contenteditable would otherwise
    // accept whatever HTML the source page put on the clipboard, dragging
    // foreign styling and structure into a message bound for a terminal.
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    if (text) exec('insertText', text);
    emit();
  };

  return (
    <div className="compose-editor-stack">
      {formatOpen ? (
        <div className="compose-format-bar" role="toolbar" aria-label="Text formatting">
          {TOOLBAR.map((group, index) => (
            <React.Fragment key={group[0].key}>
              {index ? <span className="compose-format-sep" aria-hidden="true" /> : null}
              {group.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`compose-format-btn fmt-${item.key}${marks[item.key] ? ' on' : ''}`}
                  title={item.title}
                  aria-label={item.title}
                  aria-pressed={item.state || item.key === 'code' ? Boolean(marks[item.key]) : undefined}
                  disabled={disabled}
                  // Keeping focus in the editor is the whole game: execCommand
                  // acts on the live selection, and a blur would lose it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runItem(item)}
                >
                  {item.icon || <span className="compose-format-glyph">{item.label}</span>}
                </button>
              ))}
            </React.Fragment>
          ))}
          {linkOpen ? (
            <span className="compose-link-field">
              <input
                type="text"
                value={linkUrl}
                autoFocus
                placeholder="https://…"
                aria-label="Link address"
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
                  if (event.key === 'Escape') { event.preventDefault(); setLinkOpen(false); editorRef.current?.focus(); }
                }}
              />
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={applyLink}>Add</button>
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={editorRef}
        className={`ubar-input${className ? ` ${className}` : ''}${value ? '' : ' is-empty'}`}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="true"
        aria-label="Message the selected session"
        aria-disabled={disabled ? true : undefined}
        aria-invalid={ariaInvalid ? true : undefined}
        data-placeholder={placeholder}
        onInput={emit}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
    </div>
  );
});
