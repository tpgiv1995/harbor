# Orchestration Panel - Dev Notes

## What this is

Per-project orchestration panel. Reachable by clicking "Orch" on any project
group header in the sidebar. Renders the claude-delegate queue for that
project's workspace, named workers, and kickoff actions (Research / Execute).

## Dry-run mode

Set `CLAUDE_DELEGATE_DRY_RUN=1` in the environment before launching the app
to prevent real session creation during manual testing:

```
CLAUDE_DELEGATE_DRY_RUN=1 npm start
```

In this mode, the kickoff buttons send the exact IPC calls but the main
process handler skips the session daemon spawn and returns a fake result.
Add the guard in `app/src/main/index.js` `orchestration:kickoff-research`
and `orchestration:kickoff-execute` handlers if you need this for manual
testing sessions.

## Sandbox fixture

`app/test/fixtures/orch-sandbox/` is a throwaway directory used only as
a project root in tests. Its sha1 hash determines the queue file path:

```
/home/you/.local/state/claude-delegate/queues/<hash>.json
```

Tests write a 2-batch toy queue there and delete it in teardown. This
file is in the REAL delegate state directory but keyed to a path no
real workspace uses, so it does not interfere with live orchestration.

Run the sandbox tests in isolation:

```
node --test app/test/actions/orchestration.test.js
```

## Kickoff command format

`claude-go` was an unshipped wrapper that lived only on the author's PATH.
Harbor now invokes the real Claude CLI directly
(`claude --dangerously-skip-permissions`) through its own launcher,
`bin/ai`, which takes `--home <PROFILE|CONFIG_HOME>` rather than a
per-account flag (there is no `--team`/`--personal`/etc. any more; an
account is a config home, and a config home is a path).

Research:
```
bin/ai --here --home <CONFIG_HOME> '/orchestrate-research <goal>'
```

Execute:
```
bin/ai --here --home <CONFIG_HOME> '/orchestrate-execution'
```

`--here` tells `bin/ai` to run in the pane it was launched into rather than
opening a new one (see `launcherFlags` in `actions/orchestration.js`, which
only adds `--here` when the launcher basename is `ai`). `<CONFIG_HOME>` is
the default profile's `configHome` (convention for the interactive
orchestrator). The command is spawned directly in a new sessiond pane, so it
remains visible and controllable in Harbor.
