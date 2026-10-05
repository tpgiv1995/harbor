# Windows setup

Use Node 22.12.0 or newer, Git and the coding-agent CLIs you intend to use.
Sign into those CLIs first. Harbor uses your signed-in subscriptions.

PowerShell, replacing the checkout path:

```powershell
Set-Location 'C:\src\harbor\app'
npm ci
npm run build
npm start
```

The setup wizard detects providers and creates account profiles. Review executable
paths, account homes and defaults before finishing. Harbor's own session daemon
is the only supported session backend. It starts when the desktop needs it.

Configuration lives at `$HOME\.harbor\config.json`, not under APPDATA.
To revisit the wizard, preserve the configuration and set `setup.completed` to
`false`; [Configuration](../../docs/CONFIGURATION.md#reopen-or-reset-setup)
has a backup and reset example. Deleting the file can trigger legacy import.

For development, run `npm run dev` from the same app directory. It launches Vite
with Node and Electron directly, so it does not depend on spawning a .cmd shim.
This ordinary interactive command opens the desktop window. Automation on a live
desktop must use the hidden [visual capture harness](../../docs/VISUALS.md).

The [README](../../README.md) documents the six views, provider differences,
phone setup and troubleshooting. [Contributing](../../CONTRIBUTING.md) gives
the selected unit checks. CI is configured on Windows; this document does not
assert the latest hosted run is green. Packaged installers are unsigned.

[Historical port notes](HISTORY.md) record earlier observations and retired steps.
