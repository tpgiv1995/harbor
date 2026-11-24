import React from 'react';
import { createRoot } from 'react-dom/client';
import { NewSessionConfig } from '../src/renderer/NewSessionConfig.jsx';
import { SessionTile } from '../src/renderer/stage/SessionTile.jsx';
import { ProfilesProvider } from '../src/renderer/providers.js';
import { SetupWizard } from '../src/renderer/setup/SetupWizard.jsx';
import '../src/renderer/styles.css';

// Fixture page for scripts/drive-gemini-ui-win.js: the shipped components against a stand-in
// `window.harbor`, so Gemini can be looked at before the registry and rail sides are merged. Every
// harbor call answers with an empty promise; nothing here can launch, sign in or touch a store.
// The registry entry for Gemini is the shape the launch side sends (gemini-model-catalog.js):
// a Default row first, then each model family with its own efforts.
const query = new URLSearchParams(location.search);

const registry = {
  claude: { defaultModel: 'default', models: [{ value: 'default', label: 'Account default' }, { value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5.5' }], efforts: ['default', 'low', 'medium', 'high', 'xhigh'] },
  codex: { defaultModel: 'default', models: [{ value: 'default', label: 'Codex default' }, { value: 'gpt-6-sol', label: 'gpt-6-sol' }], efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  cursor: { defaultModel: 'default', models: [{ value: 'default', label: 'Default' }, { value: 'auto', label: 'Auto' }], efforts: [] },
  gemini: {
    defaultModel: 'default',
    models: [
      { value: 'default', label: 'Gemini default' },
      { value: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { value: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    effortsByModel: { default: ['low', 'medium', 'high', 'xhigh'], 'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'], 'gemini-4-hydrogen': ['low', 'medium'] },
    defaultEffort: 'high',
  },
};
const profiles = [
  { id: 'personal', label: 'Personal', letter: 'P', color: '#6fa8d8', provider: 'claude', isDefault: true, configHome: 'C:/h/.claude' },
  { id: 'codex', label: 'Codex', letter: 'C', color: '#7bd3a0', provider: 'codex', isDefault: false, configHome: 'C:/h/.codex' },
  { id: 'gemini', label: 'Gemini', letter: 'G', color: '#8ab4f8', provider: 'gemini', isDefault: false, configHome: 'C:/h' },
];
const options = {
  providers: Object.fromEntries(Object.entries(registry).map(([id, entry]) => [id, {
    ...entry, profiles: profiles.filter((p) => p.provider === id), defaultProfile: profiles.find((p) => p.provider === id)?.id || null,
  }])),
  profiles,
  profilesByProvider: Object.fromEntries(Object.keys(registry).map((id) => [id, profiles.filter((p) => p.provider === id)])),
  workflows: [],
  defaults: { provider: 'claude', model: 'opus', effort: 'high' },
};

// What detection reports on the fixture machine: one Claude home, Gemini's agy found, no Codex or Cursor.
const detected = {
  os: 'win32', osLabel: 'Windows', homedir: 'C:/Users/demo', shell: 'powershell', symlinkStyle: 'junction',
  providers: {
    claude: { found: true, path: 'C:/Tools/claude.exe' },
    codex: { found: false, path: null, home: null },
    cursor: { found: false, path: null, home: null },
    gemini: { found: true, path: 'C:/Tools/agy/agy.exe', home: 'C:/Users/demo', email: null },
  },
  claudeHomes: [{ id: 'personal', path: 'C:/Users/demo/.claude', exists: true, authed: true, email: 'demo@example.com' }],
  orchestration: { launcher: '', found: false },
};

const quiet = () => () => {};
function stub(pathParts = []) {
  const target = () => {};
  return new Proxy(target, {
    get(_t, key) {
      if (key === 'then') return undefined;
      return stub([...pathParts, String(key)]);
    },
    apply(_t, _this, args) {
      const name = pathParts.at(-1) || '';
      const full = pathParts.join('.');
      if (full === 'session.newOptions') return Promise.resolve(options);
      if (full === 'setup.detect') return Promise.resolve({ ok: true, config: null, detected });
      if (full === 'setup.preview') return Promise.resolve({ ok: true, config: args[0]?.config });
      if (full === 'setup.login') return Promise.resolve({ ok: false, launched: false, reason: 'The fixture never opens a terminal.', manualCommand: '$env:AGY_CLI_DISABLE_AUTO_UPDATE = \'true\'; agy' });
      if (/^on[A-Z]/.test(name)) return quiet();
      return Promise.resolve({ ok: true, capabilities: { commands: [] } });
    },
  });
}
window.harbor = stub();

const refuse = () => { throw Error('This fixture must never launch anything'); };
const now = Date.now();
const sessions = [
  { id: 'a1000000-0000-4000-8000-000000000001', provider: 'claude', home: 'personal', title: 'Fix the retry test', project: 'lighthouse', cwd: 'C:/work/lighthouse', model: 'opus', effort: 'high' },
  { id: 'a2000000-0000-4000-8000-000000000002', provider: 'codex', home: 'codex', title: 'Write the release notes', project: 'lighthouse', cwd: 'C:/work/lighthouse', model: 'gpt-6-sol', effort: 'medium' },
  { id: 'a3000000-0000-4000-8000-000000000003', provider: 'cursor', title: 'Trim the changelog', project: 'lighthouse', cwd: 'C:/work/lighthouse', model: 'auto' },
  { id: 'a4000000-0000-4000-8000-000000000004', provider: 'gemini', home: 'gemini', title: 'Plan the harbor migration', project: 'lighthouse', cwd: 'C:/work/lighthouse', model: 'gemini-4-neon', effort: 'high' },
];
const headers = {
  claude: { model: { id: 'claude-opus-5-5', name: 'Opus 5.5', tone: 'opus' }, effort: 'high', contextPct: 31 },
  codex: { model: { id: 'gpt-6-sol', name: 'gpt-6-sol', tone: 'other' }, effort: 'medium', contextPct: 18 },
  cursor: { model: { id: 'auto', name: 'Auto', tone: 'other' } },
  gemini: { model: { id: 'gemini-4-neon', name: 'Gemini 4 Neon', tone: 'other' }, effort: 'high', contextPct: 12 },
};
const blocks = (text) => [
  { kind: 'user', id: 'u1', text: 'Where did we leave off?', ts: new Date(now - 90000).toISOString() },
  { kind: 'assistant', id: 'a1', text, ts: new Date(now - 60000).toISOString() },
];

function Tiles() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, padding: 12, width: 1180, height: 560 }}>
      {sessions.map((session, index) => (
        <div key={session.id} style={{ position: 'relative', minHeight: 0, display: 'grid' }}>
          <SessionTile
            session={session}
            data={{ header: headers[session.provider], blocks: blocks(`This is the ${session.provider} window. Its model chip carries the provider mark.`) }}
            pane={null}
            selected={index === 3}
            index={index}
            slot={index}
            tty={false}
            onSelect={() => {}} onClose={refuse} onToggleTty={() => {}} onToggleFocus={() => {}}
            onNewSibling={refuse} onOpenConfig={() => {}} xterm={{}}
          />
        </div>
      ))}
    </div>
  );
}

// The plan picker's Other row, drawn with the picker's own classes at the picker's own width (256): the
// label names three providers now, and a label that no longer fits would end in an ellipsis.
function OtherRow() {
  return (
    <div className="rail-menu plan-picker" style={{ position: 'static', width: 256, margin: 24 }}>
      <div className="rail-menu-list">
        <button type="button" role="menuitem" className="rail-menu-item plan-pick plan-pick-other">
          <span className="rail-menu-mark" aria-hidden="true" />
          <span className="plan-pick-badge" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
              <circle cx="3.5" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
            </svg>
          </span>
          <span className="rail-menu-label">Other: Codex, Cursor, Gemini…</span>
        </button>
      </div>
    </div>
  );
}

const surface = query.get('surface');
const node = surface === 'wizard'
  ? <SetupWizard dismissible onClose={() => {}} />
  : surface === 'other'
  ? <OtherRow />
  : surface === 'tiles'
  ? <Tiles />
  : <NewSessionConfig request={{ folder: 'C:/work/lighthouse', provider: query.get('provider') || 'claude', model: registry[query.get('provider') || 'claude'].defaultModel, effort: registry[query.get('provider') || 'claude'].defaultEffort }} onClose={() => {}} onStart={refuse} onReconfigure={refuse} />;
createRoot(document.getElementById('root')).render(<ProfilesProvider>{node}</ProfilesProvider>);
