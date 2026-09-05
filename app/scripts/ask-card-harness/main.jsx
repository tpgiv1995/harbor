import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/styles.css';
import { AskCard } from '../../src/renderer/stage/AskCard.jsx';
import menus from './menus.json';

// A visual harness for the answer sheet: the REAL AskCard against menu-state
// payloads built from the real captures (make-menus.js), with window.harbor
// stubbed so every action is logged instead of sent. Not part of the app.
const log = [];
window.harbor = {
  session: {
    menuState: async ({ pane }) => menus[pane.paneId] || null,
    answerMenu: async ({ pane, action }) => {
      log.push({ pane: pane.paneId, action });
      document.getElementById('log').textContent = JSON.stringify(log, null, 1);
      return { ok: true };
    },
  },
};

function Frame({ id, width, title, selected = false }) {
  return (
    <div className="harness-win" style={{ width }}>
      <div className="harness-title">{title}</div>
      <div className="harness-conv">conversation…</div>
      <AskCard pane={{ paneId: id }} sessionId="s" selected={selected} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <div className="harness">
    <Frame id="batch" width={880} title="batch, 880px" selected />
    <Frame id="batch" width={360} title="batch, 360px (a 4x4 tile)" />
    <Frame id="answered" width={640} title="batch with question 1 answered in the terminal" />
    <Frame id="lone" width={640} title="lone question (immediate)" />
    <Frame id="multi" width={640} title="lone multi-select (staged)" />
    <Frame id="review" width={520} title="review screen" />
    <Frame id="permission" width={520} title="permission prompt" />
    <Frame id="fallback" width={520} title="unrecognized dialog (fallback)" />
    <pre id="log" className="harness-log" />
  </div>,
);
