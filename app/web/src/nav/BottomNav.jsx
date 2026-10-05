import React from 'react';
import './bottomnav.css';

const TABS = [
  ['chat', 'Chat', 'M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.8 3v-3H6.5A2.5 2.5 0 0 1 4 10.5z'],
  ['tasks', 'Tasks', 'M5 5.5h1.5M9 5.5h6M5 10h1.5M9 10h6M5 14.5h1.5M9 14.5h6'],
  ['notes', 'Notes', 'M6 3.5h6l3 3v10H6zM12 3.5v3h3M8.5 10h4M8.5 13h4'],
];

export function BottomNav({ active, onSelect }) {
  return <nav className="bottom-nav" aria-label="Primary navigation">
    {TABS.map(([id, label, path]) => <button key={id} type="button" className={`bottom-nav-item${active === id ? ' active' : ''}`} aria-current={active === id ? 'page' : undefined} onClick={() => onSelect(id)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d={path} /></svg><span>{label}</span>
    </button>)}
  </nav>;
}
