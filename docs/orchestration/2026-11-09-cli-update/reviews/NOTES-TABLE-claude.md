# Claude Code 2.1.316 to 2.1.321: notes table (C1 to C435)

Source: `docs/orchestration/2026-11-09-cli-update/notes-claude.md` (2.1.321 = C1 to C118, 2.1.319 = C119 to C264, 2.1.318 = C265 to C348, 2.1.317 = C349 to C435; npm published no 2.1.320). Scratch binary 2.1.321 is 346,487,456 bytes.

## Binary-wide scans

| Scan | Result |
|---|---|
| Model ids via `createModelCatalog().refresh()` with `seedIds: []` | 19 in 2.1.316, 20 in 2.1.321 (adds `claude-fable-5-2`). |
| Registered slash commands | 100 to 102; adds `/project` (behind a server flag) and `/use-case` (Life Sciences). Neither is offered by Harbor. |
| `--help` | Identical. |
| Harbor screen literals (1,171 extracted) | 0 left the binary. |
| Status line payload (documented schema, old vs new) | No field added or removed; usage-tee tests pass. |
| Env vars | 72 added, 6 removed. None is set on this machine; none removed is read by Harbor. |
| `type:"..."` strings | 12 added, `file_unchanged` removed. None is matched by Harbor (grep). |

## Touching notes

| Notes | Contract | Conclusion | Change | Proof |
|---|---|---|---|---|
| C1 | Models: seed, discovery, alias, menus | Fable 5.2 ships in the binary (catalog: 1M context, default effort medium, `fast_mode`, `rejects_disabled_thinking`). `fable` alias and `latest_per_family` resolve to it. Seed lagged. | Seed gains Fable 5.2; spec pins family order, label, flagship | `npm test -- model-catalog` 15/15; real scan 20 ids (19 + 5.2); hidden desktop menu `proofs/fable-menu`; phone drive; paid probe (`proofs/fable-paid-probe.json`): both id and alias return `claude-fable-5-2`, firstParty |
| C96 | Saved model pick migration | Runs only when `userSettings.model` is `claude-fable-5-1` (or `[1m]`). All seven homes hold `claude-opus-5-5`, so it is a no-op here. | none | binary read of `migration_fable51_to_fable_alias`; settings audit of 7 homes |
| C76, C221 | `/model` picker, Harbor question card | Older models move under an unnumbered "More models" row. Harbor parses the numbered rows (5 options, was 8 of a longer list); numbering of those rows is unchanged. Older models stay reachable from Harbor's Session configuration and by id. | none | `scripts/probe-slash-dialogs-win.js` on both builds: `proofs/slash-new`, `proofs/slash-old` |
| C97, C36 | Fast mode | Labels and fallback only. Harbor reads neither. | none | literal scan |
| C4, C5, C6, C56, C111, C174, C196 | Permission checks: when a card appears | Move commands between asking and not asking; card layout unchanged. | Chip `ask-dialog` widened for C6, C56, C111 (the rest already raised it) | `proofs/pre321-perm-bash.txt` |
| C272 | Permission prompt key guard (`armInputGrace`) | Keys typed right after a send or before a slow prompt no longer answer it. Harbor answers cards on a click; its automatic answers (resume dialog, /model cache warning) both still land. | none | `proofs/pre321-prompt-gate.txt`, `pre321-resume-hooks.txt`, `pre321-ask-sheet.txt` |
| C24, C25, C61, C66, C234, C351 | Hooks | Harbor's lane returns allow/deny decisions and steps aside; no `ask` or `defer`. PostToolUse style lint finishes inside 10 s. | none | `proofs/pre321-ask-hook-bypass.txt`, `-default.txt`; `npm test -- harbor-ask-hook` |
| C103 | AskUserQuestion answer | Refuses a host answer that sets `afkTimeoutMs`. `bin/harbor-ask-hook` never sets it (grep). | none | grep; ask-hook proofs |
| C112 | Background notices | Long command text is shortened in the notice. `background-tasks.js` takes the command from the tool input and reads only id, status, summary and event from the notice. | none | `npm test -- background` 8/8; source read |
| C20, C18, C82, C210 | Background work under `-p` | Message and report fixes. The timeout itself is still `BASH_MAX_TIMEOUT_MS` (8 h in master env). | none | binary read |
| C233, C366 | `/loop` | A self-paced loop now ends when a turn finishes without rescheduling. Fold unchanged. `CLAUDE_CODE_LOOP_KEEPALIVE=1` restores the old behaviour; left unset. | none | source read; doctrine note |
| C114, C350 | Account email check | 2.1.317 asked on every network word and denied headless workers. 2.1.321 denies only a shell command holding the plan email AND naming a User-Agent, and never prompts. The 2026-11-04 plan to switch it off is no longer needed. | Chip flag `tool-refusal` | binary read of `namesUserAgentWithAddress`; verbatim spec |
| C81, C90, C100 | Windows program lookup | Relative, UNC and network-link PATH entries are skipped. The real PATH (47 entries) has none. Hooks and git ran in every proof on 2.1.321. | Chip flag `windows-launch` | PATH audit; all proofs |
| C418, C417 | Windows temp paths; working-folder check | Scratchpad folder is hashed; it still matches `WIN_SCRATCHPAD_RE`. C417 changes whether any tool runs at all on some volumes. | Chip flags `temp-paths`, `windows-launch` | `npm test -- artifacts` 29/29 |
| C158, C273 | Config files | No home holds a second config file, so no stderr warning appears. | Chip `claude-json` widened | audit of 7 homes |
| C159, C212, C304, C307, C308, C309, C311, C319, C157, C374, C373 | Config and settings durability | Safer saves; edits to settings soon after a write now apply (helps the sync). Invalid `.claude.json` now fails a headless start instead of being replaced. | none | note read |
| C375 | Retention cleanup | Transcripts are kept permanently. A run ignoring user settings still skips cleanup (`user_source_disabled`), and all 7 homes set `cleanupPeriodDays: 36500`. | none | binary read old and new |
| C268, C269, C310 | Login expiry | Titler ignores stderr on exit 0. The probe returned the sign-in expiry for one plan; Pat was told separately. | none; reported to Pat | `proofs/fable-paid-probe.json` |
| C285 | Titler transcript disposal | A deleted transcript is no longer re-created when a headless session exits. Helps `discardTitleTranscript`. | none | note read |
| C280, C383, C387 | Compaction | Upstream fixes; the boundary record is unchanged. | none | `npm test -- transcript` 180 pass, 2 skipped |
| C141 | Slash commands with leading space | Harbor trims before sending. | Chip `composer` widened | verbatim spec |
| C144 | `-p` exit code in auto mode | Workers default to bypass; an exit of 1 is the honest result. | none | claude-worker read |
| C121, C122, C137 | MCP tasks | No local server advertises tasks. Unverified for claude.ai connectors; a task would appear as an ordinary background task. | none | note read |
| C326, C32, C26 | Dialogs | `/permissions` classified the same on both builds; the rest are fixes. | none | slash probe |
| C413, C321 | Subagent model and effort | `CLAUDE_CODE_SUBAGENT_EFFORT=high` and the Sonnet pin still decide. | none | master env read |
| C416 | Read stub removed | Re-reads now cost full tokens. Usage only. | Chip flag `usage` (widened after the first review found it raised nothing) | `npm test -- cli-updates` verbatim spec |
| C52 | Memory while reading transcripts | Upstream fix; nothing Harbor reads. | none | note read |

## No-contact notes (367)

Each was read and touches no Harbor contract (cloud sessions, VS Code, gateway, self-hosted runner, Remote Control, Claude Tag, macOS or Linux only, or an upstream fix to a surface Harbor does not read):

C2, C3, C7, C8, C9, C10, C11, C12, C13, C14, C15, C16, C17, C19, C21, C22, C23, C27, C28, C29, C30, C31, C33, C34, C35, C37, C38, C39, C40, C41, C42, C43, C44, C45, C46, C47, C48, C49, C50, C51, C53, C54, C55, C57, C58, C59, C60, C62, C63, C64, C65, C67, C68, C69, C70, C71, C72, C73, C74, C75, C77, C78, C79, C80, C83, C84, C85, C86, C87, C88, C89, C91, C92, C93, C94, C95, C98, C99, C101, C102, C104, C105, C106, C107, C108, C109, C110, C113, C115, C116, C117, C118, C119, C120, C123, C124, C125, C126, C127, C128, C129, C130, C131, C132, C133, C134, C135, C136, C138, C139, C140, C142, C143, C145, C146, C147, C148, C149, C150, C151, C152, C153, C154, C155, C156, C160, C161, C162, C163, C164, C165, C166, C167, C168, C169, C170, C171, C172, C173, C175, C176, C177, C178, C179, C180, C181, C182, C183, C184, C185, C186, C187, C188, C189, C190, C191, C192, C193, C194, C195, C197, C198, C199, C200, C201, C202, C203, C204, C205, C206, C207, C208, C209, C211, C213, C214, C215, C216, C217, C218, C219, C220, C222, C223, C224, C225, C226, C227, C228, C229, C230, C231, C232, C235, C236, C237, C238, C239, C240, C241, C242, C243, C244, C245, C246, C247, C248, C249, C250, C251, C252, C253, C254, C255, C256, C257, C258, C259, C260, C261, C262, C263, C264, C265, C266, C267, C270, C271, C274, C275, C276, C277, C278, C279, C281, C282, C283, C284, C286, C287, C288, C289, C290, C291, C292, C293, C294, C295, C296, C297, C298, C299, C300, C301, C302, C303, C305, C306, C312, C313, C314, C315, C316, C317, C318, C320, C322, C323, C324, C325, C327, C328, C329, C330, C331, C332, C333, C334, C335, C336, C337, C338, C339, C340, C341, C342, C343, C344, C345, C346, C347, C348, C349, C352, C353, C354, C355, C356, C357, C358, C359, C360, C361, C362, C363, C364, C365, C367, C368, C369, C370, C371, C372, C376, C377, C378, C379, C380, C381, C382, C384, C385, C386, C388, C389, C390, C391, C392, C393, C394, C395, C396, C397, C398, C399, C400, C401, C402, C403, C404, C405, C406, C407, C408, C409, C410, C411, C412, C414, C415, C419, C420, C421, C422, C423, C424, C425, C426, C427, C428, C429, C430, C431, C432, C433, C434, C435

Coverage: 68 touching + 367 no-contact = 435 of 435, no duplicates.

## Flagged no-contact notes (139)

The chip's patterns are deliberately broad. Of the 367 no-contact notes, 139 raise a flag. Each was read against the contract that flag names. Grouped by first flag:

| Flag | Notes | Why there is no contact |
|---|---|---|
| `agents-view` | C46, C60, C83, C170, C183, C184 | The `claude agents` screen. Harbor never runs it in a pane. |
| `ask-dialog` | C70, C95, C110, C123, C164, C165, C182, C198, C231, C302, C347, C363, C431 | Cloud, Tag, VS Code or notebook paths, plus C198, the same family as C4 and C5: a check moving, no card changing. C123 is a new setting no home sets. |
| `auto-update` | C318 | Plugin updates or retry timing. Every home keeps CLI auto-update off. |
| `background-tasks` | C37, C135, C180, C193, C258, C349, C369, C378, C412, C433 | Cloud `/schedule`, `/loop` notes and `/clear` task survival. C37, C412 and C180 keep the launch result and task-notification text `background-tasks.js` matches (none of those literals left the binary). |
| `bypass-mode` | C12, C94, C227, C251, C399 | `/config`, `claude agents`, mods, Monitor and VS Code. Harbor sets the mode with launch flags, and those were re-proven by the permission drives. |
| `compaction` | C16, C381, C423 | Remote Control, gateway and VS Code. No compaction record Harbor reads changed. |
| `composer` | C259, C284, C400 | Cloud and headless paths. C400 stops Ctrl+C at the prompt from ending background agents, which only removes a side effect. |
| `footprint` | C19, C35, C116, C200, C384 | Upstream memory, sandbox and reload fixes; nothing Harbor stores or reads changes size or place. |
| `hooks` | C13, C23, C101, C191, C199, C293, C303, C332 | Cloud, runner and Desktop paths, telemetry, or a single fix to a hook Harbor does not use. Harbor's own hook lanes passed `ask-hook` (bypass and default) and `resume-hooks`. |
| `mcp` | C3, C33, C49, C57, C71, C106, C136, C222, C225, C278, C313, C327, C358, C385, C421, C430 | MCP client fixes, gateway and cloud policy. Harbor reads no MCP screen; the portal and lazy shim are plain stdio servers. |
| `model` | C39, C130, C217, C267, C429 | Gateway warnings, text contrast, a mod option and VS Code. Harbor reads `/model` rows as text, and those are unchanged. |
| `plugins` | C14, C17, C27, C64, C67, C92, C98, C104, C108, C118, C168, C169, C171, C173, C208, C209, C224, C232, C276, C277, C368, C372, C414, C415 | Marketplace, mod and plugin-command fixes. Plugins here are one junction shared across homes and Harbor reads only the slash-command list, which gained two commands Harbor does not offer. |
| `screen` | C131, C203, C241, C333 | Gateway and runner warnings and a link-wrap fix; none is a screen Harbor parses. |
| `settings` | C2, C120, C197, C201, C226, C228, C242, C352 | Remote Control, gateway and managed-settings keys. Harbor writes none of them, and the per-home `settings.json` keys it does own are unchanged. |
| `statusline` | C185, C419 | Gateway spend display. The status-line schema is unchanged (`tools/statusline.cjs`). |
| `transcript` | C68, C69, C153, C156, C207, C270, C282, C283, C298, C328, C357, C395, C396, C403, C404, C408 | `-p`, cloud and runner paths, or text the CLI writes to itself. The record kinds Harbor parses are unchanged (proofs `perm-bash`, `resume-hooks`). C207 only adds a warning to a command Harbor does not send. |
| `trust` | C87, C312 | TLS start-up time and network file systems. |
| `usage` | C15, C322, C323, C370 | Estimates, Bedrock and screen readers. C322 extends to other providers a move these plans already had; the worker hook only inspects the launch parameter, so an automatic move never reaches it, and workers are not background subagents. |
| `usage-limit` | C7, C187, C281, C315 | Enterprise seats, Remote Control and a repeated notice. The usage-limit menu rows Harbor reads did not change (1,171-literal scan: none left the binary). |
