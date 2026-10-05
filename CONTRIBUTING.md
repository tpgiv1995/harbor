# Contributing to Harbor

Describe the user-visible problem, reproduce it, and keep each change focused.
Read [CLAUDE.md](CLAUDE.md) for development rules and the relevant subsystem
guide under [docs/claude](docs/claude/). Installation help belongs in
[AGENTS.md](AGENTS.md).

## Build and check

Use Node 22.12.0 or newer; CI uses Node 24. PowerShell, with your checkout path:

```powershell
Set-Location 'C:\src\harbor\app'
npm ci
npm run build
npm test -- --exclude daemon --exclude bin
```

Bash users can run the same npm commands after `cd /path/to/harbor/app`.
The excluded daemon and CLI integration families need separate prerequisites
and isolated stores. A unit pass does not establish GUI or installer behavior.

Use a disposable checkout for tests. Keep HOME/USERPROFILE, userData, context,
daemon directory and socket in fixture locations. Set `HARBOR_NO_DAEMON_START=1`
unless a harness explicitly starts and owns its own isolated daemon. Do not
enable real signals or run existing drive scripts against a working session
store. Several older drives still need an isolation review.

For visual changes, use [the capture guide](docs/VISUALS.md). Inspect the real
rendered result, including empty and error states affected by the change. On a
live workstation automation must keep every window hidden and must not focus,
maximize or restack it. Stop only processes the harness started and confirm
they have exited.

## Pull requests

Explain the trigger, resulting behavior and relevant proof. Include exact test
commands and any limits. Add a regression test when it demonstrates the failure;
avoid tests that only repeat the implementation. Use synthetic data in fixtures
and screenshots. Do not include account files, transcripts or credentials.

Commit only the files and changes you own. Update documentation when commands,
configuration or visible behavior change. Write plain imperative commit messages.
Keep formatting and dependency updates separate from unrelated fixes.

For bugs, include the OS, Node version, commit, reproduction steps and expected
versus observed behavior. Never attach a crash dump (.dmp) to a public issue
or pull request: it is a raw snapshot of process memory and can carry secrets,
tokens or transcript content a log never would. [Security concerns](SECURITY.md)
use a separate path.
