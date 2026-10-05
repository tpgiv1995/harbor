# Configuration

Harbor keeps one JSON file. The setup wizard writes it, and hand-editing it is
supported: everything below is a real key with a real consumer, and Harbor
validates the file on load rather than trusting it.

## Where it lives

| Platform | Path |
| --- | --- |
| Linux | `~/.config/harbor/config.json` (or `$XDG_CONFIG_HOME/harbor/config.json`) |
| Windows | `%USERPROFILE%\.harbor\config.json` (deliberately outside `%APPDATA%`, which MSIX-containerised launchers virtualize per-launcher, so a file there is not one file for every reader) |
| macOS | `~/Library/Application Support/harbor/config.json` |

`HARBOR_CONFIG_FILE` overrides the path entirely. The desktop app and the
command line tools in `bin/` resolve it through the same rule, on purpose: two
copies of that logic would eventually disagree, and the failure mode is a CLI
confidently editing a different file from the one the app is showing.

If the file cannot be parsed, Harbor does **not** overwrite it. It copies the
unreadable file aside as `config.json.corrupt-<timestamp>`, falls back to
derived defaults in memory, and logs where the copy went.

## Top-level shape

```jsonc
{
  "version": 1,
  "setup":     { "completed": true, "completedAt": "...", "appVersion": "..." },
  "platform":  { "os": "linux", "shell": "..." },
  "profiles":  [ /* see below, at least one */ ],
  "providers": { "claude": {...}, "codex": {...}, "cursor": {...} },
  "paths":     { /* all optional, all derived when null */ },
  "workflows": [ /* quick commands, ships empty */ ],
  "orchestration": { "enabled": false, "launcher": "...", "researchCommand": "...", "executionCommand": "...", "stateDir": null },
  "newSessionDefaults": { "provider": "claude", "model": "opus", "effort": "xhigh" }
}
```

## `profiles`: your plans and accounts

A profile is one account. For Claude that means one **config home**: a directory
holding that account's `.claude.json`, conventionally `~/.claude` plus any
`~/.claude-<suffix>`. Harbor discovers these by scanning; it ships no account
list of anybody's.

```jsonc
{
  "id": "personal",              // config key and rail selector: [a-z0-9][a-z0-9-]*
  "label": "Personal",           // display only
  "letter": "P",                 // rail badge, must be unique across profiles
  "color": "#6fa8d8",            // rail badge colour, #rrggbb
  "provider": "claude",          // claude | codex | cursor
  "configHome": "/home/you/.claude",
  "email": null,                 // read back from the account, display only
  "isDefault": false             // exactly one profile should be true
}
```

The `id` is derived from the directory name (`.claude` becomes `personal`,
`.claude-work` becomes `work`), but it is yours to rename in the wizard and
nothing about the rest of Harbor depends on a particular value. Renaming a
profile does not move any files; it only changes what Harbor calls that account.

An account travels to the launcher as its **config home**, which becomes
`CLAUDE_CONFIG_DIR` on the child process. There are no per-account command line
flags.

## `providers`

```jsonc
"providers": {
  "claude": { "enabled": true, "bin": "claude" },
  "codex":  { "enabled": true, "bin": "codex" },
  "cursor": { "enabled": true, "bin": "cursor-agent" }
}
```

`bin` may be a bare name resolved on `PATH` or an absolute path. Precedence at
launch is `HARBOR_CLAUDE_BIN` / `HARBOR_CODEX_BIN` / `HARBOR_CURSOR_BIN`, then
this value, then the conventional name. Setting `enabled: false` removes that
provider from every menu.

## `paths`

Every entry may be `null`, in which case Harbor derives it. Set one only to move
something.

| Key | Default | What it is |
| --- | --- | --- |
| `projectsDir` | `~/.claude/projects` | Where Claude Code writes transcripts. Explicit rail deletion moves selected transcripts to trash; optional shared-config setup can replace a backed-up directory with a link. |
| `cacheDir` | `~/.cache/harbor` | Session index, titles, model catalog, artifact thumbnails. Safe to delete. |
| `delegateStateDir` | `~/.local/state/claude-delegate` | Where a delegation queue CLI keeps its queues. Only used by the Orch view. |
| `binDir` | `~/.local/bin` | Where Harbor looks for user-installed helpers. |
| `projectIconsDir` | `<userData>/project-icons` | Drop an image named after a project label to replace its coloured dot. |
| `tasksFile` | `<userData>/tasks.json` | The Tasks view's document, also driven by `bin/harbor-tasks`. |

| `notesFile` | `<userData>/notes.json` | Notes, shared with `bin/harbor-notes`. |
| `boardsDir` | `<userData>/boards` | Whiteboards, shared with `bin/harbor-board`. |

## `workflows`: quick commands

Ships **empty**, and that is deliberate: a workflow is a slash command that
exists in your config home, so there is no default that is right for two
different people. The wizard's Commands step reads your real skills and slash
commands and lets you pick which appear as quick commands.

```jsonc
{
  "id": "acclimate",
  "label": "/acclimate",
  "command": "/acclimate",
  "cwd": "current",       // "current" or an absolute path
  "profile": "current",   // "current" or a profile id
  "provider": "current",
  "model": "current",     // "current", or a model id to pin
  "effort": "current"
}
```

Pin `model` on anything that fans work out to sub-agents. `"current"` means the
session's own model, which for a bulk job is usually the expensive one.

## `orchestration`

Optional. The schema default is enabled, while the first-run wizard enables it
only when it detects the companion CLI. The Orch view needs a **delegation queue
CLI that Harbor does not ship** (see [`COMMANDS.md`](COMMANDS.md)); the wizard
looks for one on `PATH` and defaults the view off when it finds none.

| Key | Meaning |
| --- | --- |
| `enabled` | Whether the Orch tab appears at all. |
| `launcher` | The command that starts an agent session for a kickoff. Defaults to Harbor's own `bin/ai`. |
| `researchCommand` | The slash command sent into the research pane. |
| `executionCommand` | The slash command sent into the execution pane. |
| `stateDir` | Where the queue CLI keeps its queues; defaults to `paths.delegateStateDir`. |

The two commands ship in this repository under `.claude/commands/`. Rename them
here if yours are called something else.

## `newSessionDefaults`

What a fresh session launches with, before you change it in the popover.

```jsonc
{ "provider": "claude", "model": "opus", "effort": "xhigh" }
```

For Claude, prefer a family alias such as `opus`, `sonnet` or `haiku` so the
CLI resolves the current family version. Codex and Cursor use their own model
identifiers. `"default"` selects the provider default and omits the model flag.

## Settings that are environment variables, not config keys

These overrides are environment variables. The only supported backend is
Harbor's own session daemon, `sessiond`.

| Variable | Meaning |
| --- | --- |
| `HARBOR_SESSION_BACKEND` | Unset or `sessiond`. Any other value is rejected. |
| `HARBOR_CONFIG_FILE` | Use this config file instead of the platform default. |
| `HARBOR_CLAUDE_BIN` / `HARBOR_CODEX_BIN` / `HARBOR_CURSOR_BIN` | Pin a provider binary, outranking `providers.<id>.bin`. |
| `HARBOR_NO_TRUST_PREACCEPT` | Set to `1` to stop Harbor pre-accepting Claude Code's per-folder trust dialog, and answer it by hand instead. |
| `HARBOR_PROJECT_ICONS_DIR`, `HARBOR_TASKS_FILE`, `HARBOR_NOTES_FILE`, `HARBOR_BOARDS_DIR` | Relocate the corresponding store, outranking `paths.*`. |

There is no backend-switching procedure. An ordinary GUI restart leaves the
separate session keeper processes running.

The phone server's own variables are in [`../setup/mobile.md`](../setup/mobile.md).

## `~/.config/harbor/.env`: the two optional OpenAI features

Live voice mode and voice-to-draft dictation call OpenAI, because Anthropic
publishes no speech API. Both are **off unless you supply a key**, and neither
is needed for anything else in Harbor.

The key is read from `OPENAI_API_KEY` in the environment, and failing that from
the following home-relative `.env` file on every OS (it is not beside the
normal Windows config):

```
~/.config/harbor/.env
# Windows: %USERPROFILE%\.config\harbor\.env
```

```sh
OPENAI_API_KEY=sk-...
```

That is the whole format: `KEY=value` lines, and only `OPENAI_API_KEY` is read
from it. With no key, the mic and the live-voice bar report "OpenAI key
unavailable" and everything else works normally. `HARBOR_NO_VOICE=1` disables
live voice outright regardless of the key, and is set automatically under the
test harness so a suite can never open a real (billable) voice call.

Session titling uses the signed-in Claude CLI with the `haiku` alias and
consumes that account's plan usage. The child strips API-key variables; it does
not need `ANTHROPIC_API_KEY` or a `titler.env` file. Set `HARBOR_NO_TITLER=1`
to disable automatic titles.

## Validation

On load Harbor asserts: the file is an object, `version` is 1, `profiles` is a
non-empty list, every profile has a unique non-empty `id` plus `label`,
`letter`, `color`, `provider` and `configHome`, `email` is a string or null,
`isDefault` is a boolean, and `workflows` is a list whose entries have ids. A
failure names the field.

Anything not listed above is merged over the shipped defaults, so an older file
missing new keys keeps working.

## Reopen or reset setup

Use **Setup wizard** in the app menu. Deleting config alone is unreliable:
existing install markers can cause migration to mark setup complete.

If the menu is unreachable, close Harbor normally, back up the resolved config
and set `setup.completed` to `false`. Keep the profiles and paths. For the
normal Windows location, in PowerShell:

```powershell
$configPath = Join-Path $env:USERPROFILE ".harbor\config.json"
Copy-Item -LiteralPath $configPath -Destination ($configPath + ".backup-" + (Get-Date -Format yyyyMMdd-HHmmss))
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config.setup.completed = $false
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
```

Use your `HARBOR_CONFIG_FILE` path instead if configured, then reopen Harbor.
This resets setup state without deleting session histories or documents.
