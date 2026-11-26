# Brief W4: what users of tools like Harbor ask for and complain about (Reddit, Hacker News, forums)

Read C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\briefs\_context.md first.

Reddit: read %USERPROFILE%\.claude\skills\reddit\SKILL.md and follow its procedure exactly (god Chrome, .json pages fetched from a reddit.com tab, read-only, big threads to a file). Subreddits: r/ClaudeAI, r/ClaudeCode, r/codex, r/OpenAI, r/cursor, r/GoogleGeminiAI, r/ChatGPTCoding, r/LocalLLaMA (only where on topic), r/vibecoding. Searches (each sub, sort=top and sort=new, t=year): "multiple sessions", "parallel agents", "worktrees", "session manager", "agent manager", "orchestrat", "claude squad", "conductor", "orca", "vibe kanban", "usage limit", "rate limit", "windows terminal", "phone" or "mobile", "hooks", "notification", "antigravity cli", "codex cli windows", "cursor-agent". Read the top threads' comment trees, not just titles.

Hacker News: use the Algolia API (https://hn.algolia.com/api/v1/search?query=...&tags=story and /api/v1/items/<id>), no browser needed. Find every Show HN or launch thread for: Orca, Conductor, Vibe Kanban, claude-squad, Crystal, Nimbalyst, Sculptor, Terragon, Superset or Paradev, T3 Code, Paseo, Emdash, opcode, Happy, agent-deck, ccmanager, ccusage, Parallel Code, Vibeyard, and threads about "running many Claude Code agents", "agent orchestration", "coding agent management". Read the top comments of each.

Also read: the Cursor forum (https://forum.cursor.com) threads about the CLI on Windows and multi-agent work; the GitHub Discussions of anthropics/claude-code and openai/codex if open (use WebFetch or god Chrome).

Output:
1. A ranked list of user wants (features people ask for or praise), each with how many separate threads raised it and 2 to 4 links with a short quote.
2. A ranked list of complaints and failure stories (what breaks when running many agents: limits, cost, context, conflicts, windows, notifications, trust), same format.
3. Praise and criticism of each named tool, in one or two lines each.
4. For every want and complaint, whether Harbor already covers it (check C:\dev\harbor\app\src and C:\dev\harbor\docs\claude\ before saying no).

Write the report to: C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\W4-community.md
