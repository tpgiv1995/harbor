# claude release notes 2.1.310 to 2.1.312 (131 lines)

## 2.1.312
C1. [2.1.312] Added `oidc.user_id_claim` to the Claude apps gateway, to identify people by an id_token claim other than `sub`, such as Microsoft Entra ID's `oid`
C2. [2.1.312] Added click to send: in fullscreen, clicking the "to send now" hint under a queued message sends it right away, as its key does
C3. [2.1.312] Fixed managed settings and organization policy not being fetched for the rest of the session after signing in from the VS Code extension
C4. [2.1.312] Fixed Claude overwriting a very large CLAUDE.md, rules file or @-included file in a subdirectory after seeing only its start; Write now asks Claude to read it all or edit in place
C5. [2.1.312] Fixed per-directory and `paths:` skills not being found after a Bash `cd` deeper into a git repository
C6. [2.1.312] Fixed a rare case where the first reply after resuming a session in the terminal could be missing the next time the session was resumed
C7. [2.1.312] Fixed a command with an invalid name stopping all commands from loading, which could leave `claude -p` with no output
C8. [2.1.312] Fixed the Read tool sometimes failing on PDF pages with "pdftoppm failed: Could not write image" when the clean-up of old session files ran at the same time
C9. [2.1.312] Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task before the model applied it; they now show the level in force
C10. [2.1.312] Fixed the `/model` and `/effort` cache warning saying the re-read waits for your next message; a change made while Claude is working can trigger it sooner
C11. [2.1.312] Fixed some sessions showing as waiting on you when the last message only mentioned items waiting on you mid-sentence
C12. [2.1.312] Fixed agent view restoring input text on the next launch after it was cleared with Ctrl+C just before exiting
C13. [2.1.312] Fixed agent view reopening in shell mode after exiting with Ctrl+D from an empty `!` input
C14. [2.1.312] Fixed vim mode `d`, `c` and `y` with a `gj` or `gk` count larger than the lines left deleting or copying text; like Vim, they now only move the cursor
C15. [2.1.312] Fixed `/verify` showing a long description meant for Claude in `/help` and the `/` command menu instead of a short one
C16. [2.1.312] Improved the prompt's effort indicator: a change made mid-task now says it may wait for your next message, and the note clears when it no longer applies
C17. [2.1.312] Improved WebFetch errors in cloud sessions: a host that does not resolve is now explained as possibly outside the allowed network domains, so Claude names the host to allow
C18. [2.1.312] Changed Bedrock, Vertex, Foundry and Mantle to use the shorter system prompt for model names Claude Code doesn't recognize, such as custom deployment names and inference profile ARNs, even when they front Sonnet or Haiku; set `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` to keep the full prompt
C19. [2.1.312] Changed automatic model switches after a flagged message to also cover model names Claude Code doesn't recognize, such as custom deployment names; set `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` to turn them off
C20. [2.1.312] Changed usage limit messages to call the 5-hour window the "5-hour limit" instead of the "session limit"
C21. [2.1.312] Changed cloud sessions started from the CLI to get their names and branch names from the server
C22. [2.1.312] Changed prompt and agent hooks to run at most 24 at a time per session, sub-agents included, plus at most 12 that have waited longer than their event's timeout; a `timeout` under 1 second now counts as 1 second
C23. [2.1.312] Changed a subagent's `autoCompactWindow` to lower the window set by `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, where it had no effect before; it still never raises that window
C24. [2.1.312] Changed OpenTelemetry `mcp_server.name` to report the real name of fixed-URL remote MCP servers declared by plugins from the official Anthropic marketplace, instead of `custom`
C25. [2.1.312] Changed Claude Code to stop sending the `claude_code.safety_event` OpenTelemetry event
C26. [2.1.312] [VSCode] Fixed sessions ending on a bare exit code when your organization's settings couldn't be loaded or were refused at startup; the tab now says why and offers Retry or Sign in again
C27. [2.1.312] [VSCode] Changed usage limit resets to show a clock time ("Resets at 3:10 PM") and to say "5-hour limit"
C28. [2.1.312] [Cloud sessions] Added an effort level to the model picker when you create or edit a routine that runs in the cloud
C29. [2.1.312] [Cloud sessions] Added a Bash editor with colors, line numbers and a Copy button to the setup script box in cloud environment settings
C30. [2.1.312] [Cloud sessions] Improved the step shown when Claude adds a repository to a cloud session: opening it now shows a short table of what happened instead of raw JSON
C31. [2.1.312] [Cloud sessions] Fixed resending an unchanged message after a failed send in a cloud session sometimes running it twice
C32. [2.1.312] [Cloud sessions] Fixed a failed cloud environment creation showing its error only as a toast outside the open dialog; it now appears inside the dialog
C33. [2.1.312] [Cloud sessions] Fixed Edit in a routine's menu on the Routines page going to the routine's page without opening its edit dialog
C34. [2.1.312] [Remote Control] Fixed an unarchived Remote Control session showing as working until a computer reconnected; it now shows as idle
C35. [2.1.312] [Claude Tag] Improved Claude Tag's retry notice in Slack to name the model in use, or say rate limits were hit, instead of a generic API error
C36. [2.1.312] [Claude Tag] Fixed a Claude Tag channel's on/off switch and agent settings falling back to workspace defaults when an older private Slack channel goes public and gets a new ID
C37. [2.1.312] [Claude Tag] Fixed Claude in Slack not replying in channels whose environment has network access set to None
C38. [2.1.312] [Claude Tag] Fixed Claude in Slack sometimes posting a file in the wrong thread when it was answering in another thread of the same channel
C39. [2.1.312] [Code Review] Fixed Code Review reviewing an outdated commit, or none at all, when GitHub delivered a push event late; it now reviews the pull request's current commit

## 2.1.311
C40. [2.1.311] Added `--hold-idle-file` and `--max-hold-min` to `self-hosted-runner`, to keep an idle session while your host reports processes it left running
C41. [2.1.311] Added a tip for the Explanatory output style, shown when you ask Claude for explanations
C42. [2.1.311] Fixed long freezes at startup and after reading or editing files when a CLAUDE.md file holds a very long list item
C43. [2.1.311] Fixed interrupting Claude not taking effect until a timeout while an MCP server had not answered a resource read or a skill was still downloading
C44. [2.1.311] Fixed standard-context sessions stopping with "Usage credits required for 1M context" when a request ran over 200K tokens; Claude Code now compacts the conversation and continues
C45. [2.1.311] Fixed Write and Edit stalling for up to 5 seconds after they ran, and reporting 0 lines changed, when changing thousands of lines in a file
C46. [2.1.311] Fixed subagents being unable to use MCP tools from servers that finish connecting after the subagent starts
C47. [2.1.311] Fixed Claude seeing stale MEMORY.md and CLAUDE.md content right after automatic compaction when those files were edited earlier in the session
C48. [2.1.311] Fixed `claude -p` and SDK sessions saving transcript messages out of order or keeping messages that were taken back
C49. [2.1.311] Fixed `SubagentStop` hooks running about twice a minute for each running subagent instead of once when it finishes
C50. [2.1.311] Fixed the @ file picker ignoring `.ignore`/`.rgignore` negation rules that re-include git-ignored files
C51. [2.1.311] Fixed a subagent's isolated worktree being removed while a background subagent it started was still working in it
C52. [2.1.311] Fixed background agents in auto mode that wait on their own shells starting a new main conversation turn on every wake
C53. [2.1.311] Fixed the Bash tool description claiming the working directory always persists between calls
C54. [2.1.311] Fixed the environment block naming a shell commands don't run in, such as fish when the Bash tool uses zsh
C55. [2.1.311] Fixed `claude mcp add`, `claude mcp remove` and `/mcp` naming the current folder instead of the project entry in `~/.claude.json` that holds a local-scope server when run below a repository root
C56. [2.1.311] Fixed `claude mcp list` and `claude mcp get` showing the error code twice on failed-connection lines (for example `ENOENT: ENOENT: …`)
C57. [2.1.311] Fixed Remote Control sessions staying on "Connecting" for about two minutes when a network proxy blocks a startup request
C58. [2.1.311] Fixed messages that Claude sends to a cloud or Remote Control session appearing as your own message in the Claude mobile apps
C59. [2.1.311] Fixed Claude not being told the cause when a file attached to a message sent over Remote Control or to a cloud session could not be saved because the disk was full, or that a message's attachments past the first 20 were left out
C60. [2.1.311] Fixed WebFetch and WebSearch hanging on a stalled response in Cowork cloud sessions; an unfinished request now fails after 300 seconds
C61. [2.1.311] Fixed a background session that crashed between turns not being restarted while it was attached, pinned, or had a scheduled task or wake-up set
C62. [2.1.311] Fixed the "background service did not respond" error suggesting the disabled `claude daemon restart`; it now suggests `claude daemon stop --any` and says it ends background sessions
C63. [2.1.311] Fixed `claude respawn <id>` starting the background service before reporting that no background session matches the id
C64. [2.1.311] Fixed `/effort` not warning about a prompt cache miss in plan mode when the plan model differs from the session model
C65. [2.1.311] Fixed `/ide` saying the VS Code extension was installed before the install finished or when it failed
C66. [2.1.311] Fixed the Write tool's file preview skipping rows and miscounting hidden lines when a line is wider than the terminal
C67. [2.1.311] Fixed ↑ in an agent's chat tab recalling a message that was still waiting to be delivered, so resending it sent a second copy
C68. [2.1.311] Fixed Cowork cloud sessions losing their connectors and most tools after a restart when a plugin or your settings named an `agent`; Cowork cloud sessions now ignore that setting
C69. [2.1.311] Fixed agent teams sessions showing an empty task list when coming back with `--resume`, `--continue`, `/resume` or `--session-id`, including after `/clear` or a crash, and `/branch` writing to the original session's list
C70. [2.1.311] Fixed pasting text that mentions an image file, such as `! open /tmp/shot.png` or `/review look at /tmp/shot.png`, attaching the image and dropping its path from the prompt
C71. [2.1.311] Fixed the feedback draft card showing its 1/2/0 and Esc shortcuts while the prompt has text, when those keys act on the prompt instead of the card
C72. [2.1.311] Fixed a lone backslash in quotes or brackets, like `"\"` or `(\)`, disappearing from Claude's responses
C73. [2.1.311] Fixed agent teammates compacting their history when `DISABLE_COMPACT` is set
C74. [2.1.311] Fixed the rewind menu offering "Summarize from here" and "Summarize up to here" when `DISABLE_COMPACT` is set
C75. [2.1.311] Fixed a finished `/code-review`, or another skill that runs in a sub-agent, running a second time when a cloud or background session restarts
C76. [2.1.311] Fixed long hidden thinking being cut off as idle on Google Vertex AI, Microsoft Foundry and Claude Platform on AWS, where the endpoint sends thinking progress updates
C77. [2.1.311] Fixed `/ide` saying it had installed the JetBrains plugin when nothing was installed
C78. [2.1.311] Fixed Claude Pro and Max subscribers being told to ask their admin when their subscription can't be used; the message now points to billing settings
C79. [2.1.311] Fixed the diff pane opening by itself after an edit in wide fullscreen terminals when it had nothing to show
C80. [2.1.311] Fixed `/mcp` showing a remote server as failed after "Clear authentication" when the server works without sign-in
C81. [2.1.311] Fixed `/mcp` showing "authenticated" for a remote server that Claude Code sends no credentials to
C82. [2.1.311] Fixed a `--plugin-dir` folder of plugins loading as one plugin when an empty `.mcp.json` was at its top
C83. [2.1.311] Fixed `/usage` never showing large prompt-cache misses under "What's contributing to your limits usage?"
C84. [2.1.311] Fixed status line links staying plain text in background sessions after you open them from a terminal that supports links
C85. [2.1.311] Fixed the /rewind confirmation saying the conversation "will be forked" when the later messages are removed from the conversation
C86. [2.1.311] Fixed the /rewind warning that wrongly said manual and Bash edits are never affected by a code restore
C87. [2.1.311] Fixed plan approval in screen reader mode sending feedback you had dismissed with Escape
C88. [2.1.311] Fixed Claude Code retrying requests the API marked not to retry, which could hold a turn for minutes or, in unattended retry mode (`CLAUDE_CODE_RETRY_WATCHDOG`), indefinitely
C89. [2.1.311] Linux: Fixed sandboxed Bash commands failing with `bwrap: Can't create file` when a `--plugin-dir` folder was also an added directory and `permissions.blockReadsOutsideWorkingDirectories` was on
C90. [2.1.311] Self-hosted runner: Fixed a session failing to start when a rate limit (HTTP 429, or a git wrapper that exits 75) blocks an added read-only repository; it now starts without that repository
C91. [2.1.311] Improved startup time for Pro and Max accounts by skipping two network requests on launches within an hour of the last check
C92. [2.1.311] Improved `/teleport` and `claude --teleport` to warn when a compacted cloud session loads from its last compaction, so the messages it summarized aren't in the local copy
C93. [2.1.311] Improved the messages shown when a background session's process exits: they no longer promise a restart that isn't coming, and they say how to resume the session
C94. [2.1.311] Improved artifacts with several views: Claude now routes each view on the link's `#name` and no longer says the address bar stays the same as you switch views
C95. [2.1.311] Improved shell commands that reach their timeout: the result now shows the output so far and says the command is still running in the background
C96. [2.1.311] Improved compaction: when the model's reply has no summary in it, Claude Code now usually asks for the summary once more before it replaces the conversation
C97. [2.1.311] Improved the Artifact tool's choice between a page and a document: explainers and visual or interactive work become artifact pages; documents are for writing people keep editing or pass around
C98. [2.1.311] Improved startup time for launches whose only arguments are options and their values, such as `claude --model opus`
C99. [2.1.311] Improved the "Connection dropped" API error: it now says where to look first (the proxy or gateway in use, else VPN or firewall; Anthropic API only, Bedrock, Vertex and Foundry are unchanged)
C100. [2.1.311] Improved screen reader mode: deleting a rule in /permissions says "Deleted allow rule …" right away
C101. [2.1.311] Improved the message shown when a pasted sign-in code is refused: it now says the code may have expired or been used, and to sign in again
C102. [2.1.311] Improved Slack connector sends: Claude now checks a channel's topic for posting rules before messaging a channel you didn't name
C103. [2.1.311] Improved screen reader mode: Claude's questions are listed as "Questions: Color (answered), Pages", without arrows or symbols
C104. [2.1.311] Changed `ultrathink` in the interactive terminal to run its turn at xhigh effort on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 through Anthropic's API; typed while Claude is working, it raises the rest of that turn
C105. [2.1.311] Changed the `ultrathink` rainbow to appear only where the keyword can raise effort, and not when the word is quoted or part of a file path
C106. [2.1.311] Changed Ctrl+D in agent view to match the prompt: on an empty input, pressing it twice exits
C107. [2.1.311] Changed `--output-format json` and `stream-json` output to write DEL, C1 control and Unicode format characters inside strings as `\uXXXX` escapes; parsed values are unchanged
C108. [2.1.311] Changed model names and IDs to drop the `[1m]` suffix and its label on models where the suffix has no effect; the suffix is still accepted
C109. [2.1.311] Changed startup warnings about permission rules in settings files to show once per user until the rule changes
C110. [2.1.311] Changed `/code-review` to tell Claude to put the effort level first and use max only when asked
C111. [2.1.311] Changed `DISABLE_COMPACT` in settings files and in a mod's `$.env.set` so they can only turn compaction off, not back on
C112. [2.1.311] Changed Claude Code on Bedrock, Mantle, Vertex, and Foundry to load model settings from a signed file on downloads.claude.ai; set CLAUDE_CODE_MODEL_CATALOG=off to turn this off
C113. [2.1.311] Changed sessions that set `CLAUDE_CODE_SYNC_SKILLS` with feature-flag fetching off to reuse a claude.ai skills list up to 10 minutes old that another session on the machine fetched
C114. [2.1.311] Changed clicks on scrollbar arrows and bars in fullscreen lists to act when the mouse button is released, so moving off the scrollbar before letting go cancels the click
C115. [2.1.311] Changed `claude purge` to say it deletes data only on this computer, not anything stored by Anthropic
C116. [2.1.311] [VSCode] Added syntax coloring to code blocks in Claude's replies, in light, dark and high contrast dark themes
C117. [2.1.311] [VSCode] Added a "Running UserPromptSubmit hooks" spinner status and screen reader announcement for slow UserPromptSubmit hooks
C118. [2.1.311] [VSCode] Fixed custom skills and custom slash commands sent from the VS Code or JetBrains panel leaving out the open file or selected lines that ordinary messages include (anthropics/claude-code#102799)
C119. [2.1.311] [VSCode] Fixed the extension host freezing while the login shell ran its start-up files to read PATH on macOS and Linux
C120. [2.1.311] [VSCode] Fixed clicking an image in a tool result, or closing its preview, also opening the result's text in an editor tab
C121. [2.1.311] [VSCode] Fixed voice dictation continuing to record after a message was sent with the Send button; sending now stops dictation first, as pressing Enter already did
C122. [2.1.311] [VSCode] Changed the extension to start Claude Code sessions with `DISABLE_TELEMETRY` set while VS Code's telemetry setting is off, so they send no usage metrics or error reports and fetch no feature flags
C123. [2.1.311] [VSCode] Changed the session list side bar to load Web sessions when the Web tab is first opened, not at startup
C124. [2.1.311] [Cloud sessions] Fixed routines in Anthropic-hosted environments staying locked after their owner left the organization and rejoined; the owner can now turn them back on
C125. [2.1.311] [Cloud sessions] Fixed a failed routine API token delete or regenerate showing nothing if the edit dialog had already closed; it now shows an error toast
C126. [2.1.311] [Cloud sessions] Fixed cloud environment dialogs, including the admin dialog, accepting duplicate names; they now refuse a name another listed environment already has
C127. [2.1.311] [Claude Tag] Added a Skills view to Claude Tag analytics showing how often Claude runs each attached skill in Slack channels and which go unused, with Usage links in admin settings
C128. [2.1.311] [Claude Tag] Improved Claude Tag routines that run in a new session: a run with nothing to report can now end without posting a throwaway message to the channel
C129. [2.1.311] [Claude Tag] Changed Claude Tag admin settings to show a lock instead of # for private Slack channels that your own Slack account can see
C130. [2.1.311] [Code Review] Improved Code Review's check run to say no further automatic review will start when the model still can't analyze a change on the automatic retry
C131. [2.1.311] [Code Review] Improved Code Review reliability: a review whose session fails to start because of a transient server fault is now retried once automatically, and its check run says so
