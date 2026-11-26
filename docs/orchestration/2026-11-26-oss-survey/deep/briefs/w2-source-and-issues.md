# Brief W2: read competitors' source code and their users' top issues (GitHub API)

Read C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\briefs\_context.md first.

GitHub API: unauthenticated calls are rate-limited. Use an authenticated call by reading the token from git's credential store INSIDE the command, never printing it, for example:
  GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')" gh api repos/OWNER/REPO/issues?state=all\&sort=comments\&per_page=50
Never echo, log or write the token anywhere. Read-only API calls only: never create, comment on, star or modify anything on GitHub. Read source files with `gh api repos/OWNER/REPO/contents/PATH` (base64 content) or WebFetch on raw.githubusercontent.com URLs; use `gh api search/code` to find where a mechanism lives. Do NOT use the mcp__chrome__* tools (another helper is using the browser).

Part 1, source: for these open-source projects, find and read the code that implements each mechanism, and describe exactly how it works (file path + permalink, key functions, data formats, edge cases they handle), so Harbor can copy the approach:
- Orca (stablyai/orca): session-history search index ("search inside sessions"), cost/usage calculation and price table, automations scheduler (cron/RRULE, precheck, missed runs), Rewind, needs-you/agent home, how it reads OSC 7501 and hooks.
- Parallel Code (johannesjo/parallel-code): electron/agent-hooks/* (status reducer, hook injection per CLI, turn watch), its arena/best-of-N, its review comments flow.
- T3 Code (pingdotgg/t3code): provider adapters (how it drives Claude, Codex app-server, Cursor ACP, agy), diff/review UI, usage-limit queue hold.
- Paseo (getpaseo/paseo): daemon and relay design, PR watch, per-turn cost stats.
- Superset/Paradev (superset-sh/superset): terminal daemon (output vs control sockets, cold restore, headless xterm snapshot), the "most recent N terminals live" memory cap, port scan.
- Emdash (generalaction/emdash): lifecycle hooks written into agent config, LSP editor, PR flow.

Part 2, issues: for each repo above plus claude-squad, ccmanager, agent-deck, Happy (slopus/happy) and Vibeyard, pull the 30 most-commented and the 30 most-reacted issues (open and closed). Summarise the recurring user pain points and feature requests across all of them (count how many repos raise each), with issue links. These are what users of tools like Harbor actually want.

Part 3: check Windows-specific issues in those repos (search titles for windows, conpty, powershell, wsl) and list the bugs and fixes that would apply to Harbor.

Write the report to: C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\W2-source-and-issues.md
