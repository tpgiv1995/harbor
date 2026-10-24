# Brief: Claude Code settings dialogs in Harbor (/mcp first)

You are building a Harbor feature end to end in the git worktree `C:\dev\.orch\harbor\cli-settings-ui` (branch `cli-settings-ui`, cut from `board-agent-write` at 800e4bb). The orchestrator (a Claude session) reviews, merges and publishes; you do not merge, push or publish.

## What Pat asked (2026-10-24, verbatim)

> see screenshot related to the zoom issue. this probably applies to a lot of the like settings and config options that you can do in the claude code cli so please review and provide a better interface and ui/ux for this in harbor (and you have it the worst way where you cant do it in the harbor interface but then if you toggle it back to the terminal then that doesnt work etiher...)

Context: Pat needed to sign the "claude.ai Zoom for Claude" connector back in (it showed "needs authentication"). He opened a new session in `~\Documents\Obsidian\Wiki` on his personal plan (`.claude` home) and typed `/mcp`. Harbor drew its "NEEDS YOUR ANSWER · unrecognized prompt" fallback panel (raw screen tail plus arrow/Space/Enter/Esc keys). He could not complete the sign-in there, and toggling the window to the `>_` raw terminal did not work either.

Inputs (absolute paths; they are gitignored in the main checkout, read them there):
- `C:\dev\harbor\docs\orchestration\2026-10-24-cli-settings-ui\private\inputs\pat-mcp-screenshot.png`: Pat's screenshot. The session shows "No transcript yet. If this session is live, the >_ toggle shows its terminal." and the fallback panel.
- `...\private\inputs\mcp-screen-full.txt` and `mcp-screen-early.txt`: the screens Harbor saved (from `~/.cache/harbor/unrecognized-dialogs/`, session 68433d79). The `/mcp` list is 20+ rows and the selection marker `❯` sits on "chrome" near the top, while the panel shows only the tail of the screen: Pat could not see what was selected, and nothing was clickable.

## Outcome required

1. **Root-cause and fix the `>_` failure.** Reproduce it: a brand-new Claude session (no transcript yet) that opens `/mcp` before any message, then the `>_` toggle. Find out what actually breaks (no stream attached for a paneless/transcript-less session, keys not reaching the pty, wrong size, something else), prove it by bisection, fix it, and pin it with a two-sided spec (fails before, passes after).
2. **A native Connections surface for `/mcp`.** When Pat types `/mcp` in the command bar (and from the capability menu), Harbor shows its own panel instead of the TUI:
   - Every MCP server and claude.ai connector for THAT session's config home and folder, with status (connected and tool count, needs authentication, failed, disabled), grouped the way the CLI groups them. Data from the CLI itself (`claude mcp list` / `claude mcp get` run with the session's `CLAUDE_CONFIG_DIR` and cwd), never scraped from the screen. Harbor's tests must stub it.
   - A **Sign in** button on any "needs authentication" row: `claude mcp login <name>` (it handles claude.ai connectors too; `--no-browser` prints the URL) for that home, the OAuth page opening in Pat's default browser, a clear waiting state, and success or failure shown in the panel. `C:\tools\claude-sync\mcp-login-pty.cjs` shows how the login command was driven before (it refuses piped stdin, so it needs a pty). Then make the LIVE session use the new sign-in: find out whether the running CLI picks it up on its own, or needs a reconnect (the TUI has reconnect actions), and do whatever is required. Prove it on a real session: a connector that showed only `authenticate` tools has its real tools afterwards.
   - Sign out and reconnect where the CLI supports them; enable/disable only if it is supported without editing files by hand.
3. **A generic list renderer for every other built-in TUI list dialog** (any screen with `❯` rows and a footer like `↑/↓ to navigate · Enter to confirm · Esc to cancel`) that Harbor does not already recognize: show ALL rows with the selected one highlighted (never cut the cursor row off), clicking a row moves the cursor there and confirms, and Esc cancels. It must not claim any of the five shapes `menu-parse.js` already recognizes, and it never replaces the hook lane for AskUserQuestion, permissions or MCP elicitations (those arrive as JSON; see conversation.md).
4. **Review the rest.** List every slash command in Claude Code 2.1.303 that opens an interactive dialog (`/config`, `/plugins`, `/permissions`, `/hooks`, `/agents`, `/memory`, `/login`, `/status`, `/doctor`, `/resume`, `/output-style`, `/privacy-settings` and any others; Harbor's model catalog scan in `providers/model-catalog.js` reads the installed binary). For each: does it work in Harbor today, does the generic renderer cover it, or does it deserve a native surface backed by a CLI subcommand or settings file. Build native surfaces only where Pat would hit them often (after `/mcp`); report the rest with a recommendation.

## Rules you must follow

- Read `C:\dev\.orch\harbor\cli-settings-ui\CLAUDE.md` and, before touching their areas, `docs/claude/conversation.md` (dialogs, ask cards, command bar, the fallback panel's history), `docs/claude/views.md` (stage window chrome, the `>_` toggle, rail) and `docs/claude/providers.md` (config homes, launches, capability menu). They bind you. Note the doctrine that the hook lane, not the screen scraper, carries questions; item 3 is for built-in dialogs that have no hook.
- Tests never touch the real daemon, the live Harbor, `~/.harbor/config.json` or real sessions' signals (isolation rules in CLAUDE.md). Unit suite gate: `npm test -- --exclude daemon --exclude bin` from `app\` (run `npm ci` in the worktree's `app\` first). Run the suites your change touches, then the gate once at the end.
- UI is verified by looking at it: drive the real renderer offscreen with the existing `app/scripts/drive-*-win.js` pattern, screenshot every state you add (list, waiting for sign-in, signed in, failed, generic list with the cursor deep in a long list, the `>_` fix) and read each screenshot critically. Never show, focus or restack a window on Pat's screen.
- A real end-to-end proof of the sign-in needs a connector that needs authentication: use a throwaway one you can sign out and back in. Do not sign out Pat's working connectors on his real homes. If a step truly needs Pat (a browser consent click), stop at that step, say exactly what is needed in your report, and finish everything else.
- `.js`/`.cjs` twins in `src/shared/` stay identical. Commit by file in the worktree with clear messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No real names, client names or personal paths in tracked files (the repo is published).
- Do not start subagents or other workers. Do not push, publish or merge.

## Done when

- The `>_` failure is root-caused, fixed and pinned two-sided.
- `/mcp` opens the native panel; Sign in works end to end on a real connector (or stops only at a consent click, stated); the live session gets the new tools.
- The generic renderer shows a 20-row list with the cursor anywhere, and clicking a row drives the real dialog.
- The review table for the other dialogs exists.
- The gate is green, screenshots are saved under `docs/orchestration/2026-10-24-cli-settings-ui/private/shots/` in the worktree, and your report is at `docs/orchestration/2026-10-24-cli-settings-ui/reports/build.md` in the worktree (committed): what you changed, by file; what you proved and how; what you could not prove; open items.
