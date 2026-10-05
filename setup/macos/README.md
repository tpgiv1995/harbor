# macOS validation checklist

Harbor has not been validated on real Mac hardware. A generated package or a
passing test with an injected platform adapter does not establish desktop support.
The [historical checklist](HISTORY.md) is retained as context only.

On a test Mac with Node 22.12.0 or newer, Git and signed-in provider CLIs:

```bash
cd /path/to/harbor/app
npm ci
npm run build
npm test -- --exclude daemon --exclude bin
npm start
```

Record the macOS version, architecture, checkout commit and result of each check:

1. Dependency installation completes, including native PTY dependencies.
2. The desktop opens without a renderer error.
3. The wizard discovers installed CLIs and writes the selected profiles.
4. Configuration appears at `~/Library/Application Support/harbor/config.json`.
5. Harbor's own session daemon starts when needed.
6. Each installed provider can start a session in a disposable project.
7. Input, output, close and resume work for those sessions.
8. Agents, Tasks, Orch, Files, Notes and Board render and persist their data.
9. A second desktop start reconnects without duplicate sessions.
10. The phone client works over an explicitly configured connection.
11. A locally built installer opens and behaves as expected; record signing and
    Gatekeeper prompts. Signing and notarization are not supplied by the workflow.

Use [Configuration](../../docs/CONFIGURATION.md), [mobile setup](../mobile.md)
and [Packaging](../../docs/PACKAGING.md) for the relevant settings. Do not run
old backend setup commands from the archived checklist.
