# Claude Code release notes, 2.1.312 to 2.1.316

Numbered from ~/.harbor/cli-updates.json (checked 2026-10-31T22:38:54.438Z), installed 2.1.312, target 2.1.316. Chip flags: model, hooks, settings, background-tasks, transcript, plugins, mcp, compaction, ask-dialog, bypass-mode, trust, usage-limit, composer, titler, screen, agents-view.

## 2.1.314

C1. Added `permissions.blockWritesOutsideWorkingDirectories`: Write, Edit and NotebookEdit refuse paths outside the working directories in every permission mode
C2. Added an optional `groups` list to Claude apps gateway upstreams: only developers in the listed IdP groups are sent to that upstream, on failover too
C3. Added `guardrail_trace` to Claude apps gateway Bedrock upstreams, to log which Amazon Bedrock guardrail filter fired on a request, without the matched text
C4. Added idle compaction to VS Code and Claude Desktop's Code tab: a 200K+ token conversation left idle is summarized, and the summary is used on your next message if the prompt cache has expired
C5. Fixed sessions failing turn after turn with "Invalid effort level" when an organization's admin caps a model's effort: Claude Code now lowers the effort, retries, and says which level it uses
C6. Fixed `claude -p` exiting with code 0 and no output when startup failed; it now prints the error and exits 1
C7. Fixed Bedrock sessions with many images failing every turn and `/compact` with "400 Input is too long." instead of removing older images and compacting
C8. Fixed Microsoft Foundry sessions failing when the resource has no deployment for the default Sonnet, Opus or Haiku model: Claude Code now falls back to an older model of that family
C9. Fixed repeated refused requests behind a gateway that doesn't accept tool search's `tool_reference` blocks: the request is sent again once without tool search, and the session remembers
C10. Fixed TLS connections failing with `UNABLE_TO_GET_ISSUER_CERT` when the system certificate store holds a renewed root certificate that is cross-signed with its predecessor
C11. Fixed MCP servers that also work without sign-in showing "needs authentication" after their stored sign-in stopped working; they are now used signed out
C12. Fixed `claude mcp logout` reporting success when the MCP sign-in was not removed, for example while the macOS keychain is locked over SSH
C13. Fixed extra sign-in renewals when several sessions share an Anthropic profile login and the credentials lock is busy
C14. Fixed `claude ultrareview` and `claude remote-control` asking the workspace trust question in a CI job that has a terminal; with `CI` set they now refuse an untrusted folder at once
C15. Fixed an administrator's TLS trust settings in managed settings not being applied in Claude Desktop sessions
C16. Fixed model switching being refused on machines with managed plugin settings when one of your own `--plugin-dir` or `--plugin-url` plugins had a broken manifest or failed to download
C17. Fixed the Bedrock and Vertex model upgrade offer coming back at every start when managed settings pin the model
C18. Fixed `forceRemoteSettingsRefresh` set only in remote managed settings no longer applying once the stored copy had expired, which let sessions start without policy when the server could not be reached
C19. Fixed "Continue automatically at usage limit" continuing more than three times without a prompt from you when a task restarted itself between waits (a /goal check-in, a background or scheduled task)
C20. Fixed background and cloud sessions started with Ultracode turning it back on at their next start after it had been switched off
C21. Fixed the last broken reply and its retry prompts staying in the conversation after Claude gave up on a tool call that could not be parsed
C22. Fixed a PreCompact hook with very large output making compaction fail or repeat; each hook's output is now cut at 10,000 characters
C23. Fixed background diff refreshes briefly taking the repository's index lock, which could make a git command run at the same moment fail with "Unable to create '.git/index.lock': File exists"
C24. Fixed markdown tables jumping between grid and stacked layouts on half-typed rows while streaming, and long tables falling back to raw pipes
C25. Fixed the /resume picker showing the text of CLAUDE.md or CLAUDE.local.md as a session's title when the session only ran slash commands
C26. Fixed `/btw` answering from the main conversation when asked from a subagent's open transcript
C27. Fixed pasting an image over SSH to a Linux machine doing nothing silently; the prompt now says to copy the file over and paste its path
C28. Fixed `claude remote-control` sessions that failed to start when the session service was slow for a moment: the worker's registration is now retried with growing waits
C29. Fixed model switches over Remote Control that take over 8 seconds getting a "still pending" error instead of the final result
C30. Fixed the `sandbox.excludedCommands` setting description saying listed commands always run outside the sandbox; it now says every command in a call must match an entry
C31. Fixed shell and MCP calls that auto mode, a deny rule or a PreToolUse hook blocked, or that otherwise did not run, reading as if they ran in a collapsed tool group
C32. Fixed sandbox protections not applying to a worktree entered by `claude -p --resume` or `--continue`
C33. Fixed hooks matching Bash not running on shell commands started by the Monitor tool; such hooks can block or ask, but not approve or rewrite those commands
C34. Fixed a settings file excluded with `--setting-sources` still supplying some settings, such as auto mode rules and saved permission consents
C35. Fixed auto mode reporting a call as blocked, and listing it in `/permissions`, when its safety check gave no verdict
C36. Fixed a Claude apps gateway Vertex upstream hanging for minutes when a Google token endpoint accepts the connection and never answers
C37. Fixed the Claude apps gateway's start-up warning for a deprecated Claude Desktop key that it still serves as written saying "stops being accepted" after the key's end date
C38. Fixed `/upgrade` opening the browser and starting a new login for plans billed through the App Store or Google Play; it now says where to change the plan
C39. Fixed `--resume`, and rewinding past a switch to another model after a refusal, moving a session on a model name Claude Code doesn't recognize to a different model
C40. Fixed requests failing when a gateway or cloud provider refuses one of Claude Code's beta headers by name: the request is sent again without it
C41. Fixed model IDs spelled with a dot behind an LLM gateway, such as `claude-opus-4.8`, being treated as an older model with the wrong context window, output limit, effort, thinking mode and cost
C42. Fixed Remote Control clients showing a stray "Compacted (ctrl+o to see full summary)" row after /compact
C43. Fixed the cloud sessions tip and the Remote Control idle notice showing when an organization's policy turns those features off
C44. Fixed a resumed claude.ai cloud session making a model call nobody asked for when the previous worker stopped just after receiving a new chat's files
C45. Fixed WebFetch in Cowork cloud sessions silently dropping a PDF's text past 100,000 characters; it now says how much was unread and where to read on
C46. Fixed Claude being told only that a command was declined after you stopped it with Esc or Stop in a cloud session or the IDE; it now also hears that the command may have run
C47. Fixed blank lines at the top of a code block disappearing when the code block opens a quote
C48. Fixed a blank line appearing above some `⎿` rows in the transcript view (Ctrl+O)
C49. Fixed vim mode `dw`, `dW`, `yw` and `yW` carrying on past the end of the line, and made `w` and `W` stop on empty lines
C50. Fixed x and Enter in the agent panel sometimes acting on the wrong agent when another agent started or finished
C51. Fixed pasted text and dragged-in files being lost in Claude's question dialog unless the "Other" row had focus
C52. Fixed pasted text being lost when a row in the prompt footer was selected
C53. Fixed vim mode `p` over a character selection ignoring whether the yanked text was whole lines
C54. Fixed vim mode `aw` and `iw` taking the line break at the end of a line
C55. Fixed ↓ selecting footer items hidden by the ? help menu, the command list or a paste hint
C56. Fixed Esc on a command's panel, such as `/btw`, also interrupting the subagent whose transcript is open
C57. Fixed the welcome header in fullscreen mode showing the session's model while viewing a subagent or teammate that runs on a different model
C58. Fixed the fullscreen transcript being left mid-conversation after "Restore conversation" in the rewind menu while scrolled up
C59. Fixed a rare case where a deleted session could reappear in the resume list as an almost empty entry
C60. Fixed prompts containing tags such as `<bash-stdout>` or `<local-command-stdout>` not being acknowledged to a local stream-json host
C61. Fixed sessions staying untitled when the first prompt failed (for example on a usage limit) and the conversation continued afterward
C62. Fixed the skill file watcher checking every removed skill kept in `~/.claude/skills/.trash`, which added file system load that grew with each removal
C63. Fixed the session name from /rename disappearing while Claude asks for permission or a plan decision, so side-by-side sessions stay identifiable
C64. Fixed background sessions that fail to start being reported as a deleted daemon binary when the binary is still on disk
C65. Fixed the tip and idle reminder about push notifications appearing when the push settings in `/config` are hidden or your organization has turned off Remote Control
C66. Fixed `~/.claude/skills/.trash` and `~/.claude/plugins/.trash` growing without limit: each now holds about 1024 entries, whatever `cleanupPeriodDays` says
C67. Fixed the Bash edit diff listing a whole file as changed when a CRLF file under git's line-ending conversion was re-saved unchanged or had one line edited
C68. Self-hosted runner: Fixed an idle session moving to another runner instead of pausing when the runner's request to pause it lost its connection before Anthropic answered
C69. Improved memory use in long headless and SDK turns that run many subagents: the parent session no longer keeps each subagent's tool results until the turn ends
C70. Improved prompt history: Ctrl+R now matches text inside collapsed `[Pasted text]` pills
C71. Improved the `/design-sync` upload prompt to show the folder, the project and the files it will upload or delete
C72. Improved `/permissions` review tab, now called Recently blocked: the footer says what Esc will do with marked rows
C73. Improved auto mode's blocked calls: messages name the command, say Claude may retry and auto mode checks again, and point to `/permissions` to review
C74. Improved permission prompts: a long reason takes fewer rows, so it pushes the command being approved off the screen on fewer terminals
C75. Improved the cloud session error shown while a request refused for your claude.ai login is still being retried: it now also suggests `claude auth login`
C76. Improved the behavior of stored claude.ai, Team, and Enterprise logins when MDM and remote settings differ on base URL or `apiKeyHelper`
C77. Improved `/config` in agent view to say how to stop agent view opening by default
C78. Improved session auto-titles: a session that starts with a skill or a prompt-based command such as `/security-review` now gets a title from it instead of staying untitled
C79. Improved `--resume` speed and memory use on damaged transcripts
C80. Improved `/context` speed in sessions with ten thousand or more MCP tools
C81. Self-hosted runner: Improved the error shown when a session's branch isn't on the git remote: it now covers a never-pushed branch, says how to fix each case, and no longer suggests retrying
C82. Updated the `/claude-api` skill: its Datadog setup for API tracing now sends the `dd-llmobs-enabled: true` header, as the Console does, and its `ant` install instructions drop the outdated macOS `xattr` step
C83. Updated the bundled dataviz skill to advise printing y-axis tick labels in full under 10,000, and horizontal ones in full under a million where they fit
C84. Updated the bundled dataviz skill to answer donut and pie chart requests with ranked bars or a segmented bar that prints its values
C85. Changed Claude's file tools to ask before editing the local copy of your organization's server-managed settings, as they do for your settings files
C86. Changed `/ultrareview` to check workspace trust before it runs git, as `claude ultrareview` does
C87. Changed the Bash tool's shell to clear any inherited `which` alias or function and to stop passing exported `which`/`unsetenv` functions to commands, so `which` is the system command or zsh builtin
C88. Changed `/permissions` Recently blocked to refuse approving a call you can't read in full, including one the terminal is too short to show
C89. Changed auto mode in Cowork cloud sessions: a hook's allow of an MCP tool call now counts as no answer, so the classifier or a permission prompt decides
C90. Changed hook `if` conditions such as `Monitor(tail *)` to match the Monitor tool's shell commands as `Bash(tail *)` matches Bash's
C91. Changed the `claude-api` skill to ask to read a Managed Agents workflow run's workflow before changing the agent to improve that run
C92. Changed flagged requests to retry on another model, not end in a refusal, when `ANTHROPIC_DEFAULT_OPUS_MODEL`, `availableModels` or `deniedModels` leaves only an older Opus model, or none
C93. Changed idle compaction to also run for subscribers with telemetry turned off, and on Bedrock, Vertex, Foundry and LLM gateways once the one-hour prompt cache is on
C94. Changed `FORCE_HYPERLINK=false` (also `no` and `off`) to turn hyperlinks off instead of on
C95. macOS: Changed `git grep` in most commands that Claude runs to use the C locale, to avoid a reported memory leak in macOS's regex library on files that aren't valid UTF-8
C96. [VSCode] Fixed "Clear authentication" for MCP servers reporting success when the saved sign-in could not be removed
C97. [VSCode] Fixed missing spinner and Stop button while a queued message's hooks run
C98. [VSCode] Fixed session group changes that cannot be saved, such as a delete, failing silently; an error notification now appears
C99. [VSCode] Fixed Cmd+F / Ctrl+F not opening the find widget in the plan preview tab
C100. [VSCode] Fixed the voice dictation shortcut (Ctrl+D) doing nothing under non-Latin keyboard layouts such as Russian, Greek or Hebrew
C101. [VSCode] Fixed missed one-time saved scheduled tasks being deleted without asking when the extension opened without a chat
C102. [VSCode] Changed `CLAUDE_CODE_DISABLE_CFC_PROMPT` to also stop the extension adding the Claude in Chrome instructions to a session's messages; the browser tools stay available
C103. [Cloud sessions] Added an Include completed button to the Scheduled tasks page when finished one-off tasks are the only ones hidden, so you can show them without opening the Sort menu
C104. [Cloud sessions] Fixed recently used self-hosted environments never appearing among the recent environments on the new session card
C105. [Cloud sessions] Fixed cloud sessions reporting uncommitted changes every turn after Claude moved a branch to a commit it had pushed from another worktree
C106. [Cloud sessions] Fixed the self-hosted environment details dialog in admin settings squeezing its content out of view in very short windows or at high zoom; the dialog now scrolls
C107. [Cloud sessions] Fixed the permission mode picker staying on Auto after a running cloud or Remote Control session refused the switch; it now shows the mode in use and tells you
C108. [Cloud sessions] Improved scheduled tasks: runs in Anthropic's cloud now load the plugins enabled on your claude.ai account
C109. [Cloud sessions] Improved Test connection for GitHub Enterprise in admin settings to also connect the way cloud sessions do, and to warn you when that second test fails
C110. [Cloud sessions] Improved cloud session transcripts: a rename row now names the new title, and repository and environment lists show as a table instead of one line of JSON
C111. [Cloud sessions] Changed cloud sessions from the web, desktop and mobile apps to start even when a setup script exits with an error, instead of failing to start
C112. [Remote Control] Fixed the permission mode button in Remote Control sessions showing the wrong mode until you typed; while your computer is online it now shows the real mode on open
C113. [Claude Tag] Added a dismissible link to the Claude Tag API docs on the Bundles and Channels tabs in admin settings, for Enterprise organizations with Slack connected
C114. [Claude Tag] Fixed `@Claude !restart` giving up after one failed workspace check in channels shared across Enterprise Grid workspaces; it now retries, then asks you to run it again
C115. [Claude Tag] Fixed a second confirmation DM and channel note when you connect your Claude account from Slack twice from the same link within a few minutes
C116. [Claude Tag] Fixed follow-up messages in Slack showing no sign of progress while Claude's session waits for a self-hosted runner; Claude now posts a wait notice in the thread
C117. [Claude Tag] Fixed Claude sometimes not answering a tag in its own thread in Slack Connect channels where both organizations have installed Claude
C118. [Claude Tag] Fixed Retry on plugin and skill pages in Claude Tag admin settings discarding unsaved access changes after a failed load; your edits now stay in place
C119. [Claude Tag] Fixed the repositories control in Claude Tag admin settings showing the same action twice; its menu now lists only what the button doesn't already do

## 2.1.316

C120. Added `CLAUDE_CODE_DISABLE_ULTRATHINK`, which turns the `ultrathink` keyword off
C121. Added pooled group budgets to the Claude apps gateway: one monthly budget that a group's members share, on top of each member's own limit, set with `pooled_budget` on the spend limits admin API
C122. Added `CLAUDE_CODE_DISABLE_LOOPED_CROSS_CERT_DROP` to keep system cross-certificates that certify each other in a loop, for servers whose private CA needs one
C123. Added `CLAUDE_CODE_SUBAGENT_EFFORT` to set the effort level subagents run at when nothing else names one, instead of inheriting the session's
C124. Added `managed.policy_mode: layered` to the Claude apps gateway: every policy that matches a developer applies, each merged over the ones listed below it, not only the first
C125. Added `guardrail.input_tagging` on Claude apps gateway Bedrock upstreams, which wraps prompts in the input tags that an Amazon Bedrock guardrail's prompt attacks filter needs; `all_messages_and_system` also tags the system prompt
C126. Deprecated fast mode for Opus 4.8 as of October 30, 2026; it will be removed on November 30, 2026. After removal, fast mode requests on Opus 4.8 return an error and do not fall back to standard Opus 4.8. Migrate to Opus 5.5 to keep the speedup
C127. Fixed shell commands being left running on macOS and Linux when Claude Code exits by itself, for example when credentials are refused or a cloud session is archived
C128. Fixed bash aliases with line breaks in their value (except in Git Bash), and functions whose names start with a dash, being garbled or lost in the Bash tool's shell
C129. Fixed bash scripts started from the Bash tool stopping after their first command when `SHELLOPTS` is exported
C130. Fixed PowerShell hooks not blocking on exit code 2 when the command begins with a type cast, `param`, `using` or an attribute
C131. Fixed some network requests hanging when a compressed response was cut off or corrupted
C132. Fixed `sonnet`, `opus` and `haiku` on Vertex AI and Amazon Bedrock showing an error mid-session instead of switching to an older model when the newest is not yet available to the account or region
C133. Fixed the Claude apps gateway not checking every model a request names against `availableModels`, `deniedModels` and `models`; a request that names a blocked model now gets a 400 naming the field
C134. Fixed `claude auth login` refusing to run where managed settings require a Claude apps gateway; in a terminal it now shows the gateway sign-in
C135. Fixed `--restricted` sessions uploading files from outside the working directories when a Read allow rule covered them
C136. Fixed prompts containing invisible characters needing a second Enter to send; plain prompts now send cleaned on the first Enter, and commands still wait for review
C137. Fixed sub-agents that inherited a parent sub-agent's model moving to the main model when a background job or message woke them
C138. Fixed a managed `autoMode.allow` list without `"$defaults"` getting the built-in exceptions back from a host app's `--settings`, a first rule added in `/permissions`, or `/auto-mode-setup`
C139. Fixed cloud sessions and cloud scheduled tasks not being marked as failed when auto mode stopped a turn because the server returned no safety verdict
C140. Fixed `claude -p` text output sometimes not saying why auto mode stopped a turn when a background agent was still running
C141. Fixed `CLAUDE_CODE_AUTO_MODE_SERVER=1` being ignored in sessions started by a host application (such as Claude Desktop) behind a proxy or LLM gateway with experimental betas turned off
C142. Fixed plugin MCP `headersHelper` scripts receiving a corrupted `CLAUDE_PLUGIN_ROOT` and server URL when a credential-named environment variable was set to a switch value such as `1`
C143. Fixed the SDK `register_repo_root` control request not loading the CLAUDE.md of a directory outside the working directory (with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`)
C144. Fixed the Artifact tool showing `?` for artifact database access rules at the `self` level, and not quoting those rules back when it refuses a republish that would drop them
C145. Fixed `/model <id>` not warning when the model isn't recognized by this version and auto-compact will assume a 200K context window
C146. Fixed the "hold space to speak" hint using up its three showings in one session, and showing an empty key when push-to-talk is unbound
C147. Fixed Grep and Glob never returning when the search process is killed at the timeout but does not exit, seen on Windows
C148. Fixed a rare case where resuming a conversation did not restore its plan, when `/clear` or `/resume` had been run while part of that conversation was still being saved
C149. Fixed first-run setup dropping words from the security notes and the terminal-setup explanation in narrow terminals
C150. Fixed the Enterprise survey card taking a typed 1 or 0 after a short pause; a typed answer now needs Enter
C151. Self-hosted runner: Fixed a message sent while Claude was working being answered after a Stop, once the session's process had been replaced
C152. Self-hosted runner: Fixed an MCP server's on/off switch sometimes being lost when a session moved to a new machine
C153. Windows: Fixed the Bash tool losing your aliases and functions in Git Bash when the rc file sets errexit and pipefail and only winpty aliases, or none, are defined
C154. Improved `/code-review` started from the Code tab in Claude Desktop or on the web: cloud and `claude remote-control` sessions now show the findings card, not a plain-text list
C155. Improved `/diff` on large repositories: each refresh usually runs one fewer full-repository git command, and refreshes are spaced out when git is slow
C156. Improved the messages shown when `/ultrareview`, a cloud session or a cloud agent finds no GitHub remote: they now say to create a repository at https://github.com/new, and `/ultrareview` no longer suggests a `gh` command that `gh` rejects
C157. Improved SSL certificate errors to name the likely causes, among them a server that leaves out an intermediate certificate, and the fix for each
C158. Changed auto mode so that an `autoMode.allow` list without `"$defaults"` no longer removes the built-in rule on scheduled-task prompts
C159. Changed server-managed settings for Team and Enterprise logins: settings fetched from Anthropic's API now apply without an approval prompt, and a stored copy that doesn't verify is refused
C160. [VSCode] Added sign-in to a Claude apps gateway from the chat panel, with no terminal needed
C161. [VSCode] Changed `ultrathink` to run its turn at `xhigh` effort and show in a rainbow in the chat box, as in the terminal
C162. [VSCode] Fixed the missing Effort slider, Ultracode switch and model name when the model setting has the `[1m]` tag, such as `opus[1m]`
C163. [VSCode] Fixed saved `/btw` side-question history being deleted too early while a settings file has errors
C164. [VSCode] Fixed a conversation coming back in Auto mode after a reload or restart when its plan was approved with "Yes, and manually approve edits"
C165. [Cloud sessions] Added a form card to cloud sessions, so you can fill in or decline a form an MCP server asks for instead of the request being canceled without you seeing it
C166. [Cloud sessions] Added a "Catching up…" line that shows while a cloud or Remote Control session you switch back to is still bringing its messages up to date
C167. [Cloud sessions] Changed network secrets so Enterprise members can add and delete them on their own cloud environments, instead of only viewing them
C168. [Cloud sessions] Improved the Changes pane for cloud sessions: the note about what the list leaves out is now a badge beside the branch name, not a row above the diff
C169. [Cloud sessions] Fixed file search in a cloud session's Files pane showing folders as ../.. paths after Claude changed directory; results now show their path from the project's root
C170. [Claude Tag] Fixed Claude refusing to edit or append to a canvas it made in a Slack channel, from that channel, once the canvas was also shared to another channel or a DM
C171. [Claude Tag] Fixed untagged replies going unanswered in a Slack Connect thread when both organizations have installed Claude and Slack delivered the reply to the other organization's app
C172. [Claude Tag] Fixed a cloud scheduled task's live status checklist in Slack staying half-done; a run can now edit the top-level messages it posted during that run
C173. [Claude Tag] Changed a Slack channel's Respond automatically switch to a "How Claude participates" choice on the channel's Configure page and in Claude Tag admin settings
C174. [Code Review] Added a findings-by-severity card to the Code Review analytics page, showing the period's total findings, a daily chart stacked by severity, and each severity's count
