# Linux setup

Linux was the original development platform. The old end-to-end observations are
[archived](HISTORY.md); they are not evidence that this revision passes on Linux.

Install Node 22.12.0 or newer, Git, and the provider CLIs you plan to use. Sign in
to the CLIs, then run these Bash commands in your checkout:

```bash
cd /path/to/harbor/app
npm ci
npm run build
npm start
```

Complete the first-run wizard. Harbor uses its own session daemon; no alternative
backend needs installing. Configuration is `~/.harbor/config.json`.

See [Configuration](../../docs/CONFIGURATION.md), [Contributing](../../CONTRIBUTING.md)
and [Packaging](../../docs/PACKAGING.md). Native PTY builds may require your
distribution's compiler toolchain. Packaging and a real desktop session need
validation on the target distribution. The Linux screenshot path retains
`xvfb-run`, with hidden Electron windows as an additional requirement.
