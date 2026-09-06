import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { xtermScrollbackOptions } from './scrollback.js';

// Opaque near-black ground (terminal text over the lighthouse photo would be
// unreadable), beam-cyan cursor, and a full muted ANSI palette: xterm's
// defaults render shell greens/blues as harsh neons (the lime prompt), so
// every ANSI slot maps to a softened tone instead.
const THEME = {
  // Transparent: the pane div's heavy glass fill provides the ground, so the
  // lighthouse ghosts through behind the text (allowTransparency below).
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#ecf0f4',
  cursor: '#e6ebf0',
  cursorAccent: '#05080c',
  selectionBackground: 'rgba(217, 224, 231, 0.28)',
  black: '#3a3a37',
  red: '#e06c60',
  green: '#8fbc8a',
  yellow: '#dcae5e',
  blue: '#7da9d3',
  magenta: '#b58cc4',
  cyan: '#7fbcb2',
  white: '#d8d8d2',
  brightBlack: '#6f6f67',
  brightRed: '#ff8a7f',
  brightGreen: '#a5cf9f',
  brightYellow: '#eec685',
  brightBlue: '#9cc0e5',
  brightMagenta: '#cba8d8',
  brightCyan: '#9cd2c9',
  brightWhite: '#ecece7',
};

function decodeFrame(data) {
  if (!data) return '';
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function XtermPane({
  paneId,
  style,
  focused,
  highlighted,
  externallyControlled,
  onFocusPane,
  onBlurPane,
  onResizePane,
  onSendInput,
  onFrame,
  onBackfill,
  onReset,
}) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const focusedRef = useRef(false);
  const [menu, setMenu] = useState(null);
  const onFocusPaneRef = useRef(onFocusPane);
  const onBlurPaneRef = useRef(onBlurPane);
  const onResizePaneRef = useRef(onResizePane);
  const onSendInputRef = useRef(onSendInput);
  const externallyControlledRef = useRef(externallyControlled);

  useEffect(() => { onFocusPaneRef.current = onFocusPane; }, [onFocusPane]);
  useEffect(() => { onBlurPaneRef.current = onBlurPane; }, [onBlurPane]);
  useEffect(() => { onResizePaneRef.current = onResizePane; }, [onResizePane]);
  useEffect(() => { onSendInputRef.current = onSendInput; }, [onSendInput]);
  useEffect(() => { externallyControlledRef.current = externallyControlled; }, [externallyControlled]);

  useEffect(() => {
    const term = new Terminal({
      ...xtermScrollbackOptions(),
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.write('\x1b[?2004h'); // assume bracketed paste until the app says otherwise
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const fitAndReport = () => {
      fit.fit();
      // Report the TRUE rendered size unconditionally: main keeps it per pane,
      // so control acquisition sizes the pty to what is actually on screen
      // instead of a stale daemon column count (text bunched in a corner).
      onResizePaneRef.current?.(paneId, { cols: term.cols, rows: term.rows });
    };

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitAndReport);
    });
    resizeObserver.observe(hostRef.current);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      // Linux terminal muscle memory: Ctrl+Shift+C / Ctrl+Shift+V always mean
      // copy / paste and never reach the pty.
      if (event.ctrlKey && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        }
        return false;
      }
      if (event.ctrlKey && event.shiftKey && (event.key === 'V' || event.key === 'v')) {
        navigator.clipboard.readText()
          .then((text) => termRef.current?.paste(text))
          .catch(() => {});
        return false;
      }
      if (event.ctrlKey && event.key === 'c') {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          return false;
        }
        onSendInputRef.current?.(paneId, '\x03');
        return false;
      }
      if (event.ctrlKey && event.key === 'v') {
        // term.paste() applies bracketed-paste framing so multi-line pastes
        // land as one block instead of submitting per line.
        navigator.clipboard.readText()
          .then((text) => termRef.current?.paste(text))
          .catch(() => {});
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (!externallyControlledRef.current) onSendInputRef.current?.(paneId, data);
    });

    // Auto-copy on highlight, terminal muscle memory: any selection lands on
    // the clipboard (debounced so a drag writes once, and a cleared selection
    // never clobbers what was copied).
    let selectionTimer = null;
    term.onSelectionChange(() => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (!term.hasSelection()) return;
        const text = term.getSelection();
        if (text) navigator.clipboard.writeText(text).catch(() => {});
      }, 150);
    });

    const host = hostRef.current;
    const onFocusIn = () => {
      focusedRef.current = true;
      fitAndReport();
      onFocusPaneRef.current?.(paneId, { cols: term.cols, rows: term.rows });
    };
    const onFocusOut = (event) => {
      if (host.contains(event.relatedTarget)) return;
      focusedRef.current = false;
      onBlurPaneRef.current?.(paneId);
    };
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);

    const onContextMenu = (event) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY });
    };
    hostRef.current.addEventListener('contextmenu', onContextMenu);

    return () => {
      resizeObserver.disconnect();
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      host.removeEventListener('contextmenu', onContextMenu);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [paneId]);

  useEffect(() => {
    if (!focused || !termRef.current) return undefined;
    termRef.current.focus();
    // Direct fit + resize on top of the focusin path: focusin does not re-fire
    // when DOM focus is already here, and the pty MUST match the rendered size
    // whenever this pane is controlled, or its content sits bunched in a
    // corner of the box. Retried, because a fit fired mid-control-handshake
    // can be dropped (live-caught).
    const timers = [80, 500, 1600].map((delay) => setTimeout(() => {
      const term = termRef.current;
      if (!term || !fitRef.current) return;
      focusedRef.current = true;
      fitRef.current.fit();
      onResizePaneRef.current?.(paneId, { cols: term.cols, rows: term.rows });
    }, delay));
    return () => timers.forEach(clearTimeout);
  }, [focused, paneId]);

  useEffect(() => {
    return onFrame?.(({ paneId: id, data }) => {
      if (id !== paneId || !termRef.current) return;
      const text = decodeFrame(data);
      if (text) termRef.current.write(text);
    });
  }, [paneId, onFrame]);

  useEffect(() => {
    return onBackfill?.(({ paneId: id, text }) => {
      if (id !== paneId || !termRef.current || !text) return;
      termRef.current.write(text);
    });
  }, [paneId, onBackfill]);

  useEffect(() => {
    return onReset?.(({ paneId: id }) => {
      // Observer respawned at a new viewport: drop the stale-width buffer
      // before the fresh backfill arrives.
      if (id !== paneId || !termRef.current) return;
      termRef.current.reset();
      // Attach repaints do not re-assert bracketed paste (round-2 live-proven);
      // enable it xterm-side so term.paste() wraps multi-line pastes. Local
      // write only; the pty never sees this.
      termRef.current.write('\x1b[?2004h');
    });
  }, [paneId, onReset]);

  const closeMenu = () => setMenu(null);

  const copySelection = async () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    await navigator.clipboard.writeText(term.getSelection());
    closeMenu();
  };

  const pasteClipboard = async () => {
    const text = await navigator.clipboard.readText();
    termRef.current?.paste(text);
    closeMenu();
  };

  return (
    <div
      className={`terminal-pane${highlighted ? ' daemon-focused' : ''}${focused ? ' focused' : ''}${externallyControlled ? ' external-control' : ''}`}
      style={style}
      data-pane-id={paneId}
    >
      <div className="terminal-pane-host" ref={hostRef} />
      {externallyControlled ? (
        <div className="terminal-pane-status">controlled by terminal client</div>
      ) : null}
      {menu ? createPortal(
        // Portaled to body: the tile's backdrop-filter would otherwise become
        // this fixed menu's containing block and strand it inside the pane.
        <>
          <button type="button" className="terminal-menu-backdrop" onClick={closeMenu} aria-label="Close menu" />
          <div className="terminal-context-menu" style={{ left: menu.x, top: menu.y }}>
            <button type="button" onClick={copySelection}>Copy</button>
            <button type="button" onClick={pasteClipboard}>Paste</button>
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  );
}
