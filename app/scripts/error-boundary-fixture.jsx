import React from 'react';
import { createRoot } from 'react-dom/client';
import tasks from '../src/shared/tasks-model.cjs';
import notes from '../src/shared/notes-model.cjs';

// Only the drive imports this module. No IPC, sockets, or provider processes.
const noop = () => () => {};
const model = { projects: [], liveProjects: [] };
const responses = {
  'sidebar:get-state': { model },
  'session:new-options': { profiles: [], workflows: [], providers: {} },
  'setup:state': { completed: true, orchestrationEnabled: true },
  'tasks:read': { ok: true, doc: tasks.emptyDoc(), recovery: null },
  'notes:read': { ok: true, doc: notes.emptyDoc(), recovery: null },
  'links:get': {},
  'asks:list': [],
  'accounts:read-emails': {},
  'usage:get-all': {},
  'project-icons:list': { icons: {} },
  'transcript:open': { ok: true },
};
const kebab = (value) => value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
window.__boundaryCall = async (channel) => responses[channel] ?? null;
window.harbor = new Proxy({ e2e: true }, {
  get(target, key) {
    if (key in target) return target[key];
    return new Proxy({}, {
      get(_target, method) {
        if (String(method).startsWith('on')) return noop;
        return () => window.__boundaryCall(`${kebab(key)}:${kebab(method)}`);
      },
    });
  },
});

if (new URLSearchParams(location.search).has('phone')) {
  Promise.all([import('../web/src/shell/AppShell.jsx'), import('../web/src/styles.css')])
    .then(([{ AppShell }]) => createRoot(document.getElementById('root')).render(
      <AppShell settings={{ serverUrl: 'http://127.0.0.1', token: 'fixture' }} auth={{}} />,
    ));
}
