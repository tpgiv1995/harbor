import React from 'react';
import { Detected } from './controls.jsx';

// Step 1. What Harbor found, shown as findings rather than as filled-in
// defaults.
export function PlatformStep({ detected }) {
  const providers = detected?.providers || {};

  return (
    <div className="setup-pane">
      <p className="setup-lede">
        Harbor runs your agent sessions through its own session daemon, which needs no separate
        install, and reads their transcripts from disk. Here is what it found on this machine.
        Provider choices and paths remain editable on the next steps.
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
