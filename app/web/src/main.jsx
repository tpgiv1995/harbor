import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  defaultServerUrl,
  loadSettings,
  probeAuth,
  saveSettings,
} from './rpc/client.js';
import { AppShell } from './shell/AppShell.jsx';
import setupGateModule from './rpc/setup-gate.cjs';
import './styles.css';

const { setupGate } = setupGateModule;

function ConnectScreen({ initial, onConnect }) {
  const [serverUrl, setServerUrl] = useState(initial.serverUrl || defaultServerUrl());
  const [token, setToken] = useState(initial.token || '');
  const [error, setError] = useState('');

  const submit = (event) => {
    event.preventDefault();
    const trimmedUrl = serverUrl.trim();
    if (!trimmedUrl) {
      setError('Server URL is required');
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(trimmedUrl);
    } catch {
      setError('Enter a full URL like https://your-machine.your-tailnet.ts.net');
      return;
    }
    if (!token.trim()) {
      setError('Paste the token from harbor-server (server-token file)');
      return;
    }
    setError('');
    onConnect({ serverUrl: trimmedUrl.replace(/\/$/, ''), token: token.trim() });
  };

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-mark" aria-hidden="true" />
        <h1>Harbor</h1>
        <p className="connect-lead">
          Connect to your harbor-server over Tailscale. The token lives in your
          Harbor config as <code>server-token</code>.
        </p>
        <form onSubmit={submit}>
          <label>
            <span>Server URL</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://your-machine.your-tailnet.ts.net"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </label>
          <label>
            <span>Token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="64-character hex token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          {error ? <p className="connect-error" role="alert">{error}</p> : null}
          <button type="submit" className="btn-primary">Connect</button>
        </form>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark" />
      <p>Connecting to Harbor…</p>
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [auth, setAuth] = useState(null);
  const [forceSetup, setForceSetup] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    probeAuth(settings.serverUrl).then((result) => { if (!cancelled) setAuth(result); });
    return () => { cancelled = true; };
  }, [settings.serverUrl]);

  const gate = setupGate({ settings, auth });
  if (gate === 'pending') return <Splash />;

  if (gate === 'setup' || forceSetup) {
    return (
      <ConnectScreen
        initial={settings}
        onConnect={(next) => {
          saveSettings(next);
          setSettings(next);
          setForceSetup(false);
        }}
      />
    );
  }

  return (
    <AppShell
      settings={settings}
      auth={auth}
      onRequestSetup={() => setForceSetup(true)}
      onSignOut={() => {
        const cleared = { serverUrl: settings.serverUrl, token: '' };
        saveSettings(cleared);
        setSettings(cleared);
        setForceSetup(true);
      }}
    />
  );
}

createRoot(document.getElementById('root')).render(<App />);
