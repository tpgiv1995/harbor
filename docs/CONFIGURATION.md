# Configuration

Harbor keeps one JSON file. The setup wizard writes it, and hand-editing it is
supported: everything below is a real key with a real consumer, and Harbor
validates the file on load rather than trusting it.

## Where it lives

| Platform | Path |
| --- | --- |
| Linux | `~/.config/harbor/config.json` (or `$XDG_CONFIG_HOME/harbor/config.json`) |
| Windows | `%APPDATA%\harbor\config.json` |
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
  "platform":  { "os": "linux", "herdrBin": "...", "herdrSocket": "...", "shell": "..." },
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
| `projectsDir` | `~/.claude/projects` | Where Claude Code writes transcripts. Harbor only ever reads this. |
| `cacheDir` | `~/.cache/harbor` | Session index, titles, model catalog, artifact thumbnails. Safe to delete. |
| `delegateStateDir` | `~/.local/state/claude-delegate` | Where a delegation queue CLI keeps its queues. Only used by the Orch view. |
| `binDir` | `~/.local/bin` | Where Harbor looks for user-installed helpers. |
| `projectIconsDir` | `<userData>/project-icons` | Drop an image named after a project label to replace its coloured dot. |
| `tasksFile` | `<userData>/tasks.json` | The Tasks view's document, also driven by `bin/harbor-tasks`. |

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

Optional and off unless you turn it on. The Orch view needs a **delegation queue
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

`model` is an **alias** (`opus`, `sonnet`, `haiku`), never a dated model id, so
the CLI resolves the current flagship and a new release needs no change here.
`"default"` means the provider's own default and passes no flag at all.

## Settings that are environment variables, not config keys

A few things are deliberately not in `config.json`, and the most important one
is which session daemon drives your ptys:

| Variable | Meaning |
| --- | --- |
| `HARBOR_SESSION_BACKEND` | `sessiond` (the default, Harbor's own daemon, no separate install) or `herdr` (the fallback, needing Herdr 0.7.4). Any other value refuses to start. |
| `HARBOR_CONFIG_FILE` | Use this config file instead of the platform default. |
| `HARBOR_CLAUDE_BIN` / `HARBOR_CODEX_BIN` / `HARBOR_CURSOR_BIN` | Pin a provider binary, outranking `providers.<id>.bin`. |
| `HARBOR_NO_TRUST_PREACCEPT` | Set to `1` to stop Harbor pre-accepting Claude Code's per-folder trust dialog, and answer it by hand instead. |
| `HARBOR_PROJECT_ICONS_DIR`, `HARBOR_TASKS_FILE` | Relocate the icon folder or the task document, outranking `paths.*`. |

`HARBOR_SESSION_BACKEND` is an environment variable rather than a setting on
purpose: switching it is not seamless. It drops every live pty (conversations
are unaffected, since those live in the transcripts, and dead sessions resume by
id), so it is "restart Harbor, reopen your sessions from the rail" rather than a
toggle, and the setup wizard does not offer it for that reason.

The phone server's own variables are in [`../setup/mobile.md`](../setup/mobile.md).

## `~/.config/harbor/.env`: the two optional OpenAI features

Live voice mode and voice-to-draft dictation call OpenAI, because Anthropic
publishes no speech API. Both are **off unless you supply a key**, and neither
is needed for anything else in Harbor.

The key is read from `OPENAI_API_KEY` in the environment, and failing that from
a `.env` file beside your config:

```
~/.config/harbor/.env            # %APPDATA%\harbor\.env on Windows
```

```sh
OPENAI_API_KEY=sk-...
```

That is the whole format: `KEY=value` lines, and only `OPENAI_API_KEY` is read
from it. With no key, the mic and the live-voice bar report "OpenAI key
unavailable" and everything else works normally. `HARBOR_NO_VOICE=1` disables
live voice outright regardless of the key, and is set automatically under the
test harness so a suite can never open a real (billable) voice call.

Session titling is a separate, similarly optional feature that reads
`ANTHROPIC_API_KEY`, from the environment or from
`~/.config/harbor/titler.env`. Without it, sessions keep their untitled rail
labels.

## Validation

On load Harbor asserts: the file is an object, `version` is 1, `profiles` is a
non-empty list, every profile has a unique non-empty `id` plus `label`,
`letter`, `color`, `provider` and `configHome`, `email` is a string or null,
`isDefault` is a boolean, and `workflows` is a list whose entries have ids. A
failure names the field.

Anything not listed above is merged over the shipped defaults, so an older file
missing new keys keeps working.
