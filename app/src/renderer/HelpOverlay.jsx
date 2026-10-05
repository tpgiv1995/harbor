import React, { useEffect } from 'react';

// The whole app on one glass screen: open with F1, the titlebar ?, or the menu.
// This is the 5-minute onboarding surface; keep it accurate and keep it short.
// Every claim here must match real behavior (no aspirational copy).
function Key({ children }) {
  return <kbd className="help-key">{children}</kbd>;
}

export function HelpOverlay({ onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="Quick guide">
      <button type="button" tabIndex={-1} className="help-backdrop" aria-label="Close guide" onClick={onClose} />
      <div className="help-panel">
        <div className="help-head">
          <h2 className="help-title">Harbor in five minutes</h2>
          <span className="help-sub">Everything the app does, on one screen</span>
          <button type="button" className="help-close" onClick={onClose}>Close</button>
        </div>
        <div className="help-grid">
          <div className="help-card">
            <h3>The rail</h3>
            <ul>
              <li>Click a session to open it as a window on the stage; instantly readable, no resume needed. A glowing dot means it is running right now.</li>
              <li>Right-click a session to copy a paste-ready resume command.</li>
              <li>Hover a project row for <strong>+ P</strong> / <strong>+ T</strong> (new session there) and <strong>Orch</strong>.</li>
              <li>Search (<Key>Ctrl+K</Key>) matches projects, titles, and the raw opening prompt; orchestration workers appear only in search results or the ⚙ chip.</li>
              <li>Today / 7d / 30d / All and the date picker narrow by time.</li>
            </ul>
          </div>
          <div className="help-card">
            <h3>The four views</h3>
            <ul>
              <li>The switch above the rail swaps the main pane: <strong>Agents</strong> (the stage), <strong>Tasks</strong>, <strong>Orch</strong>, <strong>Files</strong>. The rail stays put in all four, and opening any session window returns you to Agents.</li>
              <li><strong>Tasks</strong> is a to-do list: lists down the left, <em>My Day</em> / <em>Important</em> / <em>Planned</em> above them, tags below. Type in the box and press <Key>⏎</Key>; click the circle to finish something; click the task to edit everything about it. Sub-tasks go three levels deep.</li>
              <li>My Day empties itself each morning, and the day rolls at 6am, so a task added at 1am is still on the day that has not ended. An amber count on the tab means something is due today or overdue.</li>
              <li>Tasks live in one plain JSON file (<em>Show the tasks file</em> in the list panel). <code>harbor-tasks</code> reads and writes the same file from a terminal, so a coding agent can work with the list while the app is open.</li>
              <li><strong>Files</strong> is what your agents produced: HTML, images, PDFs and video, previewed and opened in place.</li>
            </ul>
          </div>
          <div className="help-card">
            <h3>Session windows</h3>
            <ul>
              <li>Up to four sessions tile on the stage. Click one (or <Key>Ctrl+1–4</Key>) to make it <em>active</em>; it raises, the rest recess.</li>
              <li>Each window is the conversation itself: your prompts, Claude&rsquo;s replies, and what it did (edits, commands, tests) as action rows.</li>
              <li>A session waiting on a question or permission prompt shows an amber <em>needs your answer</em> cue and an in-window card; click an option to answer in place (Dismiss cancels it).</li>
              <li><strong>&gt;_</strong> flips a live window to the raw terminal for anything the card cannot answer. Flip back any time.</li>
              <li>× removes a window from the stage; the session itself keeps running.</li>
              <li>The donut is that session&rsquo;s context usage; it turns amber as the window fills.</li>
            </ul>
          </div>
          <div className="help-card">
            <h3>Command bar</h3>
            <ul>
              <li>The bar at the bottom always sends to the <em>active</em> window; the target chip names it.</li>
              <li><Key>⏎</Key> sends. A closed session is resumed first, then your message is delivered (the chip narrates: resuming → waiting → sent).</li>
              <li><strong>+</strong> inserts file paths for Claude to read. The model chip switches the session&rsquo;s model in place.</li>
              <li>A session running in a terminal outside Harbor shows read-only; watch it live, drive it where it lives.</li>
            </ul>
          </div>
          <div className="help-card">
            <h3>Title bar</h3>
            <ul>
              <li><em>N live</em> counts running sessions. The usage rows are the 5-hour and weekly windows, one row per configured plan in its own colour; hover for weekly, cost, and reset times.</li>
              <li>The ⚙ chip appears while orchestration workers run; open one read-only, or close it (× asks twice).</li>
              <li>Each plan carries its own letter badge, shown on every session row and window. You choose the letter, colour and label per plan in the setup wizard.</li>
            </ul>
          </div>
          <div className="help-card">
            <h3>Keyboard</h3>
            <ul>
              <li><Key>Ctrl+1–4</Key> select window · <Key>Alt</Key>+arrows move between windows · <Key>Ctrl+K</Key> search · <Key>F1</Key> this guide · <Key>F11</Key> full screen</li>
              <li><Key>Ctrl+Shift+B</Key> hide/show the rail · <Key>Ctrl+Shift+R</Key> reload the UI · <Key>Ctrl+Shift+Q</Key> quit · <Key>Ctrl</Key>+<Key>+</Key>/<Key>-</Key>/<Key>0</Key> zoom</li>
              <li>Formatting the message: <Key>Ctrl+B</Key> bold · <Key>Ctrl+I</Key> italic · <Key>Ctrl+U</Key> underline · <Key>Ctrl+Shift+X</Key> strikethrough · <Key>Ctrl+E</Key> code · <Key>Ctrl+Shift+8</Key> bullets · <Key>Ctrl+Shift+7</Key> numbering. What you see is what you get; it is sent as markdown.</li>
              <li><Key>Enter</Key> always sends, including inside a list. <Key>Shift+Enter</Key> is a new line, and makes the next bullet when you are in one.</li>
              <li>Misspelled words are underlined in red; right-click one for corrections or to add it to your dictionary.</li>
              <li>In a raw terminal: <Key>Ctrl+C</Key> copies when text is selected, interrupts otherwise; <Key>Ctrl+V</Key> pastes; highlighting auto-copies.</li>
            </ul>
          </div>
          <div className="help-card">
            <h3>If something looks off</h3>
            <ul>
              <li>An amber strip means the session daemon is unreachable. History and conversations still work; Reconnect restarts the app.</li>
              <li>A blue strip means a newer Harbor build landed on disk. Click Reload to load it.</li>
              <li>Greyed sessions marked win: are Windows-era history whose folder no longer exists.</li>
            </ul>
          </div>
        </div>
        <p className="help-foot" style={{ marginTop: 14, marginBottom: 0, color: 'var(--muted)', fontSize: 11 }}>
          That is the entire app. Close this with Escape, the Close button, or a click outside.
        </p>
      </div>
    </div>
  );
}
