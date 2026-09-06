import React, { useEffect, useMemo, useState } from 'react';
import slashTokens from '../../../src/renderer/stage/slash-tokens.cjs';
import './slash.css';

const {
  parseSlashTokens,
  activeSlashToken,
  slashMatchesFor,
  slashChrome,
  classifySlashTokens,
} = slashTokens;

const SOURCE_LABEL = {
  'built-in': 'Built-in',
  user: 'User',
  project: 'Project',
  plugin: 'Plugin',
  skill: 'Skill',
};

export function useSlashState(text, commands) {
  const knownNames = useMemo(
    () => new Set((commands || []).map((command) => command.name)),
    [commands],
  );
  const tokens = useMemo(() => parseSlashTokens(text), [text]);
  const active = useMemo(() => activeSlashToken(text, tokens), [text, tokens]);
  const classified = useMemo(() => classifySlashTokens(tokens, knownNames), [tokens, knownNames]);
  const chrome = useMemo(() => slashChrome(tokens, knownNames), [tokens, knownNames]);
  const matches = useMemo(() => slashMatchesFor(active, commands), [active, commands]);
  const exact = Boolean(active) && knownNames.has(active.token);
  const open = Boolean(active && matches.length > 0 && !(exact && matches.length === 1));
  return { active, classified, chrome, matches, open, knownNames };
}

export function SlashPalette({
  open,
  matches,
  highlight,
  onHighlight,
  onPick,
  onDismiss,
}) {
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const update = () => {
      const field = document.querySelector('.composer-field textarea');
      const stack = document.querySelector('.composer-field');
      if (!field || !stack) return;
      const rect = field.getBoundingClientRect();
      setPos({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 6,
        width: rect.width,
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, matches.length]);

  if (!open || !pos) return null;

  return (
    <div className="slash-palette" style={{ left: pos.left, bottom: pos.bottom, width: pos.width }} role="listbox">
      {matches.map((command, index) => (
        <button
          key={`${command.source}:${command.name}`}
          type="button"
          role="option"
          aria-selected={index === highlight}
          className={`slash-palette-row${index === highlight ? ' active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onPick(command)}
        >
          <span className="slash-palette-name">{command.name}</span>
          <span className="slash-palette-src">{SOURCE_LABEL[command.source] || command.source}</span>
          {command.description ? <span className="slash-palette-desc">{command.description}</span> : null}
        </button>
      ))}
      <button type="button" className="slash-palette-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
