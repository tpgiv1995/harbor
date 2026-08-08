import React, { useState } from 'react';
import { Detected, Field, PathInput, TextInput, errorFor } from './controls.jsx';

// Step 1. What Harbor found, shown as findings rather than as filled-in
// defaults.
//
// HERDR IS OPTIONAL AND THIS SCREEN HAS TO SAY SO. Harbor's own session daemon
// is the default backend and needs no separate install; Herdr is the fallback,
// selected only by `HARBOR_SESSION_BACKEND=herdr`. This step used to open by
// telling every new user that "Harbor runs your agent sessions through the Herdr
// daemon" and then required a herdr path before Next would light, which is a
// first screen that sends somebody off to install a daemon they will never use.
// A missing herdr still renders the real install command for THIS platform,
// copyable, because somebody who DOES want the fallback should not have to go
// looking for it.
export function PlatformStep({ state, patch, detected, errors, showErrors }) {
  const [copied, setCopied] = useState(false);
  const { platform } = state;
  const shown = showErrors ? errors : [];
  const herdr = detected?.herdr;
  const providers = detected?.providers || {};

  const set = (key, value) => patch((prev) => ({ ...prev, platform: { ...prev.platform, [key]: value } }));

  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(herdr.installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the command is on screen either way */ }
  };

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        Harbor runs your agent sessions through its own session daemon, which needs no separate
        install, and reads their transcripts from disk. Here is what it found on this machine.
        Everything is editable.
      </p>

      <div className="setup-card">
        <h2 className="setup-card-title">This machine</h2>
        <div className="sf-detect-grid">
          <Detected label="Operating system" found={Boolean(detected?.os)} value={detected?.osLabel || detected?.os} missing="Could not determine" />
          <Detected label="Home folder" found={Boolean(detected?.homedir)} value={detected?.homedir} missing="Could not determine" />
          <Detected
            label="Shared config links"
            found
            value={detected?.symlinkStyle === 'junction'
              ? 'Windows junctions for folders'
              : 'Symlinks'}
          />
        </div>
      </div>

      <div className="setup-card">
        <h2 className="setup-card-title">Herdr</h2>
        <div className="sf-detect-grid">
          <Detected
            label="herdr binary"
            found={Boolean(herdr?.found)}
            value={herdr?.path}
            missing="Not installed, or not on PATH"
          />
          <Detected
            label="Version"
            found={Boolean(herdr?.version)}
            value={herdr?.version}
            missing={herdr?.found ? 'Installed, but did not report a version' : 'Unknown until Herdr is installed'}
          >
            {herdr?.versionMatchesPin === false ? (
              <span className="sf-detect-note warn">
                Harbor is built against Herdr {herdr.pinnedVersion}. It will refuse to misbehave on a
                mismatch and show a degraded-daemon banner instead.
              </span>
            ) : null}
          </Detected>
        </div>

        {!herdr?.found && herdr?.installCommand ? (
          <div className="setup-note setup-install">
            <p>
              Not found, and that is fine: Harbor uses its own session daemon unless you set
              <code> HARBOR_SESSION_BACKEND=herdr</code>. If you want that fallback, on
              {' '}{detected?.osLabel || 'this platform'}:
            </p>
            <div className="setup-cmd">
              <code>{herdr.installCommand}</code>
              <button type="button" className="setup-btn ghost" onClick={copyInstall}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="setup-note-fine">
              Leaving this blank is a supported answer. Harbor records where herdr would be if you
              fill it in, and tells you honestly when it cannot reach that daemon.
            </p>
          </div>
        ) : null}

        <div className="setup-grid">
          <Field
            label="herdr binary path (optional)"
            error={errorFor(shown, 'herdrBin')}
            hint="Only needed for the Herdr session backend."
          >
            <PathInput
              value={platform.herdrBin}
              onChange={(value) => set('herdrBin', value)}
              placeholder="/home/you/.local/bin/herdr"
              title="Choose the folder holding herdr"
            />
          </Field>
          <Field
            label={platform.socketRequired ? 'Herdr named pipe (required)' : 'Herdr socket'}
            error={errorFor(shown, 'herdrSocket')}
            hint={platform.socketRequired
              ? 'Run herdr status server on this machine and paste the pipe it reports.'
              : 'The default is derived from your home folder; change it only if you moved it.'}
          >
            <TextInput
              value={platform.herdrSocket}
              onChange={(value) => set('herdrSocket', value)}
              mono
              placeholder={platform.socketRequired ? '\\\\.\\pipe\\herdr' : '/home/you/.config/herdr/herdr.sock'}
            />
          </Field>
        </div>

        {platform.socketRequired ? (
          <p className="setup-note-fine">
            Harbor does not guess this one. Herdr publishes no stable pipe name for Windows, and a
            guessed pipe is a daemon that never answers, so it asks instead.
          </p>
        ) : null}
      </div>

      <div className="setup-card">
        <h2 className="setup-card-title">Agent CLIs on PATH</h2>
        <div className="sf-detect-grid">
          <Detected label="claude" found={Boolean(providers.claude?.found)} value={providers.claude?.path} missing="Not on PATH" />
          <Detected label="codex" found={Boolean(providers.codex?.found)} value={providers.codex?.path} missing="Not on PATH" />
          <Detected label="cursor-agent" found={Boolean(providers.cursor?.found)} value={providers.cursor?.path} missing="Not on PATH" />
        </div>
        <p className="setup-note-fine">
          You pick which of these Harbor uses on the next two steps. A CLI that is not installed can
          be turned off, and Harbor will not pretend it is there.
        </p>
      </div>
    </div>
  );
}
