# claude release notes 2.1.303 to 2.1.310 (265 lines)

## 2.1.310
C1. [2.1.310] Added the Monitor tool and plugin monitors on Bedrock, Vertex, and Foundry, and when telemetry or nonessential traffic is disabled; long foreground sleeps are now blocked there too
C2. [2.1.310] Fixed requests failing behind some gateways and compatible servers that reject the `effort-2025-11-24` beta value or mid-conversation system messages; Claude Code now retries without them
C3. [2.1.310] Fixed background cleanup deleting some recent files, such as pasted images, when `cleanupPeriodDays` is set to a very large value
C4. [2.1.310] Fixed compaction after a "Prompt is too long" error keeping too much of a conversation with dense text, such as base64 or SVG, so the next request could fail again
C5. [2.1.310] Fixed file read permission prompts not showing where a symbolic link leads
C6. [2.1.310] Fixed a question's auto-continue timeout firing the moment the external editor closed after a long edit
C7. [2.1.310] Windows: Fixed PreToolUse and PermissionRequest hooks letting a tool call through when Git Bash is missing and the hook's command is only quoted strings, such as a quoted path
C8. [2.1.310] Improved auto mode's prompt before the first read outside the working directories: it now says when blocking those reads makes shell commands ask for permission
C9. [2.1.310] Improved memory use of non-interactive sessions (`-p`, Agent SDK) during compaction when the transcript file is very large
C10. [2.1.310] Improved a mod's `Image` to draw inside tmux with `allow-passthrough` and `focus-events` on, in kitty, Ghostty, and iTerm2 3.5+ with fullscreen rendering, where it showed only its `alt` text
C11. [2.1.310] Linux: Improved `/sandbox` and the sandbox startup warning to name Ubuntu's AppArmor restriction on user namespaces, and how to lift it, when it keeps bubblewrap from starting the sandbox
C12. [2.1.310] Changed the error for an MCP tool call that times out in a non-interactive session while the server's elicitation is unanswered: it now tells Claude that no answer came and not to repeat the call
C13. [2.1.310] [VSCode] Fixed pressing Enter on the plan review card's "Send feedback and keep planning" button approving the plan instead of sending your comments back
C14. [2.1.310] [VSCode] Fixed the panel showing "Something went wrong" after "Switch branch & continue" on a cloud session opened from Session history's Web tab
C15. [2.1.310] [Cloud sessions] Added Claude Code cloud sessions and Remote Control permissions to Enterprise custom roles, so Owners can control access to each by role
C16. [2.1.310] [Cloud sessions] Added a Choose file button to load a cloud environment's setup script from a file
C17. [2.1.310] [Cloud sessions] Fixed failed saves and archives in the cloud environment edit dialog showing no error inside the dialog
C18. [2.1.310] [Cloud sessions] Fixed failed routine API token actions showing only a toast; the error now appears in the routine edit dialog
C19. [2.1.310] [Cloud sessions] Improved the session start checklist to show a cloud environment's setup script output in a scrolling box
C20. [2.1.310] [Cloud sessions] Changed turning on Cloud sessions or Remote Control in admin settings to ask for confirmation and list the custom roles that have that permission
C21. [2.1.310] [Cloud sessions] Changed the cloud environment dialog to open network access, setup script and environment variables from rows instead of listing every editor at once
C22. [2.1.310] [Claude Tag] Fixed Claude Tag treating `!` commands such as `!restart` and `!help` as ordinary messages when sent in bold, italic or strikethrough
C23. [2.1.310] [Claude Tag] Fixed Claude Tag admin channel and workspace pages being replaced by a load error when a background refresh of the bundle list fails
C24. [2.1.310] [Claude Tag] Fixed Claude Tag's spend limits page in admin settings reporting that no channels match a filter while channel names are still loading
C25. [2.1.310] [Code Review] Fixed the Code Review admin section hiding its repositories and switches after a failed refresh of the repository list
C26. [2.1.310] [Code Review] Improved the Code Review admin section to retry the first load and show one Try again banner when it still fails

## 2.1.309
C27. [2.1.309] Fixed sandboxed Bash commands on macOS and Linux running the shell's startup files outside the sandbox before each command
C28. [2.1.309] Fixed macOS sandbox `denyWrite` glob patterns not applying at a path's real location when the pattern's folder is reached through a symlink
C29. [2.1.309] Fixed sandboxed commands and auto-accepted edits being able to modify the MCP config file passed with `--mcp-config`
C30. [2.1.309] Fixed a disabled MCP server being reconnected by a later permission prompt in print and SDK sessions
C31. [2.1.309] Fixed the Bash permission check trusting a variable set by a command whose redirect can fail to open
C32. [2.1.309] Fixed Bash permission checks not prompting for some compound commands that change directory before running git when the `cd` is wrapped or prefixed, as they do for a plain `cd`
C33. [2.1.309] Fixed an `Edit(path)` deny rule not blocking a Bash redirect to that path in some commands that also held a subshell
C34. [2.1.309] Fixed worktree-isolated sessions accepting some locale-prefixed commands the isolation guard should refuse
C35. [2.1.309] Fixed worktree-isolated sessions on zsh accepting some arithmetic commands that the isolation guard should refuse
C36. [2.1.309] Fixed worktrees and branch checkouts that Claude Code creates so they ignore git replace refs, as its other git operations already do
C37. [2.1.309] Fixed profile store write protection not applying when the config directory is reached through a symlink
C38. [2.1.309] Fixed sessions compacting repeatedly after reading files under a very large nested CLAUDE.md; a nested CLAUDE.md over the size limit now loads only its start
C39. [2.1.309] Fixed ctrl+enter (send now) only queuing a message when pressed before the response had started, and restarting a prompt's hooks while leaving the message queued when pressed while those hooks were running
C40. [2.1.309] Fixed key-bound slash commands running in the shell from `!` mode
C41. [2.1.309] Fixed ctrl+o not showing messages from other agents and sessions that are still waiting to be delivered; they now appear in full under the transcript, marked as waiting
C42. [2.1.309] Fixed long tool output previews being cut through an emoji, leaving session transcripts that `jq` could not parse
C43. [2.1.309] Fixed Read reporting "File does not exist" for PDF page ranges in Linux sandboxes that share the parent's `/proc`
C44. [2.1.309] Fixed messages from a Claude Desktop-hosted session sometimes being lost when its connection refreshed
C45. [2.1.309] Fixed features missing from Claude Code sessions in the Claude desktop app when the terminal on the same computer was signed in to a different account or organization
C46. [2.1.309] Fixed the `claude remote-control` status line showing `HEAD` as the branch for a folder that is not in a git repository
C47. [2.1.309] Fixed split-pane agent teammates not inheriting the tool deny and `--tools` rules given on the leader's command line
C48. [2.1.309] Fixed sessions renamed with `/rename` appearing to other sessions under a generated name after a VS Code window reload or a non-interactive `--resume`
C49. [2.1.309] Fixed the `/rewind` list showing "No code changes" for a turn that changed checkpointed files through `/code-review --fix`, a subagent or a shell command
C50. [2.1.309] Fixed `/privacy-settings` showing an out-of-date "Help improve our AI models" value; it now also says when the setting can't be fetched
C51. [2.1.309] Fixed feedback saying "try again later" when your organization does not accept feedback; it now shows the server's reason and where to report a bug
C52. [2.1.309] Fixed oversized /feedback reports failing instead of being resent without the transcript
C53. [2.1.309] Fixed a skill in an `--add-dir` folder being unreachable when another skill already held its name; it is now offered as `<folder>:<name>`
C54. [2.1.309] Fixed `/verify` and `/code-review` not finding a nested package's own skill when its files were changed from the shell
C55. [2.1.309] Fixed the /claude-api skill saying that `ant beta:worker poll --on-work` passes trace context to the command
C56. [2.1.309] Fixed the /claude-api skill's C# tracing setup missing spans from the cloud platform clients
C57. [2.1.309] Fixed the /claude-api skill saying that API spans for requests to Claude Platform on AWS can't join the caller's trace
C58. [2.1.309] Fixed hooks that run in PowerShell not blocking when the hook's program exits with code 2, and on Windows `PreToolUse` and `PermissionRequest` hooks with `"shell": "powershell"` failing open when Git for Windows isn't installed
C59. [2.1.309] Fixed a mod's `turn.step` hook that names a model by alias, such as `haiku`, failing every request with a model error: the alias now resolves to its model
C60. [2.1.309] Fixed plugins and skills synced from claude.ai being removed, sometimes mid-session, after a disk read error
C61. [2.1.309] Fixed artifact publishes and updates being refused for some ordinary pages, such as pages with certain minified scripts or artifacts Claude could not read first
C62. [2.1.309] Fixed Claude asking for permission on each artifact update for the rest of a turn after the conversation was compacted in that turn
C63. [2.1.309] Fixed fine-grained tool streaming staying off on Amazon Bedrock when `ANTHROPIC_BEDROCK_BASE_URL` is set to the default `bedrock-runtime.<region>.amazonaws.com` endpoint
C64. [2.1.309] Fixed the "Waiting for API response" hint flickering behind gateways that send only keepalive pings: routes off Anthropic's backend now wait 45 seconds
C65. [2.1.309] Fixed Claude notifying unrelated GitHub users by writing role names and placeholders as mentions in PRs, issues and comments
C66. [2.1.309] Linux: Fixed sandbox write denies lifting when a background command outlived the session
C67. [2.1.309] Windows: Fixed PowerShell permission checks auto-approving some `Set-Location` or `cd` commands that target the current directory and carry extra arguments; these now prompt for approval
C68. [2.1.309] macOS: Fixed the "Install Command Line Developer Tools" dialog opening each time Claude Code starts on a Mac without Xcode or the Command Line Tools
C69. [2.1.309] Self-hosted runner: Fixed `--startup-timeout-min` stopping a session whose first prompt, such as `/code-review`, was still working in a subagent; a frozen process is still stopped
C70. [2.1.309] Improved the speed of many git commands Claude Code runs for itself on Windows; on every platform, errors from those commands now show in English even when git is set to another language
C71. [2.1.309] Improved the error when a hooks module is nested too deep to load: it now names the file instead of showing a bare stack-overflow message
C72. [2.1.309] Improved disk-full handling: a Bash command cut off by a full disk now says so and names the folder to free up, and starting on a full temp volume prints a clear message, not a raw ENOSPC error
C73. [2.1.309] Improved the /claude-api skill to offer API tracing alongside SDK tracing when asked to add OpenTelemetry
C74. [2.1.309] Improved the /claude-api skill to check the live docs before saying a feature is unsupported
C75. [2.1.309] Self-hosted runner: Improved sessions that move to a new runner: Claude now sees the tool call that was interrupted, marked as outcome unknown
C76. [2.1.309] Updated the bundled dataviz skill to accept APCA as a text-contrast measure (keeping WCAG 2 ratios where AA conformance is required), add an `apca(text, background)` function to its palette validator scripts, and say whether a label inside a colored chart fill should be white or near-black
C77. [2.1.309] Updated the /claude-api skill: service account keys and Workload Identity Federation tokens can now manage OpenTelemetry destinations
C78. [2.1.309] Changed `sed -i` to get the standard Bash prompt and run as written, not a simulated file-edit preview; like other Bash edits, it is no longer restored by `/rewind`
C79. [2.1.309] Changed `claude ultrareview` to require workspace trust: it asks on a terminal, else refuses; scripts pass `--trust-workspace`, which takes no value (put a PR number or base branch before it), or set `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK=1`
C80. [2.1.309] Changed the dangerous `rm` and `rmdir` prompt in bypass permissions mode in the Desktop app and VS Code to deny the command at once with a rewrite hint, so unattended sessions keep going
C81. [2.1.309] Changed commands the settings exclude from the sandbox to ask before writing to its write-list paths while the sandbox is enabled but cannot run; the unsandboxed fallback is refused there
C82. [2.1.309] Changed worktree creation and reuse so git no longer fetches objects on demand, in ordinary clones and in partial clones with a Bash sandbox configured; such a partial clone fetches them first
C83. [2.1.309] Changed the `/claude-api` skill to build Managed Agents subagent teams on `multiagent_20261001` with dynamic workflows on by default, instead of `coordinator`
C84. [2.1.309] [VSCode] Added a log warning that says what to do when dictation or the extension's own requests fail certificate verification, such as behind a TLS-inspecting proxy
C85. [2.1.309] [VSCode] Fixed the Claude panel staying blank after the editor cached an incomplete copy of its files; it now recovers by itself, or says what went wrong and how to fix it
C86. [2.1.309] [VSCode] Fixed Session history filling up with empty "Untitled" sessions each time you start a new session without sending a message
C87. [2.1.309] [VSCode] Fixed long slash-command messages such as `/goal` filling the chat panel; they now fold behind Show more like other prompts (anthropics/claude-code#97469)
C88. [2.1.309] [VSCode] Fixed long messages not folding behind Show more after the chat panel is made narrower
C89. [2.1.309] [VSCode] Fixed Ctrl+J in the chat input always inserting a newline: it is now left to VS Code and the OS when "ctrl+j" is set to null in the Chat context of ~/.claude/keybindings.json
C90. [2.1.309] [VSCode] Fixed a mod's "From the … plugin" label above the prompt being drawn over the slash command and @-mention menus (anthropics/claude-code#102981)
C91. [2.1.309] [VSCode] Fixed an empty list item, paragraph or code block, and list items renumbered from 1, when pasting copied LaTeX math
C92. [2.1.309] [VSCode] Fixed the feedback error showing only an HTTP status when your organization does not accept feedback
C93. [2.1.309] [VSCode] Improved Edit and Write speed in the chat panel: the wait for new problems after each edit is now 0.75 seconds in most cases, down from 1 to 1.5 seconds
C94. [2.1.309] [Cloud sessions] Fixed the Add connector list in routine forms saying no connectors were available while they were still loading
C95. [2.1.309] [Cloud sessions] Fixed the cloud environment editor shuffling environment variables and adding backslashes to values that contain both kinds of quote
C96. [2.1.309] [Cloud sessions] Fixed the self-hosted environment details dialog in admin settings so its title, tabs and buttons stay in view while only the content scrolls
C97. [2.1.309] [Cloud sessions] Fixed the "read documentation" tool row in cloud sessions, which showed escaped JSON instead of a readable page
C98. [2.1.309] [Cloud sessions] Improved a cloud session's Changes pane, which now says when it lists only pushed commits or only Claude's edits
C99. [2.1.309] [Claude Tag] Fixed Claude in Slack posting a draft you approved for a channel into your DM by mistake; a post with no channel is now refused so it can go to the approved channel
C100. [2.1.309] [Claude Tag] Fixed Allow and Deny on Claude's approval cards in Slack doing nothing when the session had stopped; your answer now restarts the session
C101. [2.1.309] [Claude Tag] Fixed Claude ignoring untagged messages in a Slack channel after its workspace moved to a different Claude organization, including unshared channels on Enterprise Grid
C102. [2.1.309] [Claude Tag] Fixed Claude in a Slack channel posting a threaded reply before reading a newer message someone had just added to that thread
C103. [2.1.309] [Claude Tag] Fixed the Slack page in Claude Tag admin settings saying no workspaces were connected when the list failed to load; it now shows an error with a Retry button
C104. [2.1.309] [Code Review] Fixed a finished review showing no check on the pull request when earlier tries to create it failed; a final try now adds a completed check
C105. [2.1.309] [Code Review] Fixed a push queued behind a running review still starting a review after `@claude review stop`; its check now closes and says why

## 2.1.308
C106. [2.1.308] Bug fixes and reliability improvements

## 2.1.307
C107. [2.1.307] Added `/claude-api api-version` to move Claude API code to API version `2026-10-21`
C108. [2.1.307] Added the `claude_code.safety_event` OpenTelemetry event for each tool call a permission rule, auto mode, a safety check, a hook or the sandbox stopped, prompted or sent back
C109. [2.1.307] Fixed requests failing with a model-not-found error when `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set and the model is an alias with the `[1m]` suffix, such as `opus[1m]`
C110. [2.1.307] Fixed the `prompt-caching-scope` beta header being sent behind custom `ANTHROPIC_BASE_URL` gateways and on Foundry, where it has no effect
C111. [2.1.307] Fixed MCP servers showing "needs authentication" in `claude -p` on macOS while the login keychain was locked; they now say why, and the next run after an unlock connects without a new sign-in
C112. [2.1.307] Fixed MCP servers being reported as timed out, and staying failed in headless runs, when a macOS or Linux computer went to sleep while they were connecting
C113. [2.1.307] Fixed HTTP MCP tool calls being sent twice when the connection closed mid-call; only read-only or idempotent tools are now retried
C114. [2.1.307] Fixed a turn sometimes starting without an SDK MCP server's latest tools when a background task was running
C115. [2.1.307] Fixed some "Autocompact is thrashing" errors in turns that read many PDF pages, images or other large tool results
C116. [2.1.307] Fixed `/autocompact` in cloud sessions going back to the default window after the session restarted
C117. [2.1.307] Fixed a conversation cleared with `/clear` sometimes coming back when a cloud or self-hosted runner session restarted
C118. [2.1.307] Fixed `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` being ignored in Claude apps gateway sessions
C119. [2.1.307] Fixed telemetry from Claude Desktop sessions behind a Claude apps gateway being rejected when `OTEL_EXPORTER_OTLP_HEADERS` is set
C120. [2.1.307] Fixed `/permissions` > Recently denied not showing the denied shell command, and auto mode's local classifier ignoring an approval from there when it checks a retried command; approving a row now names the command, not its description
C121. [2.1.307] Fixed `/help` and the `/` command menu showing long model-facing descriptions for bundled skills such as `/claude-api` instead of their short descriptions
C122. [2.1.307] Fixed subagent transcripts recording placeholder token usage and an empty stop reason for streamed responses
C123. [2.1.307] Fixed model switches through the Agent SDK's `setModel()`, and apps built on it, being refused when the API took more than 5 seconds to confirm the model; Claude Code now waits up to 15 seconds
C124. [2.1.307] Fixed a background command stopped through a connected app (such as the desktop app archiving an idle session) being reported to Claude as stopped by the user; the notice now names its output file
C125. [2.1.307] Fixed WebFetch in Cowork cloud sessions reporting a tool error when a site answered with a 4xx status or a robots.txt refusal; it is now a normal result, as in local sessions
C126. [2.1.307] Fixed write tools on a directly configured GitHub MCP server showing a form that closed without creating anything in the desktop app's Code tab
C127. [2.1.307] Fixed Artifact tool reads failing with a connection reset when the server had closed a reused connection
C128. [2.1.307] Self-hosted runner: Fixed sessions with `--use-anthropic-git-proxy` committing a `.claude/settings.local.json` left in the clone by an earlier session
C129. [2.1.307] Self-hosted runner: Fixed archiving or requeueing a session, or stopping the runner, during its checkout hook leaving the hook's processes running and the runner's slot held
C130. [2.1.307] Improved recovery from unparseable tool calls: Claude Code now retries the call up to twice before ending the turn with an error
C131. [2.1.307] Improved fork subagents launched together: each is now told which launch is its own, so forks are much less likely to try to start each other's work
C132. [2.1.307] Improved browser sign-in: the success page now appears as soon as sign-in completes, without waiting for your account profile to load
C133. [2.1.307] Improved web search errors in cloud and self-hosted runner sessions: a search refused with a 403 that gives a reason now shows that reason instead of a generic "Authentication error"
C134. [2.1.307] Improved the time to the first reply in cloud sessions when one of the desktop app's MCP servers can't connect
C135. [2.1.307] Improved Remote Control connect time for sessions whose transcript contains large pasted images or PDF reads
C136. [2.1.307] Changed the notice Claude gets when the WebSearch budget is used up to also tell it not to query search engines in a browser or through computer use
C137. [2.1.307] Changed the `axScreenReader` setting and `CLAUDE_AX_SCREEN_READER` in a settings `env` block to apply only from user, managed or `--settings` settings (since 2.1.305)
C138. [2.1.307] Self-hosted runner: Changed checkout hooks to be stopped after 30 minutes by default, failing the session's setup; if yours needs longer, raise `--checkout-hook-timeout-min` or set it to `0`
C139. [2.1.307] Self-hosted runner: Changed the certificate file built for Anthropic-managed git to filter its trusted certificates as the CLI does; a `[runner:warn]` line gives the number left out
C140. [2.1.307] [VSCode] Added a notice on the microphone button when voice dictation stops by itself (15 seconds without recognized speech, or the 2-minute limit), saying why and that the text so far is kept
C141. [2.1.307] [VSCode] Fixed a long prompt expanded with Show more covering the whole chat panel: a pinned prompt is now capped at 40% of the panel and scrolls
C142. [2.1.307] [VSCode] Fixed part of a list item or table cell with LaTeX math pasting as a new list or table in rich text editors
C143. [2.1.307] [VSCode] Fixed dictation failing behind a TLS-inspecting proxy when `NODE_EXTRA_CA_CERTS` is set only in `~/.claude/settings.json`; it now also follows `CLAUDE_CODE_CERT_STORE`
C144. [2.1.307] [VSCode] Changed the "still open somewhere else" notice to also cover a Claude process left over from an extension restart, which usually ends on its own within about 10 minutes
C145. [2.1.307] [VSCode] Changed voice dictation to filter its trusted certificates as the CLI does
C146. [2.1.307] [VSCode] Changed the extension's own requests to filter their trusted certificates as the CLI does, and to trust the `NODE_EXTRA_CA_CERTS` file named in the environment or in user settings
C147. [2.1.307] [Cloud sessions] Fixed the repository picker saying "No repositories match" while a search was still running; it now shows "Searching…" until the results arrive
C148. [2.1.307] [Cloud sessions] Fixed the "Waiting for a runner" status on self-hosted environments being cut off; with on-demand runners it now counts up from your last message and shows failed attempts
C149. [2.1.307] [Code Review] Added `@claude review stop` (also `off` and `pause`) to Code Review, ending an `@claude review always` subscription on a pull request without starting a new review

## 2.1.306
C150. [2.1.306] Fixed `claude -p` inside cloud sessions reporting "Not logged in" when started without the session's environment variables
C151. [2.1.306] Fixed an API error being replaced by "prompt is too long", and an unneeded compaction, in sessions with many MCP tools

## 2.1.305
C152. [2.1.305] Added `sandbox.allowNestedUserNamespaces` so sandboxed commands on Linux can create user namespaces (Chromium, rootless podman); this lets them get around the sandbox's file protections
C153. [2.1.305] Added `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` so unattended retry mode (`CLAUDE_CODE_RETRY_WATCHDOG`) notices a usage limit that was lifted before its reset
C154. [2.1.305] Fixed every request failing on Vertex, Bedrock and other providers when the endpoint or a gateway rejects tool search, and behind gateways with ToolSearch disallowed or left out of `--tools` (a 2.1.304 regression): Claude Code now retries without it
C155. [2.1.305] Fixed `/effort` and `/autocompact` settings not applying when the model name differed from a `modelOverrides` value by letter case or a `[1m]` tag
C156. [2.1.305] Fixed new worktrees in a bare repository sometimes starting from local HEAD instead of the default branch, and unchanged subagent worktrees sometimes not being cleaned up
C157. [2.1.305] Fixed Bash commands on a full disk failing with a raw `ENOSPC` file path: the error now says the disk is full and that nothing ran
C158. [2.1.305] Fixed an MCP server passed by a cloud session or by the SDK's `setMcpServers` being replaced later in the session by a same-named server from your own settings
C159. [2.1.305] Fixed Claude naming the wrong model for a subagent's work after the subagent switched to a fallback model
C160. [2.1.305] Fixed cloud sessions and teammates not telling Claude when a compaction had to leave the oldest messages out of its summary to fit
C161. [2.1.305] Fixed more cases of scheduled Cowork cloud sessions waiting five minutes for each subagent whose WebFetch needed a URL approval that nobody was there to give
C162. [2.1.305] Fixed Workflow resume re-running already-completed `pipeline()` and `parallel()` agents instead of serving them from the run's journal
C163. [2.1.305] Fixed Remote Control leaving empty "(session)" entries in `/resume` after switching conversations with `/resume`
C164. [2.1.305] Fixed `/usage` rows being cut off in narrow terminals
C165. [2.1.305] Fixed startup warnings printing as raw text above the logo: they now go to the debug log, and permission rules that restrict nothing show as warning rows under the banner
C166. [2.1.305] Fixed screen reader mode: search boxes now say "Search:" instead of a symbol VoiceOver read as "telephone recorder", and highlighted prompt text, such as Ctrl+R search matches and "ultrathink", no longer has spaces inside words
C167. [2.1.305] Self-hosted runner: Fixed a start script that shares only its stdout with the runner or orchestrator failing with `Resource temporarily unavailable` when `TERM` is set (a 2.1.300 regression)
C168. [2.1.305] Self-hosted runner: Fixed repository access failing since 2.1.296 when a git credential helper or askpass program reads its settings through `GIT_CONFIG`
C169. [2.1.305] Self-hosted runner: Fixed the orchestrator reporting a spawn-runner hook as timed out when a runner it started in the background kept its output open
C170. [2.1.305] Improved `/usage`: each warning is now a one-line fix that names its source, and `f` applies the fixes; the same fixes appear in VS Code and `/doctor`
C171. [2.1.305] Improved MCP consent dialogs so an Enter meant for the prompt is less likely to be taken as Accept
C172. [2.1.305] Improved a mod's `Image` to draw its picture in iTerm2 3.5 and later with fullscreen rendering, where it showed only its `alt` text
C173. [2.1.305] Remote Control: Improved the spawn-mode messages: pressing `w` now says the new mode is saved for the folder, and a later `claude remote-control` start that uses the saved mode says where it came from
C174. [2.1.305] Changed `allowedMcpServers` to stop filtering `managed-mcp.json` stdio servers that use `${VAR}` only in `env`: one your allowlist left out now loads on upgrade; use `deniedMcpServers` to keep it off
C175. [2.1.305] Changed plugins that Claude Desktop mounts by path to no longer keep their `allowed-tools` when your organization's managed settings set `allowManagedPermissionRulesOnly`
C176. [2.1.305] Changed the `/artifacts` delete confirmation to take 1 or Enter to keep, 2 to delete, and Esc to cancel; `y` and `n` no longer answer it
C177. [2.1.305] Changed a mod's docked pane to stay within 45% of the terminal's width, including a width kept from a wider terminal
C178. [2.1.305] [VSCode] Added a "Running start-up hooks" spinner status, with a screen reader announcement, while SessionStart or Setup hooks run
C179. [2.1.305] [VSCode] Fixed the spinner cutting off "Compacting..." when your `spinnerVerbs` setting replaces the built-in verbs with short ones
C180. [2.1.305] [VSCode] Changed the message shown when a session does not start in time and no hook is running: it now leads with the output logs and lists causes instead of pointing to sign-in and network first
C181. [2.1.305] [Cloud sessions] Fixed the Cloud environments admin page wrongly refusing to save an existing environment with an "installs packages" error
C182. [2.1.305] [Cloud sessions] Improved deleting a self-hosted environment so the dialog and error messages say what blocks the delete and what it will affect
C183. [2.1.305] [Claude Tag] Added public Slack channels Claude hasn't joined to the Claude Tag admin Add place search, so admins can set one up from there
C184. [2.1.305] [Claude Tag] Fixed Claude Tag access bundles so a repository that moved to another GitHub account can be added again
C185. [2.1.305] [Claude Tag] Fixed a routine set up in a Slack DM thread no longer posting after another routine in that thread restarted the conversation; both now keep posting there
C186. [2.1.305] [Claude Tag] Fixed routines set up in a Slack thread reporting success without posting after the conversation ended; those runs are now skipped and the creator is told
C187. [2.1.305] [Claude Tag] Improved Claude Tag admin pages in large organizations so plugin, skill and bundle edits work while the channel list is still loading
C188. [2.1.305] [Code Review] Fixed Code Review sometimes not reviewing the newest commit when several pushes landed on a pull request during a review
C189. [2.1.305] [Code Review] Changed Code Review re-reviews so they no longer open with LGTM while earlier blocking findings are still open

## 2.1.304
C190. [2.1.304] Added a transcript line when a plugin that runs first skips one of your mod's hooks, naming the event and the plugin
C191. [2.1.304] Added `decider: "person"` to a mod's `tool.check` answer: only the permission dialog or a host's callback can approve the ask, and it is refused with the mod's reason where nobody can be asked
C192. [2.1.304] Added `e.isReadOnly` to a mod's `tool.check` event, set when the tool call is read-only
C193. [2.1.304] Added `/auto-mode-setup`: a guided setup that reads your project and recent sessions to teach auto mode about your environment, now also available on Bedrock, Vertex, Foundry, Claude apps gateway and telemetry-disabled sessions
C194. [2.1.304] Added `/claude-api managed-agents-secure`, which compares a Managed Agents agent's settings with Anthropic's published security guide, without changing anything
C195. [2.1.304] Added the names of the tools called earlier to the compaction summary in the transcript view (Ctrl+O)
C196. [2.1.304] Added a warning on Pro and Max plans when resuming an inactive conversation would use a noticeable share of your 5-hour usage limit: resume anyway, or start a new conversation and Claude can look up the previous one if you refer to it
C197. [2.1.304] Fixed the organization policy not refreshing until the hourly check after approving an `ANTHROPIC_API_KEY` at startup or switching "Use custom API key" in `/config`
C198. [2.1.304] Fixed sandboxed commands failing to start on Linux when a `sandbox.filesystem.denyRead` glob contains brackets that are not a character class, such as a `[user-id]` route folder
C199. [2.1.304] Fixed `rm -r` of a mounted drive or a folder at its top level (`/Volumes`, `/media`, WSL's `/mnt/c`) not getting the safety prompt that `rm -rf /Applications` gets
C200. [2.1.304] Fixed `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` dropping messages from the saved transcript when the disk filled up while the file was being trimmed
C201. [2.1.304] Fixed a plugin keeping a headless run going past `--max-turns`, Stop, or ended input by spawning subagents or re-running a finished one
C202. [2.1.304] Fixed a failed mod reload removing the tools and commands of the version that stays loaded, and its messages being wrong or silent about whether the previous version is still loaded
C203. [2.1.304] Fixed a click on a mod's button being lost when buttons with the same label and no `key` were redrawn unchanged
C204. [2.1.304] Fixed mod sharing in the built-in `plugin-authoring` skill stopping at the secret scan on machines with managed settings and on Team and Enterprise plans
C205. [2.1.304] Fixed scheduled Cowork cloud sessions waiting five minutes again for each subagent whose WebFetch needed a URL approval that nobody was there to give
C206. [2.1.304] Fixed Write results and rejected edits showing a file outside the working directory as `../../…`; they now show `~/…` or the full path
C207. [2.1.304] Fixed a claude.ai Directory plugin's skills not running as commands when picked from the "/" menu in Cowork cloud sessions
C208. [2.1.304] Fixed Remote Control permanently withholding a desktop conversation's history when a different account was signed in to the terminal
C209. [2.1.304] Fixed Remote Control failing to start from Claude Desktop when DISABLE_TELEMETRY or DO_NOT_TRACK is set on a paid plan
C210. [2.1.304] Fixed model switches, messages and interrupts waiting behind a context usage check in SDK and desktop sessions
C211. [2.1.304] Fixed `context_management: Extra inputs are not permitted` errors behind LLM gateways; Claude Code now resends the request without that field
C212. [2.1.304] Fixed OpenTelemetry settings delivered through server-managed settings being ignored for the whole session after signing in during first-run setup or the first start after /logout
C213. [2.1.304] Fixed unsandboxed Bash commands in Claude Desktop Code tab sessions on macOS and Linux not seeing environment variables exported in shell startup files such as ~/.zshrc
C214. [2.1.304] Fixed the Consumer Terms notice being skipped for a day or longer after a server error
C215. [2.1.304] Fixed `/privacy-settings` offering choices that may not apply to you after a network or server error
C216. [2.1.304] Fixed a "Context limit reached" or "Prompt is too long" error after stopping a turn while Claude Code was compacting a conversation the API had rejected as too long
C217. [2.1.304] Fixed subagents sometimes forgetting their most recent work when they were messaged or resumed right after finishing
C218. [2.1.304] Fixed `claude --help` text for `--tools`, `--resume`, `--debug`, `--json-schema`, `--disable-slash-commands`, `--system-prompt-snapshot` and `claude update` to match actual behavior
C219. [2.1.304] Fixed `claude --worktree` removing the worktree and its branch without asking at exit when HEAD was detached or on another branch, which could lose commits
C220. [2.1.304] Fixed resumed and cloud sessions sending Claude the whole skill list again each time plugins reloaded at startup
C221. [2.1.304] Fixed an interrupt not ending a Read that waits on an idle pipe or device named like an image
C222. [2.1.304] Fixed `/effort status`, `/effort ultracode` and the prompt's effort indicator showing a guessed effort level when `CLAUDE_CODE_EFFORT_LEVEL` is `auto` or `unset` and no level is sent
C223. [2.1.304] Fixed a PreToolUse hook's deny reason being replaced by a timeout error when an Agent SDK callback hook on the same tool call timed out
C224. [2.1.304] Fixed Bash and PowerShell deleting a large command's output file when it could not be copied to the session's tool-results folder, unless the disk is full
C225. [2.1.304] Fixed notes typed into a multiple-choice question with previews being cut off with "…" in terminals under about 100 columns, hiding what was typed (anthropics/claude-code#82768)
C226. [2.1.304] Fixed self-paced `/loop` wakeups scheduled at the 1-hour maximum firing just after the 1-hour prompt cache expired, so those wakeups no longer re-read the conversation uncached
C227. [2.1.304] Fixed agent teams: approving a shutdown request from the main session no longer exits the whole CLI
C228. [2.1.304] Fixed a skill's `once` hook also removing another skill's identical hook after it ran
C229. [2.1.304] Fixed transcript mode's `{` and `}` landing the prompt on an inconsistent row, or off screen, instead of the transcript's first row
C230. [2.1.304] Fixed `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k` silently setting a 100K window: the variable now accepts `k` and `M` suffixes like `--autocompact`, and warns when a value is out of range or ignored
C231. [2.1.304] Fixed Ctrl+C in the agents view clearing a text selection without copying it when pressed before the mouse button was released
C232. [2.1.304] Improved `/usage` to say when a rate limit on usage data ends instead of "try again in a moment"
C233. [2.1.304] Improved the lines shown when a mod written in the session loads, reloads or fails to load
C234. [2.1.304] Improved artifacts with several views: when you ask for links to them, Claude now writes out each view's link and explains that the address bar stays the same as you switch views
C235. [2.1.304] Improved cloud sessions: a new conversation's first turn no longer waits for the local (stdio) MCP servers of plugins synced from claude.ai, unless a server sets `alwaysLoad: true`
C236. [2.1.304] Improved how a remote session recovers its status when the server refuses a status update that carried other session data
C237. [2.1.304] Improved session file size in auto mode: the safety classifier's context is no longer stored with every request
C238. [2.1.304] Improved the `claude -p` invalid-settings warning: a file that did not load lists only what stopped it, and long lists are capped per file
C239. [2.1.304] Improved resume of large compacted sessions in SDK and headless mode: the first request after resuming is sent sooner
C240. [2.1.304] Improved responsiveness and throughput when many subagents are running at the same time
C241. [2.1.304] Improved memory use when sending requests in long or resumed conversations
C242. [2.1.304] Self-hosted runner: Improved the error shown when the git host answers "not found" for a session's repository: it now names the repository and whom to ask
C243. [2.1.304] Windows: Improved git command start-up with a standard Git for Windows install by running its git.exe directly instead of through its cmd launcher
C244. [2.1.304] Changed mods' `settings.read` hooks to receive each settings layer and rewrite the merged settings, so a managed mod can make an organization's setting a ceiling, including the `cleanupPeriodDays` the retention sweep uses
C245. [2.1.304] Changed the `/artifacts` delete confirmation to show numbered choices: 1 or Enter keeps the artifact, 2 deletes it, and y, n and Esc still work
C246. [2.1.304] Changed the question that turns on the mods Claude writes in a session to plain text with no link or session id; it stays up when a new turn starts, and Claude tells you what loaded when you turn them on
C247. [2.1.304] Changed tool search to be on by default behind a custom `ANTHROPIC_BASE_URL`; a 400 or 422 from the gateway is retried without it
C248. [2.1.304] Changed compaction to send Claude the skill list again afterwards; `/reload-skills` now sends only new or changed skills
C249. [2.1.304] Changed skill hooks: the skills of one source (a repo, your own folder, or a plugin) can register at most 1,024 hooks and 16,384 matcher characters per session
C250. [2.1.304] Changed skills under a policy that allows hooks from plugins only: a skill used in the main conversation whose hooks are kept out no longer gets its `allowed-tools`
C251. [2.1.304] Updated the /claude-api skill to use the `ant` CLI on Claude Platform on AWS instead of falling back to the SDK or curl
C252. [2.1.304] Removed the notes from `claude plugin validate` that predicted where a mod's hooks would run
C253. [2.1.304] Removed the "(research preview)" label from the `/fast` dialog title on Opus 5.5
C254. [2.1.304] [VSCode] Added mod drawing in the chat panel for sessions on Amazon Bedrock, Google Vertex AI and Microsoft Foundry, behind an LLM gateway, or with telemetry turned off
C255. [2.1.304] [VSCode] Fixed one cause of sessions failing to start with "Subprocess initialization did not complete within 60000ms": time a SessionStart command hook spends running no longer counts toward the limit, up to 10 minutes in total
C256. [2.1.304] [VSCode] Fixed a session closed while it was starting keeping its Claude Code process running until the start ended
C257. [2.1.304] [VSCode] Fixed a mod's drawings disappearing from a long-open panel until the next turn on machines that also run an older Claude Code
C258. [2.1.304] [VSCode] Fixed Past conversations hiding sessions when `claudeCode.claudeProcessWrapper` is set
C259. [2.1.304] [VSCode] Changed background sub-agents to show as one status line under their Agent card instead of streaming every step into the chat; the full transcript stays in /tasks
C260. [2.1.304] [Cloud sessions] Fixed folders in the composer's @ list showing no name in cloud sessions, where picking one added only a space instead of a mention
C261. [2.1.304] [Claude Tag] Fixed Claude going silent in a thread when its channel becomes shared across Enterprise Grid workspaces mid-task; it now posts a one-time note to @-mention it in a new thread
C262. [2.1.304] [Claude Tag] Fixed `@Claude !fork` typed outside a thread getting no visible reply; Claude now shows you a private note saying to run it from inside a thread
C263. [2.1.304] [Code Review] Added review levels to Code Review: Owners choose Quick, Standard (the default), or Deep for the organization, and can give individual repositories their own level
C264. [2.1.304] [Code Review] Added an option in Code Review admin settings to review every repository in a GitHub organization, including ones added later, without selecting them one by one
C265. [2.1.304] [Code Review] Fixed pull requests opened within a minute or two of an admin turning on Code Review being silently skipped; they are now retried and reviewed
