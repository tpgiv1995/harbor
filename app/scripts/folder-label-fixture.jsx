import React from 'react';
import { createRoot } from 'react-dom/client';
import { NewSessionConfig } from '../src/renderer/NewSessionConfig.jsx';
import { OrchPanel } from '../src/renderer/orchestration/OrchPanel.jsx';
import '../src/renderer/styles.css';

const query = new URLSearchParams(location.search);
const folder = query.get('folder');
const forbidden = () => { throw Error('This label fixture must never launch anything'); };
window.harbor = {
  session: { newOptions: async () => ({ providers: {}, profiles: [] }) },
  orchestration: {
    watch: async () => ({ projectRoot: folder, queue: { batches: [] } }),
    onUpdate: () => () => {}, unwatch: async () => {},
    kickoffResearch: forbidden, kickoffExecute: forbidden,
  },
};
createRoot(document.getElementById('root')).render(query.get('surface') === 'session'
  ? <NewSessionConfig request={{ folder }} onClose={() => {}} onStart={forbidden} onReconfigure={forbidden} />
  : <OrchPanel project={{ workspace: folder, label: '', sessions: [] }} onClose={() => {}} />);
