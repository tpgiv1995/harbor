import React from 'react';
import { createRoot } from 'react-dom/client';

const surface = new URLSearchParams(location.search).get('surface');
const call = (channel, op) => window.reviewStore.call(channel, op);
const noop = () => () => {};
window.harbor = Object.fromEntries(['notes', 'tasks'].map((kind) => [kind, {
  read: () => call(`${kind}:read`), mutate: (op) => call(`${kind}:mutate`, op), onChange: noop,
}]));
const client = { getState: () => 'connected', call, onChannel: noop, onConnection: noop };

async function mount() {
  await import(surface.startsWith('phone') ? '../web/src/styles.css' : '../src/renderer/styles.css');
  let View;
  if (surface === 'desktop-notes') {
    View = (await import('../src/renderer/notes/NotesView.jsx')).NotesView;
  } else if (surface === 'desktop-tasks') {
    const { TasksView } = await import('../src/renderer/tasks/TasksView.jsx');
    const { useTasks, useToday } = await import('../src/renderer/tasks/use-tasks.js');
    View = () => <TasksView {...useTasks()} today={useToday()} />;
  } else if (surface === 'phone-notes') {
    const { NotesView } = await import('../web/src/notes/NotesView.jsx');
    const { useNotes } = await import('../web/src/notes/useNotes.js');
    View = () => <NotesView {...useNotes(client)} />;
  } else {
    const { TasksView } = await import('../web/src/tasks/TasksView.jsx');
    View = () => <TasksView client={client} />;
  }
  createRoot(document.getElementById('root')).render(<View />);
}
mount();
