# Brief W3: crawl the four CLIs' full docs and changelogs, as a host app sees them (Firecrawl)

Read C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\briefs\_context.md first.

Use the Firecrawl connector tools (firecrawl_map to list every page, then firecrawl_scrape / batch scrape). When Firecrawl fails on a page, open it in god Chrome (rules in _context.md). List pages that failed both ways with the error.

Crawl FULLY (every page under each docs root, not just the index):
1. Claude Code: https://code.claude.com/docs/en/ (every page) and the CHANGELOG https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, every entry from 2.1.250 to the newest.
2. Codex: https://developers.openai.com/codex (every page, including the app-server protocol, config reference, hooks, non-interactive mode) and https://github.com/openai/codex/releases from 0.150.0 to the newest.
3. Cursor CLI: https://cursor.com/docs/cli (every page), https://cursor.com/docs/hooks, https://cursor.com/docs/cli/changelog (every 2026 entry).
4. Antigravity CLI (agy): https://antigravity.google/docs (every CLI page: statusline, hooks, headless, acp, remote-control, settings, plugins) and https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md from 1.4.0 to the newest.
5. The Agent Client Protocol (https://agentclientprotocol.com, every page): which of the four CLIs speak it natively or through an adapter, what it gives a host (sessions, permission requests, plans, tool calls, diffs, modes, model choice), and who uses it (Zed, T3 Code, Paseo, others). Judge whether Harbor could drive some CLIs through ACP instead of typing into a terminal, and what it would lose.

For each CLI, produce a "host integration surface" table with one row per channel a host can use: state and turn signals (hooks, OSC, status line, registry files, events), approval channel, question channel, transcript format and location, model and effort, usage and limits, programmatic send (queue, app-server, ACP, stdin), resume and fork, subagents and background tasks, plans and to-do lists, goals, images. For each row give: the exact documented interface (field names, event names, file paths), the version it appeared, Windows caveats, the source URL, and what Harbor uses today. Check Harbor's code (C:\dev\harbor\app\src\main\providers\, main\session-send.js, main\providers\transcript.js, main\providers\pending-ask.js, bin\harbor-ask-hook and the docs under C:\dev\harbor\docs\claude\) before calling anything unused.

Then list every changelog entry in the ranges above that a host app should react to (a new event, a changed file format, a removed field, a new flag, a Windows fix), one line each with version and link, grouped by CLI, and mark the ones Harbor has not handled.

Write the report to: C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\W3-cli-docs.md
