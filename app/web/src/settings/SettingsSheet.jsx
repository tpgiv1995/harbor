import React, { useCallback, useEffect, useState } from 'react';
import { probeAuth } from '../rpc/client.js';
import './settings.css';

function identityLabel(auth) {
  if (!auth) return 'Checking…';
  if (auth.login) return auth.login;
  if (auth.authenticated) return 'Tailnet device (no login name)';
  return 'Not authenticated via tailnet';
}

function tokenRequiredLabel(auth) {
  if (!auth) return 'Checking…';
  return auth.tokenRequired ? 'Yes — paste the server token to connect' : 'No — tailnet identity is enough';
}

export function SettingsSheet({
  open,
  onClose,
  serverUrl,
  auth: initialAuth,
  onRequestSetup,
  onSignOut,
}) {
  const [auth, setAuth] = useState(initialAuth);
  const [confirmReconnect, setConfirmReconnect] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmReconnect(false);
      return undefined;
    }
    let cancelled = false;
    setAuth(initialAuth);
    probeAuth(serverUrl).then((result) => {
      if (!cancelled) setAuth(result);
    });
    return () => { cancelled = true; };
  }, [open, serverUrl, initialAuth]);

  const onBackdrop = useCallback((event) => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      className="settings-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={onBackdrop}
    >
      <div className="settings-panel">
        <header className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <div className="settings-row">
            <span className="settings-label">Server</span>
            <span className="settings-value">{serverUrl || 'Not set'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Tailnet identity</span>
            <span className="settings-value">{identityLabel(auth)}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Token required</span>
            <span className="settings-value settings-value-muted">{tokenRequiredLabel(auth)}</span>
          </div>
        </div>

        <footer className="settings-actions">
          {confirmReconnect ? (
            <>
              <p className="settings-confirm">
                This disconnects Harbor and shows the server setup screen. Your open
                session stays on the server; you will need to connect again.
              </p>
              <div className="settings-confirm-actions">
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => setConfirmReconnect(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="settings-btn settings-btn-danger"
                  onClick={() => {
                    onRequestSetup?.();
                    onClose();
                  }}
                >
                  Reconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="settings-btn"
                onClick={() => setConfirmReconnect(true)}
              >
                Reconnect / change server
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-danger"
                onClick={() => {
                  onSignOut?.();
                  onClose();
                }}
              >
                Sign out
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
