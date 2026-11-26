# Brief W5: sweep every project in the big lists, not just the famous ones

Read C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\briefs\_context.md first. Do NOT use the mcp__chrome__* tools (another helper is using the browser); use WebFetch, WebSearch and the GitHub API (read the token from git's credential store inside the command, never print it: GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')" gh api ...; read-only calls only).

Lists to read in full (every entry, every section):
- https://github.com/hesreallyhim/awesome-claude-code
- the largest "awesome" lists you can find for Codex CLI, Cursor, Gemini or Antigravity CLI, coding agents in general, agent orchestrators, and MCP clients (search GitHub for them: `gh api search/repositories?q=awesome+codex` and similar; take the top two by stars per topic)
- https://amux.io/blog/best-multi-agent-orchestrators-2026/ and any other 2026 roundup of agent managers or orchestrators you find

Step 1: enumerate every project in the categories that touch Harbor: session managers and GUIs, orchestrators and multi-agent runners, worktree tools, usage and cost monitors, status lines and notifiers, hooks collections and safety guards, history viewers and search, phone and remote control, transcript exporters, context and memory tools, rules-file sync. Fetch stars, last push date and archived flag in batch with the GitHub API. Put them all in one table (name, link, category, stars, last push, one-line what it does).

Step 2: drop the ones already named in REPORT.md section 14, archived ones, and ones with no push since 2026-06-01. For every remaining project with 300 or more stars, or fewer stars but an idea nothing else has, read its README and write: the one idea Harbor lacks (or "nothing new"), with the source link. Check C:\dev\harbor\app\src and C:\dev\harbor\docs\claude\ before saying Harbor lacks something.

Step 3: pick the ten most useful new ideas across the whole sweep, ranked, with effort (small, medium, large) and how it fits Harbor.

Write the report to: C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\W5-long-tail.md
