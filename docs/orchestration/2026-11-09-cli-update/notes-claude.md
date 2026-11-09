# Claude Code release notes, 2.1.316 to 2.1.321

Numbered from the CHANGELOG.md on GitHub, fetched 2026-11-09. npm published no 2.1.320. Target 2.1.321.


## 2.1.321

C1. Added Claude Fable 5.2 (`claude-fable-5-2`), now the default Fable model — 1M context, $8/$40 per Mtok with $0.20/Mtok cache reads
C2. Added `--settings <file>` to `claude remote-control`, which applies a settings file to every session it starts; if the file changes, no new session starts until you restart `claude remote-control`
C3. Fixed MCP OAuth requests sending secrets such as refresh tokens to another host when a server redirected them
C4. Fixed a case where a read-only Bash command ran outside the sandbox without a permission prompt
C5. Fixed a case where Bash permission checks judged a file write from the wrong folder and didn't prompt
C6. Fixed deny rules and protected-file prompts not applying to the file that a `cp` or `mv` into a directory writes
C7. Fixed the "Draws from usage credits" note showing after a switch to Fable on Enterprise seats whose plan includes Fable
C8. Fixed the fallback model sometimes declining a request or mentioning a stopped response when the first model was blocked before replying
C9. Fixed `claude mcp login` printing a SEP-2352 issuer warning each time you sign in again to a server that Claude Code registered with
C10. Fixed `NotebookEdit` deleting or overwriting a notebook's first cell when the call named no cell, on network paths (UNC shares, WSL folders, `/net` mounts)
C11. Fixed Edit changing the first of several matches, replacing a whole file on an empty `old_string`, or editing a notebook as text, on network paths (UNC shares, WSL folders, `/net` mounts)
C12. Fixed `/config` showing Manual as the default permission mode when new sessions start in auto mode; pressing Space on "Auto (default)" now saves Don't Ask, not Plan
C13. Windows: Fixed `FileChanged` hooks stopping for paths set through `watchPaths` after the first shell command, when the session's working directory had a lowercase drive letter
C14. Fixed `--plugin-dir .` and `--plugin-dir ./builtin` writing generated type files for Claude Code's built-in plugins into a `builtin` folder
C15. Fixed context usage estimates overcounting tool definitions when exact token counts are unavailable
C16. Fixed `/compact` showing twice in Remote Control on web and mobile
C17. Fixed plugin auto-updates and `/plugin` marketplace updates downloading a plugin again for each worktree or folder of a repository
C18. Fixed auto mode losing a background subagent's report that had started a turn when the conversation was compacted before Claude answered it
C19. Fixed project skills, commands and agents staying missing after their folder was removed and came back mid-session, such as with `git stash`, including after entering a worktree
C20. Fixed `claude -p` sometimes telling Claude that background commands get 30 minutes when they are stopped after 10
C21. Fixed `pkill`, `pgrep` and `pidwait` in cloud sessions matching the session's own parent processes
C22. Fixed Claude in Chrome and computer use server processes staying alive after their parent exits behind a proxy that stalls connections
C23. Fixed a large hook output pointing Claude to a file that held another hook's output from the same tool call
C24. Fixed apps that embed Claude Code getting their own PreToolUse hook's `ask` reason instead of another hook's when both asked
C25. Fixed a PreToolUse hook's `ask` being lost when another hook's `defer` finished first and could not be honored
C26. Fixed a rare crash on permission prompts and background tasks
C27. Fixed project skills, commands and agents disappearing from the menu in SDK and desktop sessions after Claude entered a worktree
C28. Fixed `/desktop` on macOS saying Claude Desktop is not installed when it is in `~/Applications`
C29. Fixed OpenTelemetry repository attributes (`vcs.*`) missing from Claude Desktop sessions that start on a pre-started process
C30. Fixed WebFetch passing "No response from model" to Claude as page content when the model reading the page returned no text; the call now fails with a clear error
C31. Fixed screen reader mode delaying the prompt at startup when the system clock moved back while Claude Code was starting
C32. Fixed a command's panel sometimes not coming back after a dialog closed, leaving no panel or prompt on screen until the next redraw
C33. Fixed a project's MCP server being disconnected after the first message in a Claude Desktop Code tab session when the desktop app has an MCP server or extension of the same name
C34. Fixed a turn ending with "API Error: EPROTO: The TLS handshake failed" when the connection broke partway through a reply; the partial reply is kept or the request is retried, as before 2.1.302
C35. Fixed high memory use in long sessions that repeatedly read single lines from large files
C36. Fixed fast mode losing replies, switching models or retrying for minutes when fast serving is rate-limited, overloaded or failing; it now tries standard speed on the same model first
C37. Fixed one request carrying far more background agent reports than intended after Claude was stopped while several were waiting
C38. Fixed messages from a Claude Desktop Code tab session to your other sessions staying paused after you typed while Claude was still working
C39. Fixed `claude agents` ignoring `--permission-mode`, `--dangerously-skip-permissions`, `--model`, `--effort` or `--agent` typed before `agents` when a flag such as `--verbose` was also on the line
C40. Fixed a case where Remote Control showed as off with "login expired" in the desktop app while its connection was still up, because the app was briefly unable to hand over a sign-in token
C41. Fixed a Remote Control message sent with "Queue for later" reaching Claude in the middle of the running turn
C42. Fixed the git status given to Claude at session start reading as clean when git status failed; it now reads as unavailable
C43. Fixed the git status given to Claude at session start showing the first listed file as staged when its changes were not staged
C44. Fixed a hang or out-of-memory crash when a connector in a cloud session lists resources with very long names
C45. Fixed Remote Control showing as connected after its connection closed for good while the session's history was still uploading
C46. Fixed screen reader mode turning off when you return to a conversation from agent view
C47. Fixed screen reader mode y/n questions taking as yes a stray "y" at the end of text typed as the question opened
C48. Fixed cloud sessions telling Claude that a host is probably not allowed when it is allowed and the network proxy could not connect to it
C49. Fixed an MCP server sometimes showing as connected with no tools after it was reconnected or the session's directory changed while its tools were still loading
C50. Fixed Bash commands sometimes running in the wrong folder when Claude sent several at once and an earlier one changed folders
C51. Fixed files Claude sends from cloud and Remote Control sessions failing at once when an upload gets an HTTP 507 from a proxy; the upload now gets a second try
C52. Fixed new messages not being saved, and `claude -p`, SDK and VS Code sessions hanging, when memory ran out while the transcript was being read
C53. Fixed sign-in, token refresh and logout waiting indefinitely when something on the network accepts the connection but never answers the TLS handshake
C54. Fixed a sent file showing under a different name in the Claude apps when its name hid text-direction or control characters; Claude now refuses to send such a file
C55. Fixed sub-agent progress summaries running a request to its end after the model replied with a tool call
C56. Fixed Bash reads such as `grep -r foo "$PWD/src"` asking for permission when the same command with the path typed out runs without asking
C57. Fixed Claude apps gateway refusing to start when a `desktop` setting holds a field newer than the gateway, such as a managed MCP server's `oauth.omitResource`; it now warns and serves it
C58. Fixed Bash commands coming back empty for zsh users whose `.zshrc` sets `KSH_OPTION_PRINT`
C59. macOS: Fixed "Unable to read managed policy settings" at startup when a valid MDM profile was slow to read: the read is retried once, and a timeout is now reported as a timeout
C60. Fixed agent view erasing another agent view's saved input text when it restarted for an update with nothing typed
C61. Fixed remote sessions giving no reply after a restart when a `UserPromptSubmit` hook blocked a replayed permission answer; these hooks no longer run on that replay
C62. Fixed `claude remote-control` accepting a `y` typed without Enter at its first-run question when the terminal's input ended
C63. Fixed Claude Desktop not showing spend limit warnings behind a Claude apps gateway whose policy has no `code:` rules
C64. Fixed fullscreen sessions with some plugins ending with an error when a tool result that had got shorter scrolled off the top of the screen
C65. Fixed prompt suggestions making extra API requests when the model replied with a tool call
C66. Fixed `PreToolUse` `mcp_tool` hooks on stdio and HTTP MCP servers being skipped when their answer was over 16 MiB; the tool call is now refused
C67. Fixed skill and command names holding a Bamum letter that some fonts draw as blank: they are now refused
C68. Fixed `claude -p` on Linux exiting 0 in silence when a full NFS export or a used-up NFS quota lost transcript lines: it now prints an error and, in text and json output, exits 1
C69. Fixed background agents being reported as stopped by the user, and refused a resume, when a service interrupted a cloud session and nobody pressed Stop
C70. Fixed NotebookEdit reporting success to hooks and telemetry when the edit failed, for example when the notebook changed while the permission prompt was open
C71. Fixed a blank screen or no answer at startup, and empty `claude mcp list` output, when a stored MCP sign-in record was null
C72. Fixed the Artifact tool telling Claude to add filters when an artifact's database collection is too large to sort; it now says to read the collection page by page and sort the results
C73. Fixed a restarted cloud session dropping a message with a large image when the restart came before Claude's first reply to it
C74. Fixed a restarted cloud session leaving a subagent's message to the main conversation unanswered
C75. Fixed Claude not being told when you stop or pause a running workflow, so it no longer says the workflow is still running
C76. Improved the `/model` picker: "More models" is now an unnumbered row below every other, and older models open under it without renumbering the rest
C77. Gateway: Improved spend limits on a busy replica, which now skips fewer checks and records spend sooner
C78. Improved the Claude apps gateway's sign-in limit messages in Claude Code and on the `/device` page: they no longer name gateway settings, which the gateway's own log still names
C79. Improved `claude install` and the install scripts: they finish 2 to 4 seconds sooner
C80. Improved how soon a Remote Control session whose process crashed can pick up a new message
C81. Windows: Improved startup and first-command time by finding programs on PATH without starting a helper process
C82. Improved auto mode in headless sessions, the desktop app and VS Code: reports from background subagents that wait together are answered in one model call, as in the terminal
C83. Improved the agent view's row for a `claude --bg --worktree` session that couldn't set up its worktree: it now shows the error from its beginning, not an internal tag or its last 200 characters
C84. Improved the messages shown when an artifact is in another organization: `/login` is offered only if it's one of yours, and Claude now says where a copy may be after an account move
C85. Improved sessions with more images than fit in one request: Claude is told whether it has already seen a dropped image, and repeat reads of an unchanged image are limited
C86. Improved `claude remote-control`'s messages for an unanswered first-run question: each now says what to do next
C87. Improved start-up time by loading trusted TLS certificates faster
C88. Improved Claude apps gateway error messages to show the gateway's address without any user name or password
C89. Improved the Claude apps gateway's spend limit error: the reset now shows in your local time, such as "resets 4pm (America/Los_Angeles)"
C90. Windows: Improved startup time with a standard Git for Windows install by no longer checking which git.exe to run on every launch
C91. Updated the session-feedback message and the `allowedProviders` setting description to name Ultra alongside Pro and Max, and the `forceLoginMethod` description to cover every paid Claude plan
C92. Updated the bundled dataviz skill to suggest a list of meters, one row per item, for several ratios that each have their own limit
C93. Updated the "Upgrade to Max" options to say "Upgrade to Max or Ultra"
C94. Changed mods Claude writes to turn on without asking in auto and bypass modes, even with managed `allowUnsandboxedCommands: false` or `allowManagedDomainsOnly`, and not to load in `dontAsk` mode
C95. Changed mods' own tool calls (`$.tool.call`, `$.mcp.call`) to raise no permission prompt, even under your own ask rules or in `dontAsk` and `-p` runs; deny rules and organization policy still apply
C96. Changed saved Fable 5.1 model picks to move to `fable`: on Pro and Max plans at once, on Team and Enterprise plans once your organization allows it; use `/model claude-fable-5-1` to switch back
C97. Changed the fast mode labels in `/fast`, `/config` and `/model` to name your current model when it supports fast mode, and removed "(Opus only)" from the VS Code row
C98. Changed nested skill loading: `.claude/skills` folders inside `~/.claude/plugins` no longer load when Claude works on files there
C99. Self-hosted runner: Changed an on-demand runner that the server refuses because it is not needed (session ended or paused, work order superseded) to exit 0 instead of 1
C100. Windows: Changed how Claude Code finds programs it starts itself, such as git, to skip relative and UNC PATH entries and links onto a network share, and to pick up PATH changes from settings
C101. Changed OpenTelemetry hook events in non-interactive sessions to leave two built-in hooks out of `num_hooks` and `num_success` after Bash and PowerShell calls
C102. Changed the number of messages a Claude Desktop Code tab session can send to your other sessions before it waits for you to type again from 10 to 20
C103. Changed `AskUserQuestion` in `claude -p` and SDK sessions to deny a host's permission answer that sets the undocumented `afkTimeoutMs` input field
C104. Changed managed `extraKnownMarketplaces`: a declared name can't be added from another source, an entry from elsewhere is hidden, and plugins the declared marketplace lists are reinstalled from it
C105. Changed Claude in Chrome tools that an app running Claude Code provides, such as the Claude desktop app's Code tab, to follow your organization's Claude in Chrome policy
C106. Changed `policy_mode: layered` in the Claude apps gateway: managed MCP servers now add up over every matching policy, `match: {}` included, so a gateway already on it serves more after the upgrade
C107. Gateway: Changed Bedrock, Vertex and Foundry upstreams to ignore the `ANTHROPIC_*_BASE_URL` variables in the gateway's environment. Set `base_url` on the upstream to use another endpoint
C108. Changed headless sessions to reload mods in `.claude/skills` when their files change; set `CLAUDE_CODE_PLUGIN_DIR_WATCH=0` to turn this off
C109. Changed the Cyber Verification Program sentence on a cyber safeguard block to use the same words as claude.ai
C110. Changed Cowork cloud sessions: a PostToolUse hook can no longer replace the answer to AskUserQuestion or the plan in ExitPlanMode's result; Claude reads the originals
C111. Changed `cp` and `mv` spelled by a path, such as `/bin/cp`, to get the same path checks as `cp` and `mv`
C112. Changed background command notifications and TaskStop results to show Claude only the start and end of a command over 1,000 characters, which saves context
C113. Changed artifact design guidance to treat Inter and Space Grotesk as good default typefaces
C114. Changed the account email check to refuse only a shell command that holds your email and names a User-Agent, without asking, so other commands and scheduled runs no longer stop at its prompt
C115. Changed Remote Control sessions to keep the folder they were started in: a connected client can no longer move a session to another folder
C116. Changed managed `extraKnownMarketplaces` take-overs from an undeclared source: saved data is set aside for `cleanupPeriodDays`, and options and secrets until `claude plugin restore-set-aside`
C117. [VSCode] Added a warning above the prompt box when both an auth token and an API key are set, matching the terminal's startup warning
C118. [VSCode] Fixed a plugin's permission request showing a name with hidden characters: it now reads "a plugin"

## 2.1.319

C119. Changed auto mode with telemetry or feature flags off, including behind LLM gateways: calls the server can't check are asked about or denied, with no fallback to the built-in classifier; set `CLAUDE_CODE_AUTO_MODE_SERVER=0` to keep using it (Bedrock, Vertex and Foundry are unchanged)
C120. Changed auto mode behind an LLM gateway: `CLAUDE_CODE_AUTO_MODE_SERVER=1` turns on the server-side check even with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set; if managed settings set the latter, they must set the `1` too
C121. Added support for MCP tasks in the terminal: when an MCP server runs a tool call as a task, Claude Code moves it to the background right away and tells Claude the result when it finishes
C122. Added the `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` environment variable to make Claude Code wait for an MCP task inside its tool call instead of moving it to the background right away
C123. Added `permissions.denyInsteadOfPrompting` setting: a tool call that would wait on a permission prompt is denied and the turn continues, in terminal sessions, subagents and teammates
C124. Added `/claude-api latency-optimize` to find where your Claude API code makes people wait and try faster settings against your eval
C125. Added the `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` environment variable, which stops feature-flag fetching without turning off telemetry; every flag then uses its built-in default
C126. Added spend for today, this week and this month to `/usage` for developers behind a Claude apps gateway who have no spend limit, when the gateway runs this version or later
C127. Added `admin.pooled_conflict_rule` and `admin.pooled_priority_order` to the Claude apps gateway, to set which pooled group budget pays first for a developer in several groups
C128. Added an optional `login_notice` setting to the Claude apps gateway that shows an operator-defined message on the gateway's browser verification page and on Claude Code's sign-in screen
C129. Added `CLAUDE_GATEWAY_LOG_FORMAT=json` to the Claude apps gateway: operational log lines become JSON with `severity`, `time` and `message`, for log collectors that read the level from a field
C130. Added a Claude apps gateway boot warning for a case where another policy's `availableModels` also allows a custom model id that one policy lists by name
C131. Added start-up warnings to the Claude apps gateway for policies with no `desktopHome` that rely on `coworkTabEnabled: false` or `chatSessionRetentionDays`, ahead of Claude Desktop's November 10 change
C132. Added a warning when your claude.ai login ends and Claude Code continues on the sign-in from `ant auth login`, which bills usage to your Claude Console organization
C133. Added a line at startup naming the Claude Console organization that is billed in a case where Claude Code uses the sign-in from `ant auth login`
C134. Added an "Earlier in this session" row to `/tasks` that lists finished subagents, so you can reopen one and message it even after it leaves the list or you restart
C135. Added a note to `/loop` confirmations in cloud sessions that a timer stops with its container, with an offer of a loop that survives
C136. Fixed MCP servers on the older handshake failing to connect, or returning empty results, because Claude Code declared an extension that it only uses with newer servers
C137. Fixed a long-running MCP tool call on a claude.ai connector sometimes never reporting its result after `--resume`
C138. Fixed a session's diff failing to load on claude.ai and the mobile apps when the folder Claude Code runs in has a file or folder named `HEAD`
C139. Fixed `/diff` showing "Diff unavailable" when a git repository has a file or folder named `HEAD` at its top level
C140. Fixed the `/diff` pane opening blank in sessions where 64 or more turns edited files
C141. Fixed slash commands typed after a leading space, tab or newline being sent to Claude as plain text instead of running
C142. Fixed a request that kept failing with a 401 refreshing your login on every retry and causing 401s in your other sessions
C143. Fixed `/context` sending its full visual grid to Claude on every later turn; Claude now reads only the table
C144. Fixed `claude -p` exiting 0 in auto mode when its actions were refused because no safety check was available: text and JSON output now exit 1
C145. Fixed a case where Claude Code listed every project file at start on Linux for projects on a network file system (NFS, SMB, Lustre and similar)
C146. Fixed a case where auto mode was wrongly refused when a client sent a model change and a request for auto mode back to back
C147. Fixed `/status` showing "Auto mode server: Enabled" when the server-side review isn't reaching the session, for example behind an LLM gateway that drops it
C148. Fixed Claude-drafted feedback, surveys and `/feedback` continuing to appear after the server refused feedback for your organization
C149. Fixed Claude drafting feedback on third-party gateways, where it can't be sent
C150. Fixed auto mode refusing actions without saying why when permission rules or `autoMode` settings are very large: it now explains and, unless `autoMode` deny rules are set, asks you in the terminal
C151. Fixed a case where Bash deny and ask rules missed commands written with quoted words
C152. Fixed subagent hand-back reports showing an internal marker and provenance note when expanded outside verbose mode
C153. Fixed `claude -p --resume` with a prompt losing a deferred tool call when its MCP server is missing: the run now exits 1, keeps the call and refuses later input
C154. Fixed a case where text was dropped from informational messages sent to SDK clients
C155. Fixed a case where Agent SDK hosts got a generic exit-code error instead of a failed run's own error message when the disk was full
C156. Fixed `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` re-running a turn that was interrupted in plan mode when the session resumes in another permission mode
C157. Fixed edits to a settings file being ignored when made within a few seconds of Claude Code writing that file
C158. Fixed a config file left at the legacy name hiding your setup with no warning: Claude Code now says on stderr when a home holds two config files, and which is in use
C159. Fixed `~/.claude.json`, settings and edited files ending up empty or cut off when the disk fills during a save in a read-only folder or to a bind-mounted file (one session saving at a time)
C160. Fixed Write ending the turn as a refusal when it couldn't read the file to overwrite
C161. Fixed background Bash commands that finish almost instantly losing their output while being reported as completed
C162. Fixed the Bash tool's diff of changed files missing a file that the command wrote just before it ended
C163. Fixed a mistyped model name, such as `opus-5-5`, telling you to update Claude Code instead of suggesting the model you meant
C164. Fixed a case where `NotebookEdit` changed the wrong cell when the notebook changed while a permission prompt was open
C165. Fixed a ~0.5s hang after pressing Enter on the `/login` success screen: the dialog now dismisses immediately and the post-login refresh runs in the background
C166. Fixed Ctrl+G not opening the external editor while typing an "Other" answer to a question in screen reader mode
C167. Fixed Monitor's WebSocket watch failing with "could not resolve" behind a proxy when `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` is set and the machine has no DNS of its own
C168. Fixed `claude plugin eval` warnings suggesting `max: 0` for a tool that must not be called, which could never pass
C169. Fixed background plugin auto-update not installing a dependency added by the updated plugin version
C170. Fixed Cmd+click not opening links in Ghostty over tmux in sessions opened from the agents view
C171. Fixed a mod's hot reload in `.claude/skills` missing a file that was deleted just after it appeared, and missing its return
C172. Fixed `/rewind` failing with "No files were restored" when restoring code to a checkpoint from before `/branch`
C173. Fixed the `/claude-api` skill saying Console web settings don't apply to Managed Agents sessions, and tightened its credential and permission examples
C174. Fixed needless permission prompts for read-only commands wrapped in a plain `timeout DURATION`, such as `timeout 30 rg foo`
C175. Fixed WebFetch describing claude.ai shared-chat links as empty pages; it now says shared chats can't be read and to paste the conversation instead
C176. Fixed Artifact database calls being re-sent to artifacts without a database; errors now say whether republishing helps
C177. Fixed a case where artifact database reads that save to a folder (`out_dir`) were refused
C178. Fixed detailed beta tracing not presenting `CLAUDE_CODE_CLIENT_CERT` to collectors that require a client certificate
C179. Fixed the OpenTelemetry `claude_code.session.count` metric counting Agent SDK `prewarm()` processes that were never claimed; a pre-started process now counts once, when it is claimed
C180. Fixed `/clear` killing running commands of background agents, teammates and workflows that keep running, and foreground subagents of background agents and teammates
C181. Fixed a terminal whose Claude apps gateway sign-in had expired sending telemetry and managed-settings requests that the gateway refused and logged as `invalid_token`
C182. Fixed the agents view appearing to send a reply to a background session waiting on a permission prompt; the reply now stays in the box with a hint to open the session and answer
C183. Fixed agent view removing a draft saved by another agent view in the same directory when exiting
C184. Fixed a case where agent view came back with another agent view's input text after restarting itself for an update
C185. Fixed the agents view preview cutting off long commands, results and status lines without an ellipsis, and dropping `**`, backticks and tags from commands waiting for approval
C186. Fixed Claude in Chrome reporting the extension as not connected when the connection dropped mid-action; Claude now checks the page before repeating an action that may have run
C187. Fixed Remote Control sessions still showing "Limit reached" on other devices after a usage limit was lifted outside the session
C188. Fixed the file card sometimes missing in the Claude iOS app when Claude sent a single file
C189. Fixed self-hosted runner sessions failing with no explanation when the server keeps refusing to renew model access: the runner now retries sooner and posts a warning in the session
C190. Fixed `/permissions` in cloud sessions replying only that it isn't available; it now says where the session's rules live and how to change them
C191. Fixed cloud sessions losing session-scoped deny and ask permission rules, such as those a PermissionRequest hook adds, when the session moves to a new worker
C192. Fixed mod hot-reloading turning off for the session when you typed three messages instead of answering its question in a cloud session
C193. Fixed background tasks that keep running after `/clear` disappearing from the task list in Claude Code on the web until another task started or ended
C194. Fixed hidden commands appearing in the slash command menu of cloud sessions on mobile and web
C195. Fixed a case where `/rewind` could restore or delete a file through a directory symlink
C196. Fixed a case where a `sed` command could skip the permission check in accept-edits and auto mode
C197. Fixed a case where `CLAUDE_CODE_AUTO_MODE_SERVER=1` in managed settings was ignored behind an LLM gateway when the gateway's URL is set only there and server-managed settings can't be fetched
C198. Fixed a Bash permission bypass where a crafted environment prefix could hide part of a command from permission checks
C199. Fixed a case where deny and ask rules, hook matchers and `disallowedTools` entries written with a claude.ai connector's terminal name (`mcp__claude_ai_Slack`) were ignored in Claude Desktop (takes effect once Claude Desktop includes this version)
C200. Fixed a sandbox escape when creating a worktree
C201. Fixed self-hosted runners: `--trust-workspace false` now also stops hooks in the repository's settings files and skills from running
C202. Fixed a case where idle background sessions started through a shell-exported LLM gateway left the gateway after an update
C203. Fixed help links in `/status` and the auto mode billing notice opening only part of the address when they wrap
C204. Fixed a case where certificate errors behind a TLS-inspecting proxy persisted when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` was set. With it set, Claude Code now makes a TLS handshake with the configured API host after a certificate failure, through your http:// proxy if one is set; it sends no API request
C205. Fixed `claude remote-control` exiting silently with status 0 when a first-run question gets no answer (scripts, services, batch jobs, Ctrl+C); it now says why and exits 1
C206. Fixed `claude remote-control` ignoring a piped `y` that has no newline after it at the first-run question; it now counts as a yes
C207. Fixed `/rename` reporting plain success when the new name could not be saved to the session transcript; it now warns that the new name may not last
C208. Fixed `${CLAUDE_PLUGIN_ROOT}` not being substituted in a plugin-provided `subagentStatusLine` command, which can now reference the plugin's own scripts
C209. Fixed `claude plugin update` and `/plugin` "Update now" not installing dependencies added by the new plugin version
C210. Fixed subagents being told after compaction to expect a completion notice for background agents they neither started nor took over
C211. Fixed a case where a background agent's later report was lost silently: the notification now says it was refused and how to ask for it
C212. Improved config saves on Windows: Claude Code waits longer for a file another program has open, so a kill during a save is less likely to leave `~/.claude.json` empty
C213. Improved Claude in Chrome after a brief disconnect: it waits up to 6 seconds for the session's own browser to return before picking another
C214. Improved Claude in Chrome: `javascript_tool` results of up to 60,000 characters now stay in the conversation instead of being saved to a file
C215. Improved `claude purge` and the clean-up of old sessions to retry a folder that could not be fully deleted, and to report it as an error if it remains
C216. Improved the refusal for a path outside the working directories on macOS and Windows: when only its letter case differs from a path inside them, the message names that spelling
C217. Improved the contrast of faint gray secondary text, such as hints, details in `/stats`, `/model` and `/sandbox`, and rejected-action messages
C218. Improved the artifact database error when an update targets a document that does not exist, and when the service pauses repeated refused writes
C219. Improved the Claude apps gateway's warnings about a failed upstream call: each now names the upstream, not only its provider
C220. Improved the Claude apps gateway's spend limit error: it reads "spend limit reached · resets Dec 1", then `admin.blocked_message` if one is set
C221. Improved the `/model` picker: older models are now grouped under a "More models" row instead of being listed after the current ones
C222. Improved `/context` at the terminal so the table Claude reads stays short: each list keeps its 10 largest rows, and MCP tools that load on demand share one row per server until they're called
C223. Improved `/usage` in cloud sessions: it now links to Settings → Usage on claude.ai in a case where plan limits can't be shown
C224. [VSCode] Improved the confirmation for removing a plugin marketplace: it now checks which of its plugins are installed at that moment
C225. Changed MCP tasks to work in the terminal without feature-flag fetching (Bedrock, Vertex, Foundry, LLM gateways, `DISABLE_TELEMETRY`); set `CLAUDE_CODE_DISABLE_MCP_TASKS=1` to turn them off
C226. Changed auto mode so that a project's settings files or a plugin can no longer switch its server-side check back on once you have switched it off outside the project
C227. Changed Monitor's WebSocket watch to follow a rule on every Bash command: a deny refuses it, and under an ask rule an allow on Monitor, bypass mode or auto mode no longer skips the prompt
C228. Changed `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` so that settings files can no longer set it where the host manages the network; set it in the process environment
C229. Changed a session's exact Bash or PowerShell ask rule to be refused, not asked about, when a broader deny rule covers the command
C230. Changed the Bash tool to ask for permission before running `which` with flags outside a lookup/display set
C231. Changed `--add-dir` directories to register plugin marketplaces only once that directory's own trust dialog has been accepted
C232. Changed nested skill loading: with the Bash sandbox on, skills in `.claude/skills` folders below the starting folder load only if you start Claude Code there or `/cd` there
C233. Changed self-paced `/loop` to end when a turn finishes without rescheduling, instead of scheduling a fallback wakeup; set `CLAUDE_CODE_LOOP_KEEPALIVE=1` to keep the old behavior
C234. Changed PostToolUse hooks to run, with up to 10 seconds to finish, on tool calls that finish after a new message interrupts the turn
C235. Changed what Claude is told after safeguards stop a subagent: retry with a narrower prompt or tell you, instead of doing the work itself
C236. Changed cloud sessions to drop session-scoped allow rules at a move to a new worker when their deny and ask rules can't all be kept, so you may be asked again
C237. Changed the automatic certificate repair behind a TLS-inspecting proxy: it no longer runs when `ALL_PROXY` is the only proxy variable set. Set `HTTPS_PROXY` to the proxy's http:// URL instead
C238. Changed artifact database saves of rows others may have written: each file gets a hidden marker file, and existing files without one, earlier versions' exports among them, are left alone and reported
C239. Updated `/claude-api managed-agents-onboard` templates to match the Claude Console: removed Performance tuner, renamed two, and turned off web search and fetch in five whose prompts don't use them
C240. Removed `shortcuts_list` and `shortcuts_execute`, which listed and started shortcuts saved in the extension, from Claude Code's built-in Claude in Chrome tools
C241. Gateway: Added startup warnings for upstreams that mix AWS GovCloud with other upstreams, and for base URL variables in the gateway's environment
C242. Gateway: Added a start-up log warning when managed settings name an Amazon Bedrock guardrail in a header, which the gateway doesn't forward, and no `bedrock` upstream sets a `guardrail`
C243. Gateway: Fixed Claude Desktop offering a web search tool that always failed when every upstream is Amazon Bedrock
C244. Self-hosted runner: Fixed a runner started with `--use-anthropic-git-proxy` or `--configure-git` registering before a failed startup check made it exit; it now exits first
C245. Self-hosted runner: Changed `CLAUDE_RUNNER_CHECKOUT_PATH` so that each repository in a session gets its own folder: a folder name already taken in the session gets `-2`, `-3`, … at the end
C246. Self-hosted runner: Removed the end-of-session upload of a session's debug log; a failed session's log stays on the runner host unless `--remove-session-state` is set
C247. [VSCode] Fixed prompts over 50,000 characters being cut off silently: the prompt now stays in the chat box with a notice, and a paste over the limit is refused with a notice
C248. [VSCode] Fixed a click on the survey or "Report a problem" buttons sending the unfinished prompt
C249. [VSCode] Fixed cloud sessions opened from the extension's Web tab bringing back turns that `/clear`, or Retry or Edit of a typed prompt, had removed
C250. [VSCode] Fixed a deleted session's file coming back when that session was renamed in the extension
C251. [VSCode] Fixed Claude carrying out an unapproved plan after a window reload: a step interrupted in plan mode now stops with a notice when the session comes back in another permission mode
C252. [VSCode] Improved the "not signed in" message behind a Claude apps gateway: it now looks like an error and has a Sign in link
C253. [VSCode] Changed links in Claude's replies that point at Claude sign-in, connector or API addresses to show as text with the address, instead of opening in the browser
C254. [VSCode] Fixed a possible chat panel freeze when a dropped item's path contains a very long run of "/" characters
C255. [VSCode] Fixed the `claude-vscode.toggleDictation` command starting dictation in every open Claude view at once; it now acts only in the view you are using, and a second press stops it
C256. [VSCode] Fixed the chat panel slowing down while a reply with many unclosed `$$` math fences, each shorter than the last, streams in
C257. [VSCode] Improved the chat panel's diagnostics tool for large workspaces: it leaves out files with no problems, returns compact JSON, and accepts an optional minimum severity
C258. [Cloud sessions] Fixed scheduled tasks silently dropping a connector named memory: runs now keep it, mounted under that name plus a short suffix
C259. [Cloud sessions] Fixed Send now on a waiting message in cloud sessions ending running background agents; they now keep running
C260. [Cloud sessions] Improved the stalled-setup warning on self-hosted environments: its link now prefers your organization's default or an environment with a live runner, and names it
C261. [Code Review] Changed unlinking a GitHub organization to also turn off its All repositories setting in Code Review; it stays off after you relink until you turn it back on
C262. [Claude Tag] Fixed Claude Tag setup blocking launch when the channel list couldn't fully load; admins can now launch without picking a channel
C263. [Claude Tag] Added a Claude Tag row to the Models admin page for Enterprise orgs with Claude Tag connected, linking to where its model defaults are managed
C264. [Claude Tag] Fixed saving auto mode allow rules in Claude Tag admin settings overwriting another admin's changes; the save is now refused with a message

## 2.1.318

C265. Added a record of your answer when Claude Code asks to turn on the mods it writes in a session
C266. Added `assume_role` on `mantle` upstreams of the Claude apps gateway, for a role in another AWS account and for per-developer AWS cost attribution
C267. Added an `effort` option to a mod's `$.model.fork`, so a quick side job can run at `low` whatever effort the session uses; the result reports the effort sent
C268. Added the date a stored claude.ai sign-in ends to `claude auth status` (`loginExpiresAt`) and to `claude -p` JSON results (`credential_expires_at`)
C269. Added a one-line stderr warning to `claude -p` text output, starting 10 days before a stored claude.ai sign-in ends
C270. Fixed `--continue` sometimes losing the earlier conversation after a malformed tool call's retries ran out (regression in 2.1.314)
C271. Fixed macOS sessions with many running Bash commands stalling while memory grew
C272. Fixed permission prompts being answered by keys typed just after sending a message, or before a slow prompt appeared
C273. Fixed `/logout`, `claude auth logout` and `claude mcp remove` reporting success, and changes to trust, consent or MCP settings being dropped with no word, when the config file could not be updated on a shared network home directory
C274. Fixed jobs exiting with `Not logged in` when another terminal or host signs in again to the same account and organization on the same home
C275. Fixed `claude mcp add` and `remove` writing the config without its lock: they now wait for it or exit 1, though another job's save can still replace a saved server
C276. Fixed `claude plugin` commands exiting before a slow token refresh was saved, which could sign you out on the next run
C277. Fixed `claude plugin validate` passing a custom-named marketplace file that `claude plugin marketplace add` rejects
C278. Fixed stdio MCP servers that exit on the version probe being re-probed on every start; a server that dies in under 3s for its own reason is also pinned to the legacy handshake for 7 days
C279. Fixed sessions being refused at startup by an `allowedProviders` list that another login on the same machine had stored
C280. Fixed idle compaction replacing a conversation with a reply that was not a summary
C281. Fixed the "Now using usage credits" notice reappearing about every 30 seconds while a background subagent is running
C282. Fixed custom slash commands that fail, or that only Claude can invoke, printing nothing in `claude -p` and SDK sessions
C283. Fixed `claude -p` and Agent SDK sessions reporting success when an API error cut off a reply while a mod hooked `turn.step`
C284. Fixed a message sent right after a model change still running after Stop in headless sessions: Stop now cancels or stops it as it would a queued message
C285. Fixed a deleted session transcript being re-created with its last prompt when an idle non-interactive session exited
C286. Fixed `claude remote-control` hosts, the background daemon and self-hosted runners failing to start new sessions (`spawn ENOENT`) after an update or version cleanup removed the binary of a still-running process
C287. Fixed a running Claude Code process owned by another user (for example one left by `sudo claude`) being treated as dead by version cleanup, which could delete its binary
C288. Fixed `/remote-control` showing a session as available after a failed connection
C289. Fixed `/design revoke` reporting success when the request failed with a 404
C290. Fixed a shell command approved after a self-hosted runner or cloud session restart running in the session's start folder, not the folder it was asked in; if that folder can't be entered, it is not run
C291. Fixed Claude not being told when an approved connector tool was unavailable after a cloud session restart
C292. Fixed cloud sessions being stopped in the middle of a turn when the service refuses uploads for several minutes
C293. Fixed variables a `Setup` hook writes to `CLAUDE_ENV_FILE` not reaching the Bash tool in some cloud sessions
C294. Fixed the iPhone app showing a cloud session's turn as finished while it kept running, after a response was cut off at a tool call or a refused image or document was removed
C295. Fixed a restarted session re-sending a message that failed with an API error, ahead of the newer message waiting behind it
C296. Fixed a restarted session dropping its interrupted turn when the restart came right after Claude read a large image or retried a tool call
C297. Fixed every connection failing when the `NODE_EXTRA_CA_CERTS` file is empty, not PEM, or starts with a damaged certificate: readable certificates are now used, with a warning on stderr
C298. Fixed workflows re-running finished agents when resumed after a usage limit
C299. Fixed `/mcp` in cloud sessions counting tools the model can't use; a server's row now shows how many of its tools are available
C300. Fixed a duplicate notification when Claude left the status field out of a PushNotification call
C301. Fixed the error for a too-large image in a request with more than 20 images always saying the limit was 2000px; it now shows the API's limit
C302. Fixed the runtime in background shell details not updating while the dialog is open
C303. Fixed a mod's `turn.step` hook making a stopped reply finish as a success in headless runs
C304. Fixed retention cleanup leaving a home that only runs `claude -p` with no `~/.claude.json` backup: it now takes a fresh backup before deleting the last good one
C305. Fixed the stored login being replaced by an empty file when a network home directory has no room left for data but still takes new files
C306. Fixed tokens from `setup-token` being refused at start on machines with `forceLoginOrgUUID`, when the token belongs to a permitted organization
C307. Fixed non-interactive launches replacing a `~/.claude.json` that isn't valid JSON with defaults; the start now fails, says how to restore the file, and leaves it as is (anthropics/claude-code#87551)
C308. Fixed an empty `~/.claude.json` with no backup being reported as corrupted; Claude Code now starts as it does when the file is missing
C309. Fixed the restore command printed for a damaged or missing `~/.claude.json` naming an empty or cut-off backup, or failing on a read-only file
C310. Fixed the sign-in failure when a stored claude.ai login reaches its time limit: it now says so, and in `claude -p` names `claude auth login` and `claude setup-token`
C311. Improved how `~/.claude.json`, settings files and the stored login survive saves on shared network home directories: they are less often deleted, briefly emptied or replaced by a near-empty or older copy
C312. Improved sessions on network file systems to look again when the configuration file is wrongly reported as missing, so fewer start without your MCP servers and trusted folders
C313. Improved MCP tool errors: a call made before the tool is loaded now returns its input schema
C314. Improved the reliability of git commits and pull request creation when the Bash tool runs macOS's built-in `/bin/bash`
C315. Improved "Ask your admin for more usage" in the usage limit menu to send the request in one step
C316. Improved how fast remote sessions reconnect after a pause or sleep
C317. Improved You should know toasts to say "try again" instead of "press 2", which only works in the terminal
C318. Improved auto-update reliability: a brief network failure while verifying a release is now retried right away instead of waiting for the next check
C319. Improved unattended runs (`claude -p`, SDK apps) to stop rewriting `~/.claude.json` on every run when nothing in it changed
C320. Changed Claude Code to no longer install or update the IDE extension when started in an IDE terminal; use `/ide` from an outside terminal or your editor's extensions view
C321. Changed subagents to stop instead of switching models when "Switch models when a message is flagged" is set to "Ask each time"
C322. Changed background subagents to move a shell command to the background after 3 minutes on all providers, so the prompt cache doesn't expire while it runs
C323. Changed subagent progress summaries on Bedrock, Vertex, Foundry, or with telemetry off: on a cold prompt cache, one can now wait up to 5 minutes for the subagent's pending response
C324. Changed what a mod attaches at `prompt.submit` to stay in the user's turn rather than go out as a system message
C325. Changed `deniedMcpServers` URL entries to also block Anthropic-provided servers whose upstream URL matches, and connectors in cloud sessions and on self-hosted runners, where the session is given the connector's own URL; otherwise deny a connector by name
C326. Changed the `/permissions` rule details, built-in rules and delete confirmation views to use the standard dialog; pressing Ctrl+C twice there now goes back or cancels instead of quitting
C327. Changed `/claude-api managed-agents-onboard` to give a new agent's built-in tools, and a quickstart template's MCP tools, the `auto` permission policy ("Judge risky actions") by default, matching the Claude Console; say "run without asking" to opt out
C328. Removed the 2.1.288 fix that kept the model's earlier thinking when resuming a conversation started on 2.1.286 or earlier; that thinking can now be dropped
C329. Gateway: Added a log warning when the Google access token from a federation (`external_account`) credentials file is about to expire
C330. Gateway: Improved the log hints about `listen.trusted_proxies`: they now say to list only a proxy that adds the connecting address to `X-Forwarded-For` itself
C331. Gateway: Improved the warning when AWS CountTokens fails on Amazon Bedrock: it says Claude Code, not the gateway, counts after the 501, and points at IAM only when AWS denies access
C332. Self-hosted runner: Added `CLAUDE_RUNNER_SPAWN_REASON` to the orchestrator's spawn-runner hook environment: why Anthropic sent the request (e.g. `runner_lost`, `resumed`); unset when none was sent
C333. Self-hosted runner: Added a startup warning when `--release-idle-session-min` is the last argument with no value (still ignored) or has a value of only spaces (still read as `0`)
C334. Self-hosted runner: Changed the orchestrator's log lines: `ok session=…` now prints at every log level on stdout (was debug only, stderr) with `reason=…` after `jti=…`, and `nack session=…` ends its fields with `reason=…` after `retryable=…`; update scripts that match `retryable=true:` or `retryable=false:`
C335. Remote Control: Fixed a misleading "spawn error: ENOENT" when a session's working folder is missing; the error now names the folder
C336. Remote Control: Improved the title a fork of a terminal fork is created with when the app doesn't set one: "Name (fork 2)"
C337. [VSCode] Fixed a window whose sign-in the organization's settings refuse starting a new Claude Code process in the background every minute
C338. [VSCode] Fixed a long word in the chat panel's error banner pushing its close button out of view
C339. [VSCode] Improved the sign-in screen to show what Claude Code printed when its sign-in status check fails
C340. [Cloud sessions] Added a No repository option: a cloud session on an Anthropic-hosted environment can now start without picking a repository
C341. [Cloud sessions] Added the usual Chrome names to cloud sessions, so tools other than Playwright can find the built-in Chromium through google-chrome and CHROME_PATH
C342. [Cloud sessions] Added a New session button to the card shown when a cloud session's environment was deleted, where the message box is hidden
C343. [Cloud sessions] Fixed reading GitHub Actions logs in cloud sessions: `gh run view --log` and `gh api` log requests now get the log in most environments, not an unreachable redirect
C344. [Cloud sessions] Improved most Create PR failure messages in cloud and Remote Control sessions: they now give the reason or a link to GitHub instead of saying Try again
C345. [Cloud sessions] Changed connector search results to tell Claude that the search covers only part of the connector directory
C346. [Remote Control] Fixed side-by-side checkouts of one repository looking identical in the environment menu's Remote Control rows; each now shows its own folder name
C347. [Claude Tag] Fixed keyboard focus and screen reader announcements in Claude Tag admin setup; pressing Escape in the connect form no longer also closes the Add dialog
C348. [Code Review] Improved the Code Review analytics page to retry once after a server or network failure, then show a Try again banner instead of empty cards

## 2.1.317

C349. Added a warning to `/schedule` when a new cloud scheduled task gets connectors you did not ask for, with how to remove them
C350. Added a check that asks before a web or shell tool call sends your account email address to the network
C351. Added `onFailure: "block"` for Agent SDK hook callbacks, so a callback that fails blocks the action instead of letting it run
C352. Added a notice in Claude Desktop's Code tab when your organization's remote managed settings haven't loaded for the session, and another once they do
C353. Added a notice when auto mode's check has no answer for a subagent's tool call, which used to leave nothing in the main view
C354. Added `anthropic.plan`, `anthropic.seat_type`, `anthropic.provider` and `anthropic.custom_base_url` to OTel metrics, events and spans
C355. Added a cost report to the Claude apps gateway admin API, `GET /v1/organizations/analytics/cost`, for reading past spend over a date range in total, per developer, per day or per IdP group
C356. Added a daily record of each developer's IdP groups on Claude apps gateways with `admin:` set, kept for `admin.identity_retention_days`, which the cost report groups by
C357. Added `CLAUDE_CODE_DISABLE_NESTED_SESSION_ID`: set it to `1` on a self-hosted runner to have `claude -p` run inside a session use that session's ID and transcript, as in earlier versions
C358. Fixed project and local MCP servers disconnecting after the first turn in some Claude desktop sessions
C359. Fixed auto mode failing every turn when an LLM gateway set as the base URL answers 403 or 422 to its server-side safety check (a 403 with an apiKeyHelper is unchanged)
C360. Fixed `claude auth status` exiting before a slow token refresh was saved, which could sign you out on the next run
C361. Fixed a project's `effortLevel` setting being ignored by sessions that an app starts ahead of time and then opens in the project, such as new sessions in the desktop app's Code tab
C362. Fixed `claude --from-pr` reporting "No conversations found" in projects with many sessions when the linked session was older than the first page
C363. Fixed the second of two simultaneous permission prompts showing no file path or command on claude.ai and the mobile apps
C364. Fixed Remote Control and SDK hosts offering "don't ask again" on a mod's tool calls
C365. Fixed session titles being lost in cloud and SDK sessions when a new message or Stop arrived while the title was generating
C366. Fixed self-paced `/loop` wakeups sometimes not being scheduled when Claude left a field out of its request
C367. Fixed auto mode in cloud sessions stopping for approval when the Artifact tool uploaded, wrote to a database or saved a file through the outputs folder
C368. Fixed skills synced from claude.ai being lost or downloaded again every ten minutes when they can't be written to disk
C369. Fixed `/schedule` leaving a cloud scheduled task's next run time and link out of its results after creating or updating it
C370. Fixed screen readers speaking a running subagent's elapsed time and token count on every change in screen reader mode
C371. Fixed a region or network block (HTTP 403) being shown as a sign-in failure; the error now explains the block
C372. Fixed Claude saying a working claude.ai connector needed authorization or had failed in cloud sessions when a synced plugin included the same server
C373. Fixed `claude -p` exiting 0 when a full disk or quota lost its transcript or ~/.claude.json writes; it now prints an error and, in text and json output, exits 1. Full NFS exports may be missed
C374. Fixed edits to settings files made in the first second or so after launch not taking effect until a settings file changed again
C375. Fixed old transcripts not being cleaned up on machines where some runs skip cleanup, such as runs using `--setting-sources`
C376. Fixed deleted agent team inboxes being re-created by a teammate's late message
C377. Fixed a re-created agent teammate being removed from its team by an earlier shutdown approval
C378. Fixed stored scheduled tasks being impossible to list or delete after scheduled tasks were turned off
C379. Fixed Claude deleting your most recently updated `/team-onboarding` guide when asked to delete one without naming which
C380. Fixed Claude saying a `/team-onboarding` guide was deleted when the server refused the delete
C381. Fixed the Claude apps gateway hiding Amazon Bedrock's "Input is too long." error, which left sessions failing every turn with "upstream rejected the request" instead of compacting
C382. Fixed self-hosted runner sessions losing recent turns or the whole conversation when restarted while a plan waited for approval
C383. Fixed "Prompt is too long" after automatic compaction in sessions whose very large CLAUDE.md changed since it was last sent
C384. Fixed high memory use and slow startup in headless sessions with many plugins that register commands
C385. Fixed stdio MCP servers receiving an empty `AWS_BEARER_TOKEN_BEDROCK` when their env config sets it to empty; the variable is now unset, so the server can use the machine's own AWS credentials
C386. Fixed API requests failing with "unable to get local issuer certificate" behind some TLS-inspecting proxies after a root certificate renewal
C387. Fixed very long conversations losing their earlier summary when compaction had to shorten its own request
C388. Fixed a PDF's own metadata being able to make Read and @-mentions under-count its pages
C389. Fixed `DISABLE_PROMPT_CACHING_OPUS` and `DISABLE_PROMPT_CACHING_SONNET` having no effect on `[1m]`, other-region and undated spellings of the default model
C390. Fixed `/artifacts` and the Artifact tool's shared list showing no shared artifacts when you have 200 or more of your own
C391. Fixed Claude treating partial Grep and Glob results as complete when a search hit its time limit
C392. Fixed OpenTelemetry exports to an `https://` endpoint through a proxy never being sent when they started while another export was still in progress
C393. Fixed a flood of connection attempts to a proxy that blocks (HTTP 403) OpenTelemetry exports to an `http://` endpoint
C394. Fixed OpenTelemetry exports hanging indefinitely behind a proxy that never answers; they now time out after 10 seconds, or `OTEL_EXPORTER_OTLP_TIMEOUT` up to 30 seconds
C395. Fixed resumed sessions telling Claude again about a file change it already knew about
C396. Fixed Claude sometimes not using a built-in tool in a resumed session after an earlier call failed because the tool was switched off
C397. Fixed `/remote-control` answering "Unknown command" instead of saying that Remote Control is turned off by the `disableRemoteControl` setting
C398. Fixed agent team teammates in tmux or iTerm2 panes starting in auto mode when the lead session was in manual mode
C399. Fixed a background session sometimes losing a just-made change of permission mode when it was upgraded or retired
C400. Fixed Ctrl+C stopping all running background agents when pressed to clear typed text at the prompt
C401. Fixed /feedback showing "Enter to confirm" while a report is being sent
C402. Fixed child processes of a stopped shell command sometimes being sent SIGTERM twice, which could make some programs skip their cleanup
C403. Fixed `claude -p` run inside a cloud or self-hosted runner session sharing that session's ID: it wrote into the session's transcript, and a restart could resume the wrong conversation
C404. Fixed `claude -p` run inside a cloud or self-hosted runner session generating a title of its own and sending it to that session
C405. Improved the error shown on Microsoft Foundry when Azure credentials can't be loaded: it now says to check or refresh them, and reports as `cloud_credential_error`
C406. Improved `/design-sync` to say up front when your design system has moved to Claude, and stop before building instead of failing at upload
C407. Improved the startup error when a required Claude apps gateway can't be reached: it points to the network instead of a sign-in, and says when the gateway's TLS certificate can't be verified
C408. Improved the "Resume this session with" hint shown at exit to repeat the flags you launched with (for example `--chrome --debug`) ahead of `--resume`
C409. Improved how self-hosted runners recover from server errors: after a 5xx other than 501 or 529, a runner's next poll now opens a new connection instead of reusing the one that failed
C410. Improved how self-hosted runner sessions recover from server errors: after a 5xx other than 501 or 529, a session now opens new connections instead of reusing the one that failed
C411. Improved how self-hosted runner sessions recover when connections stop answering: after a heartbeat gets no answer, a session now opens new connections instead of trying each idle one in turn
C412. Changed SendMessage so a message to a running background agent arrives earlier: its running command moves to the background, without being stopped
C413. Changed subagents and teammates on a different model from the main conversation to use that model's saved effort level or its default, instead of the session's effort level
C414. Changed exit to skip the "Background work is running" prompt for plugin monitors
C415. Changed the built-in `plugin-authoring` skill to offer once, after a mod you built works, to help share the mod
C416. Removed the Read tool's "file unchanged since your last Read" stub: reading an unchanged file again returns its content
C417. Windows: Fixed every tool call being refused on some volumes where the native path lookup fails; the working-directory check now compares the folder's identity instead
C418. Windows: Fixed the session scratchpad and other temporary paths growing with your project's path length in sessions not started by Claude Desktop, which made repositories cloned into them hit the 260-character path limit
C419. Gateway: Fixed the status line and `/usage` showing a developer's own spend limit as 100% used after their group's pooled budget ran out
C420. Self-hosted runner: Fixed Claude not seeing the interrupted tool call when a session moves to a new runner and the turn is older than `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`
C421. Self-hosted runner: Fixed an MCP server that was switched off coming back on after the session moved to a new machine, when the session service had refused to save the switch
C422. Remote Control: Improved fork names when the app doesn't set one: a long name keeps its "(fork)" ending, and in sessions started with `claude remote-control` a fork of "Name (fork)" is "Name (fork 2)"
C423. [VSCode] Fixed forked conversations dropping messages: only one of the tool calls Claude ran in parallel was kept, and the last messages a compaction kept were lost, which could leave Claude's answer without the question it answered
C424. [VSCode] Fixed a message being lost when Claude did not finish starting in time: the extension now starts Claude once more before showing the error
C425. [VSCode] Fixed the sign-in screen opening when a request is blocked for its region or network
C426. [VSCode] Fixed the Account panel showing the plan name with a lower-cased second word
C427. [VSCode] Fixed file links in a Claude tab opening on top of the chat instead of in another editor group
C428. [VSCode] Fixed attachment chips, menus, banners and dialogs in the Claude panel staying small when `chat.fontSize` is raised
C429. [VSCode] Fixed `ultrathink` not raising effort for its turn or showing its rainbow when telemetry is off
C430. [Cloud sessions] Added a link card to cloud sessions, so you can open or decline a link an MCP server asks you to visit instead of the request going unseen
C431. [Cloud sessions] Changed the organization environment dialog in admin settings to the personal dialogs' short layout: each section opens from a row, and unsaved input asks before closing
C432. [Cloud sessions] Fixed adding a network secret for a host that already has one silently replacing it; the Add secret form now refuses and points you to the existing secret
C433. [Cloud sessions] Fixed new scheduled tasks ignoring your organization's default environment: the form now starts on the one an admin chose instead of the Anthropic-hosted default
C434. [Remote Control] Fixed the next message to an idle session going unanswered after you restart `claude remote-control`, when you sent it within a minute of your previous message
C435. [Claude Tag] Changed newly pasted artifact links in Slack to show a simpler card with an Open button that opens the artifact in Claude, instead of Slack's side panel
