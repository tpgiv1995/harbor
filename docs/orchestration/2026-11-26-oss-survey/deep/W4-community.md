# W4: What users of tools like Harbor ask for and complain about (2026-11-26)

Sources read on 2026-11-26: Hacker News (Algolia API, 38 threads saved), Reddit (34 threads through god Chrome, read-only),
the Cursor forum (12 topics through its public Discourse API), and GitHub issue search results (titles and reaction counts only).
Links without a note were opened. "(listing only)" means I saw the title and counts but did not open the page.

## How to read the counts

- "Threads" means separate threads where I read a person asking for the thing, praising it, or complaining about its absence. I counted
  them by hand from the threads listed in the Appendix, not from keyword counts.
- Each HN thread was read to its top 30 comments and two reply levels. Reddit threads were read to 10 to 30 top comments (sorted by top).
  A want that appears in only the unread part of a thread is not counted.
- Reddit search returned loose matches (a "Claude Code Cheatsheet" post came back for most queries), so I chose threads by title and
  comment count from about 1,170 search rows, then read them. Search used `sort=top` for all eight subreddits and `sort=new` for
  r/ClaudeAI, r/codex, r/cursor and r/ChatGPTCoding. `sort=new` for r/ClaudeCode was not run.
- Reddit scores in 2026 are large (a status-light post has 3,700 points), so a score says little about demand for a feature.
  Replies that repeat the same ask are the better signal.

## Corrections to REPORT.md found while reading

- **Conductor's fate is dated and worse than "closed source".** The announcement thread says new sign-ups stopped 2026-11-04, Conductor
  Cloud goes read-only 2026-11-13, and the local app "will start winding down in early 2027"
  ([HN 50369503](https://news.ycombinator.com/item?id=50369503), comment by markerz quoting the announcement). REPORT.md section 14 lists
  Conductor only as "closed source".
- **Vibe Kanban's last version has no Kanban board.** A user in r/ClaudeCode says "they are sunsetting and the last version doesn't even
  have the Kanban board" ([thread](https://www.reddit.com/r/ClaudeCode/comments/1t1q54w/what_agent_orchestrator_are_you_using/),
  2026-05-02). REPORT.md says its code "continues as community open source". I did not check the repo, so both may be true.
- **Superset was renamed Paradev.** A Paradev founder replies in the Conductor thread "We have cloud now! also renamed to Paradev"
  (HN 50369503, hoakiet98). The Superset launch thread is still at [HN 48236770](https://news.ycombinator.com/item?id=48236770).
- **Two other tools people name more than most of REPORT.md's list:** Herdr (herdr.dev) and cmux. Neither is in REPORT.md. Users in
  [r/ClaudeCode 1viwdnh](https://www.reddit.com/r/ClaudeCode/comments/1viwdnh/what_orchestrator_are_you_using/) and
  [r/ClaudeAI 1xvyxav](https://www.reddit.com/r/ClaudeAI/comments/1xvyxav/how_do_you_manage_dozens_of_claude_code_sessions/)
  answer "herdr" or "cmux" first. Harbor once had a Herdr backend (retired 2026-08-14, per CLAUDE.md); I did not check that the retired
  backend and herdr.dev are the same product.

## 1. What people want, ranked

Rank is by number of separate threads, then by how specific the ask is. Harbor status is in section 4.

### W1. One place that shows which agent is working, blocked or done, with a jump to the one that needs me (10 threads)

- [HN 44594584](https://news.ycombinator.com/item?id=44594584) (Conductor Show HN, 2025-07-17), freedomben: "once I have about 3 or more
  running at a time it's very easy to forget about one and have it paused waiting for confirmation. A tool like this to add a dashboard of
  sorts would be nice."
- [r/ClaudeCode 1x1z70y](https://www.reddit.com/r/ClaudeCode/comments/1x1z70y/a_claude_code_session_asked_for_bash_permission/)
  (2026-10-09), OP: a session "asked 'can I run this Bash command?' three minutes in, and I found it forty minutes later by paging through
  terminals. Nothing had broken. It was waiting."
- [r/ChatGPTCoding 1y3axj0](https://www.reddit.com/r/ChatGPTCoding/comments/1y3axj0/once_you_run_45_agents_at_once_the_bottleneck_is/)
  (2026-11-23), about T3 Code: "no colored status dots, just 'Done' / 'Input', and the sidebar only shows threads that need you." A reply
  from a Herdr user: "Prefix + B jumps straight to the blocked agent ... So I don't cycle through tabs anymore, I just wait for the ping."
- [r/ClaudeCode 1ue5inx](https://www.reddit.com/r/ClaudeCode/comments/1ue5inx/i_built_a_status_light_for_claude_code_do_you/)
  (2026-06-24, 3,700 points): a DIY red, yellow, green light driven by hooks. The top question (363 points) is "How does it work with
  multiple sessions in multiple worktrees?" A Stream Deck user builds one button per session that turns red when it needs attention and
  jumps to the session when pressed.
- Also: [r/ClaudeCode 1rg4wdy](https://www.reddit.com/r/ClaudeCode/comments/1rg4wdy/i_got_tired_of_tabswitching_between_10_claude/)
  (a "Needs You" kanban column), [r/ClaudeCode 1xwk66v](https://www.reddit.com/r/ClaudeCode/comments/1xwk66v/i_stopped_babysitting_claude_code_a_lamp_does_it/)
  (room lights as status), [r/ClaudeAI 1xvyxav](https://www.reddit.com/r/ClaudeAI/comments/1xvyxav/how_do_you_manage_dozens_of_claude_code_sessions/)
  (hle17: "Make waiting loud"), HN 48236770 (Superset: "we surface agent states automatically so you can see what's running or needs
  attention"), Cursor forum [170506](https://forum.cursor.com/t/170506) ("Completion chimes do not clearly identify which task completed or
  whether it succeeded, failed, or needs input").
- The counter-view: "the notification itself is easy to hack together, the killer is actually context recovery penalty" (Avinash2k5 in
  1y3axj0), and "a sidebar of threads that need you is still you being the scheduler" (Right-Performance-93, same thread). People want the
  question and a default answer inside the alert, not only a dot.

### W2. Every task in its own worktree, made automatically, with the untracked files, dependencies and ports it needs (10 threads)

- [HN 44594584](https://news.ycombinator.com/item?id=44594584), pjm331: worktrees "don't include things that are not tracked by git - e.g.
  .env.development.local So starting a new worktree requires additional setup." _1tem wanted "simple git worktree management for an
  already-checked-out repo ... no Github permissions or dependency re-installation."
- [HN 48236770](https://news.ycombinator.com/item?id=48236770) (Superset launch, 2026-05-22), toddmorey: "the hard part being managing state,
  especially environments and ports. I've never used lsof so much in my life."
- [r/ClaudeCode 1sciznh](https://www.reddit.com/r/ClaudeCode/comments/1sciznh/senior_engineer_best_practice_for_scaling/)
  (2026-04-04): "the thing that hit us running 4-6 claude code sessions in parallel was port conflicts - every dev server, every debugger
  fighting over the same ports."
- [r/ChatGPTCoding 1vx0hb6](https://www.reddit.com/r/ChatGPTCoding/comments/1vx0hb6/if_you_run_multiple_ai_agents_on_the_same_repo/)
  (2026-08-24): "git worktrees do the job of separating the code. The problem comes when I try to test ... They can't all use the same db and
  running instance." Replies give per-worktree compose project names, port offsets and a cloned database.
- [r/cursor 1s0k46x](https://www.reddit.com/r/cursor/comments/1s0k46x/cursor_is_fighting_the_wrong_war_we_need_local/)
  (2026-03-22): "Worktrees solve the git layer but shared dirs (~/.config, /tmp, process namespaces) still collide."
- GitHub demand (listing only): openai/codex
  [#12862](https://github.com/openai/codex/issues/12862) "add --worktree and --tmux flags" (129 reactions),
  [#10599](https://github.com/openai/codex/issues/10599) configurable worktree location (78), and anthropics/claude-code
  [#23622](https://github.com/anthropics/claude-code/issues/23622) choose the base branch (89 reactions). The opposite ask also has votes:
  [#21236](https://github.com/anthropics/claude-code/issues/21236) "Option to disable automatic git worktree creation" (110).
- Also: [r/ClaudeCode 1r9wcxc](https://www.reddit.com/r/ClaudeCode/comments/1r9wcxc/is_there_an_app_like_codex_for_claude_code/)
  ("Is there an app like Codex for Claude Code?", asked for exactly this), Cursor forum
  [175910](https://forum.cursor.com/t/175910) and [170130](https://forum.cursor.com/t/170130) (30+ worktrees).
- Doubt exists: oc1 in HN 44594584 says worktrees overcomplicate most workflows because "the bottleneck was ... the human factor -
  needing to carefully review what ai produced". mrgalacticpresident in 1s0k46x: "Isolation IS NOT the solution. It just pushes conflict
  resolution into merge phase."

### W3. Drive the same sessions from the phone, with a push when one needs me and approve or deny from the alert (9 threads)

- [r/ClaudeCode 1rdr7ga](https://www.reddit.com/r/ClaudeCode/comments/1rdr7ga/claude_code_just_got_remote_control/) (2026-02-24):
  "the 5 dozen 'I made a remote control for Claude' projects must be losing it right now" (288 points). Others already used
  "Termius / tmux / Tailscale."
- [r/OpenAI 1rdxlo2](https://www.reddit.com/r/OpenAI/comments/1rdxlo2/if_someone_at_openai_is_reading_this_we_need/),
  title: "we need mobile remote control for Codex ASAP. S tier feature." [r/cursor 1rrrwba](https://www.reddit.com/r/cursor/comments/1rrrwba/can_we_please_add_remote_control/):
  "adding remote control functionality so I can prompt from my phone to my LOCAL machine would make my life 100x easier."
- [r/codex 1tdvm9a](https://www.reddit.com/r/codex/comments/1tdvm9a/the_remote_codex_feature_is_unreal/) (2026-05-15): a
  user ships a TestFlight build from a parked car.
- [HN 44878650](https://news.ycombinator.com/item?id=44878650) and [46991591](https://news.ycombinator.com/item?id=46991591) (Omnara, 310
  and 147 points): smithclay "using Claude Code from your phone is kind of great."
- [r/ClaudeCode 1xhvnjw](https://www.reddit.com/r/ClaudeCode/comments/1xhvnjw/my_claude_code_now_calls_my_phone_when_it_needs/):
  an MCP server that rings the phone. Pushback: "I would never imagine an instance where I'd want claude code to call me versus having access
  to RC in the app where I can actually see and confirm what it's talking about. Development is too visual" (HeyItsYourDad_AMA).
- GitHub (listing only): anthropics/claude-code [#29438](https://github.com/anthropics/claude-code/issues/29438) "Remote Control: Push
  notifications on iOS when permission approval is needed" (69 reactions); openai/codex
  [#32908](https://github.com/openai/codex/issues/32908) push not delivered on iOS (25).
- Skeptics: keyle in [HN 48377250](https://news.ycombinator.com/item?id=48377250) (Paseo): "Shipping code from your phone, whhhyy."

### W4. See what each session costs, see every plan's room, and carry on after a limit resets (10 threads)

- [r/ClaudeCode 1xcnrxk](https://www.reddit.com/r/ClaudeCode/comments/1xcnrxk/we_should_be_furious_about_this_lets_see_if_we/)
  (2026-10-22, 2,854 points): "The problem is not the 20x plan, it's that we don't know what we get on any plan" (norwegian, 656 points).
- [r/ClaudeAI 1vahwvi](https://www.reddit.com/r/ClaudeAI/comments/1vahwvi/i_built_operator_because_existing_claude_code/)
  (2026-07-30), jjjfffrrr123456: "Having something that tells me how much tokens my tasks are burning, adjusting priorities on the fly
  and restarting long assignments would be an absolute godsend."
- [r/ClaudeCode 1viwdnh](https://www.reddit.com/r/ClaudeCode/comments/1viwdnh/what_orchestrator_are_you_using/) (2026-08-08),
  enkideridu on the tool tbd: it "shows your remaining 5h and weekly and fable usage for all your accounts on hover when creating worktrees
  ... and also easily fork a session into a different account (e.g. if your main account hit usage limits)". This is close to what Harbor
  does with its plan picker.
- [r/ClaudeCode 1x4aqyi](https://www.reddit.com/r/ClaudeCode/comments/1x4aqyi/i_made_my_claude_code_logs_print_a_store_receipt/):
  "$8.3k of tokens at API prices on a $200/mo plan". HN
  [44610925](https://news.ycombinator.com/item?id=44610925) (ccusage) and [47759035](https://news.ycombinator.com/item?id=47759035)
  (CodeBurn: "~$1400/week on Claude Code with almost no visibility into what was actually consuming tokens").
- GitHub (listing only): openai/codex [#21073](https://github.com/openai/codex/issues/21073) "Auto-resume CLI session when usage limit
  resets" (94 reactions, open); anthropics/claude-code [#79127](https://github.com/anthropics/claude-code/issues/79127) "Suspend and
  auto-resume at usage-limit reset" (2); [#46829](https://github.com/anthropics/claude-code/issues/46829) cache TTL regression "causing
  quota and cost inflation" (341).
- Also: a r/ChatGPTCoding post (2026-11-24, title only, listing) titled "I made a tool to run Claude Code from Telegram, approve its commands from my phone, and resume tasks after usage limits".

### W5. Real CLIs, any provider, on the person's own subscription (8 threads)

- [HN 48236770](https://news.ycombinator.com/item?id=48236770): motoboi "superset is terminal-centric while conductor is chat-centric.
  GUIs slow you down, in my opinion. But having the nice visual diff is something we can't really do well in TUIs." cpan22: "to use the
  native Codex/Claude Code TUIs without any of the bloat".
- [HN 44594584](https://news.ycombinator.com/item?id=44594584): aantix "There's a 'feel' to the way Claude Code outputs the text ... Sadly,
  this is lost with conductor. ... I just want a better way to manage the sessions." nsonha: "they're all Claude-centric."
- [r/ClaudeCode 1viwdnh](https://www.reddit.com/r/ClaudeCode/comments/1viwdnh/what_orchestrator_are_you_using/): after Anthropic's
  2026-06-15 change to how programmatic use is metered, users ask whether a manager runs "claude -p" (metered separately) or the normal CLI.
  Superset's founder: "it runs Claude Code unmodified in a real terminal, so usage comes out of your normal sub."
  enkideridu: "runs raw Claude sessions (not claude -p)". I did not open Anthropic's policy; collin128 cites
  [HN 48126438](https://news.ycombinator.com/item?id=48126438) for it in HN 48236770.
- [HN 50369503](https://news.ycombinator.com/item?id=50369503): 2001zhaozhao on T3 Code "it is by far the best one I have tried that
  isn't glued to a specific model provider."
- [r/ClaudeCode 1vj5ktu](https://www.reddit.com/r/ClaudeCode/comments/1vj5ktu/i_coded_terminal_manager_for_adhd_brains_100/):
  David01354 (26 points) "maybe its time to consider if that terminal really is the best interface after all?" The two camps stay split.

### W6. Sessions that survive closing or updating the app (6 threads)

- HN 48236770, avipeltz: "if you kill the app or update your sessions stay alive and running"; SeRGiNaToR: "you can 'soft' close superset or
  update it while having several agents running at the same time."
- [r/ClaudeCode 1vj5ktu](https://www.reddit.com/r/ClaudeCode/comments/1vj5ktu/i_coded_terminal_manager_for_adhd_brains_100/):
  "You can close the app, lose your connection, reconnect over SSH, and continue with the exact same layout and sessions."
- [r/ClaudeAI 1xvyxav](https://www.reddit.com/r/ClaudeAI/comments/1xvyxav/how_do_you_manage_dozens_of_claude_code_sessions/):
  "I wrote my own Claude session management tool. Can even restore it to the same exact tab ... I had to do this because I got tired of
  loading up sessions following reboot."
- [HN 47599771](https://news.ycombinator.com/item?id=47599771) (Baton), throwaw12: "How do you restore the state from the old workspaces?"
- Also HN 44878650 (franze runs Claude Code on a server and loops "continue"), r/ClaudeCode 1x1esxn (overnight run; "your PC reboots and
  launches claude and claude resumes by itself. Yeah. Totally.").

### W7. Find an old session and what it produced (5 threads)

- [r/ClaudeAI 1xvyxav](https://www.reddit.com/r/ClaudeAI/comments/1xvyxav/how_do_you_manage_dozens_of_claude_code_sessions/)
  (2026-11-14): OP has "almost 200 sessions" and "Sometimes I open a new session just to ask Claude where an old one is." Answers: one
  session per branch, five-line handoff notes, "a searchable index by client or project".
- [r/OpenAI 1xw6xzn](https://www.reddit.com/r/OpenAI/comments/1xw6xzn/how_do_you_keep_track_of_multiple_codex_sessions/):
  "The titles are often just sameeee ... I have to open soooo many sessions to find the one I am looking for."
- Also r/ClaudeCode 1viwdnh, Cursor forum [170506](https://forum.cursor.com/t/170506) (long worktree names truncated), .

### W8. Review inside the tool: diffs, annotate the page, merge, stacked PRs (6 threads)

- [r/ClaudeAI 1vahwvi](https://www.reddit.com/r/ClaudeAI/comments/1vahwvi/i_built_operator_because_existing_claude_code/):
  the wish list includes "Diff review and merge without hunting through terminals".
- [r/codex 1svaj3v](https://www.reddit.com/r/codex/comments/1svaj3v/most_slept_on_feature_in_the_codex_app/) (407 points):
  the in-app browser with screenshot and annotations that attach a comment to the chat is "the best new Codex GUI feature so far".
- [HN 44533004](https://news.ycombinator.com/item?id=44533004) (Vibe Kanban), lharries: "I could open lots of PRs at once but they often
  need to be dependent on each other". [r/ClaudeCode 1sciznh](https://www.reddit.com/r/ClaudeCode/comments/1sciznh/senior_engineer_best_practice_for_scaling/):
  "when you have multiple Claude Code sessions in parallel you as a reviewer become the funnel."
- HN 48236770 (motoboi, quoted above). HN 44594584 (dgritsko wants "Open in..." tools to view pending changes).

### W9. A task board where each task is an agent (6 threads, mixed)

- [r/ClaudeCode 1t1q54w](https://www.reddit.com/r/ClaudeCode/comments/1t1q54w/what_agent_orchestrator_are_you_using/):
  "a kanban-style board where I can create tasks and AI agents move them through plan, wip, review, with me in the loop".
- Operator (r/ClaudeAI 1vahwvi, 248 points): "every task is its own agent ... One git worktree and branch per task". r/ClaudeCode
  [1q9dmxd](https://www.reddit.com/r/ClaudeCode/comments/1q9dmxd/multiagent_orchestration_for_parallel_work_tools/) lists five
  kanban and orchestrator tools. HN 44533004 launched Vibe Kanban to 195 points.
- Against: jjangkke in HN 44533004: "I'm not sure if Kanban is the right UI". r/codex
  [1y3652l](https://www.reddit.com/r/codex/comments/1y3652l/anyone_actually_have_a_reliable_multiagent_coding/): "Paperclip's management
  overhead has pushed some users back to simpler tools" (summary comment), and "I was spending more time on that, than my work."

### W10. Windows that works (9 threads)

- Mac-only is a common complaint: HN 44594584 (WalterSear: "silicon only"; countfeng: "I don't deserve to own my Windows system"), HN
  [46368739](https://news.ycombinator.com/item?id=46368739) (Superset: "why a Windows build isn't available yet?"), HN 48236770 (dested:
  "Windddddddoooowwwwwssssss"; the team: "nobody on the team daily drives windows"), HN 44878650 (Omnara: termios is not Windows
  compatible), HN 46859054 (Codex app: "both only for macOS"; an OpenAI engineer says Windows sandboxing is the slow part).
- Reddit 1viwdnh: inrego "Does it support Windows yet?"
- The CLIs' own Windows trouble (listing only): anthropics/claude-code
  [#14828](https://github.com/anthropics/claude-code/issues/14828) "Console window flashing when executing tools" (38 reactions, 67
  comments, open since 2025-12-20); openai/codex [#48074](https://github.com/openai/codex/issues/48074) "terminal windows repeatedly flash
  during requests after installing the Codex daemon" (165 reactions); Cursor forum
  [177677](https://forum.cursor.com/t/177677) (each hook costs about 7 s on Windows) and [177889](https://forum.cursor.com/t/177889)
  ("Git for Windows is required" although it is installed).

### W11. More than one machine, or a cloud box (6 threads)

- [HN 50369503](https://news.ycombinator.com/item?id=50369503): phildenhoff left Conductor for Orca "when I needed better multi-machine
  control, and remote control". iamunr had just bought Conductor Cloud and moved the org to T3 Code.
- [r/ClaudeCode 1vwjgyv](https://www.reddit.com/r/ClaudeCode/comments/1vwjgyv/orca_ade_is_incredible/): "I make full use of two Max 20 plans, and
  I've been alternating between two computers. But with Orca remote, all sessions from both machines are in one place." Against: cran, "It's
  slow and laggy doing remote work. I much prefer herdr."
- HN 48236770 (Superset remote workspaces; dbbk: typing "quite laggy"), HN [48399358](https://news.ycombinator.com/item?id=48399358) (Boxes.dev;
  indigodaddy wants "any old cloud or VPS"), r/ClaudeCode 1viwdnh (indutrajeev's tmux server on a Mac mini exposed over the tailnet).

### W12. Agents that hand work to each other, or a coordinator that runs the rest (6 threads)

- Cursor forum [175983](https://forum.cursor.com/t/175983) (2026-10-24): "let two local agents in different workspaces message each other and wake
  the other chat". A Cursor staff reply: "Today two local chats can't message each other directly."
- r/ClaudeAI 1xvyxav (wea8675309: one Sonnet "coordinator" session per task with Opus advisors and Haiku workers), r/ChatGPTCoding 1y3axj0
  (dvduval: "I just keep one coordinator and it scales the number of agents for me"), r/ClaudeCode 1viwdnh (a "foreman" skill over herdr),
  1q9dmxd (Gas Town), r/codex 1y3652l.

### Lower-count wants

- **Free and local.** Three threads reject small paid utilities: the lamp at about 3 pounds a month ("anyone else can build this with Claude
  & Home Assistant" 367 points, 1xwk66v), SessionDeck ("Wait, you want me to pay for software?", 1x1z70y), Superset's Linear integration
  ("$20/m is a bit steep", HN 48236770).
- **Open source with no account.** HN 48236770 (drcongo asks what the sign-in is for), 44533004 (GitHub OAuth), 44594584 (same).
- **Voice.** r/ClaudeCode [1xfra3e](https://www.reddit.com/r/ClaudeCode/comments/1xfra3e/) "Engineers are coding by voice with Claude
  Code" (listing only, 943 points).

## 2. Complaints and failure stories, ranked

### C1. Limits and cost are opaque, and parallel work spends them fast (10 threads)

- r/ClaudeCode [1xcnrxk](https://www.reddit.com/r/ClaudeCode/comments/1xcnrxk/we_should_be_furious_about_this_lets_see_if_we/)
  (above). r/ClaudeAI [1s4idaq](https://www.reddit.com/r/ClaudeAI/comments/1s4idaq/update_on_session_limits/) (2026-03-26, 923 comments): after
  the peak-hours change, "Wait, on MAX I will get to my limit faster? What the fuck?"
- HN 44594584, lvl155 (2025-07-21): "So this is why Claude Code is so slow now" (blaming parallel-run tools). HN 48236770, Tooster: "You can
  basically burn through 100% usage through a single day."
- r/ClaudeAI 1vahwvi, Operator's author: "parallel orchestration does make it much easier to burn through the subscription ... it is very easy to
  launch 20 tasks that are not equally important and burn through a five hour limit in minutes."
- r/ClaudeCode [1x1esxn](https://www.reddit.com/r/ClaudeCode/comments/1x1esxn/attention_heavy_ai_users/) (2026-10-09, 1,592 points): "opus
  5.5 ran dozens of agents IN PARALLEL ... and opened 13,000+ MICROSOFT EDGE WINDOWS, Crashing my pc ... slightly more then half my weekly
  usage in 24 hours".
- GitHub (listing only): anthropics/claude-code [#16157](https://github.com/anthropics/claude-code/issues/16157) "Instantly hitting usage
  limits with Max subscription" (728 reactions, 1,501 comments) and [#38335](https://github.com/anthropics/claude-code/issues/38335) (545);
  openai/codex [#28879](https://github.com/openai/codex/issues/28879) (557) and [#34035](https://github.com/openai/codex/issues/34035) (285).
  agy has the same: google-antigravity/antigravity-cli [#56](https://github.com/google-antigravity/antigravity-cli/issues/56) "Pro Plan hits
  daily request limit after only 2 prompts".

### C2. The person is the bottleneck: lost context, review load, burn-out (8 threads)

- r/ClaudeAI 1xvyxav, manut3ro: "I thought I was being super clever doing a lot of stuff In parallel and by the end of the week I wasn't
  delivering quality? and I was getting close the burn out." watchmanstower caps it at 3 or 4: "My own head and how much stress I felt."
- r/ClaudeAI [1xzipn8](https://www.reddit.com/r/ClaudeAI/comments/1xzipn8/i_built_my_custom_agent_manager_7_months_and_8000/) (919
  points): "I also started to feel mentally exhausted when I was running more than 5-6 conversations in parallel. I felt this was due to agent manager
  UI making it hard to track the state of each conversation."
- r/ChatGPTCoding 1y3axj0 ("once you run 4-5 agents at once, the bottleneck is you"), r/ClaudeCode 1sciznh (cglezar, above), r/ClaudeCode
  1vj5ktu ("it will exhaust me with constant context switching"), HN 44594584 (petesergeant: "can just about manage to stay focused enough to
  properly review the output of a single Claude agent"), HN 44533004 (deepdarkforest: "i lose mental context of what's going on").
- HN [50645541](https://news.ycombinator.com/item?id=50645541) (2026-11-25): ttthkim "code generation speed is rarely the real bottleneck -
  keeping file ownership isolated and having deterministic tests to verify outputs is much harder."

### C3. Agents collide on files, ports, databases and shared folders (8 threads)

- HN 44533004, deepdarkforest: "whenever i try to parallelize, they clash while editing files simultaneously ... they rewrite tests". helsinki
  (spent "tens of thousands on Opus tokens and worktrees"): "you're still sitting around waiting for Claude to merge conflicts."
- r/cursor 1s0k46x, Deep_Ad1959: "when two agents edit the same file at the same time, one just silently overwrites". r/ChatGPTCoding
  1vx0hb6: "we did worktrees and still got wrecked on the shared redis".
- Cursor forum [178144](https://forum.cursor.com/t/178144) (Bulkhead): sessions "step on each other in ways no single session can see": a
  `pkill node` that kills another session's dev server, a port already held, git commands that switch a branch another session uses.
- Cursor forum [175910](https://forum.cursor.com/t/175910): two chats started seconds apart each got the other's task. Staff say it was a
  shared custom-command copy, not worktrees.
- HN 44594584: lmeyerov has "no clean flow for docker: shared system daemon & repository means need to manually tag & run by branch".

### C4. Tools disappear, get bought or go closed (5 threads)

- HN 50369503 (222 points): "Conductor is joining Meta"; "Literally just went to go 'all in' on conductor yesterday ... today we're doing a
  refund + moving the org to t3.codes instead" (iamunr); "I wish, in these cases, the company could open source a version of their desktop
  software" (phildenhoff); freedomben: "I've gotten extremely conservative with adopting any new tooling into my workflow, for exactly reasons
  like this."
- Vibe Kanban sunsetting (r/ClaudeCode 1t1q54w). r/ClaudeCode 1viwdnh: a user asks if the new tools work "with the new policy" (the Agent
  SDK pool). HN 44878650 mccoyb: "why should a hacker submit to using tools behind a SaaS offering ... when one can just roll their own".
- r/ClaudeCode [1vj5ktu](https://www.reddit.com/r/ClaudeCode/comments/1vj5ktu/i_coded_terminal_manager_for_adhd_brains_100/): "There are
  many tools like it" (37 points). People build their own: replies in 1viwdnh, 1xvyxav and 1q9dmxd repeatedly say they built their own (I did not count them).

### C5. Permission and privacy overreach (6 threads)

- HN 44594584, itsalotoffun on Conductor: "Full read-write access required to all your Github account's repos ... You are INSANE to authorize
  this app on anything other than throwaway code." Conductor then moved to a GitHub App with fine-grained access (Charlieholtz, 2025-07-22).
- HN 44533004 (Vibe Kanban): csomar "Why does this need GitHub auth?"; gpm found analytics on by default that collected email addresses and
  GitHub usernames; the maker opened a PR to make it opt-in within the hour.
- HN 46991591 (Omnara): "We don't have true E2EE yet because our service needs access to message content for cross-device sync,
  notifications". HN 48236770 (Superset signs in to a cloud service). HN [50636552](https://news.ycombinator.com/item?id=50636552) (2026-11-24):
  T3 Code v0.1.11 "sends hashed OpenAI and Claude account IDs at first launch"; a tester says it only counts unique accounts.
- Anthropic's own: anthropics/claude-code [#107757](https://github.com/anthropics/claude-code/issues/107757) "Privacy violation in
  User-Agent header" (1,125 reactions, listing only).

### C6. The manager app itself is heavy, freezes or draws wrongly (6 threads)

- HN 48236770, desireco42: "It is vibe coded electron app, 2GB! is too much ... freezing and terminal not being rendered how it should
  be"; micro23xd: in long terminal sessions "some characters show as something else. I have to resize the window to fix it". The Superset
  founder: "we really messed up on the performance".
- HN 50369503, sbarre on Orca: "a lot of UI bugs, buttons that don't work, menus that don't disappear". r/ClaudeCode 1vwjgyv: "11 GB on my
  ssd" (disputed by two replies).
- r/ClaudeCode 1r9wcxc: Conductor "sometimes it starts to lag up and need restarted" (Bob_Fancy); the Claude desktop app "sometimes goes crazy
  and starts using 400% CPU".
- Cursor forum [179238](https://forum.cursor.com/t/179238) (2026-11-25): opening Cursor spawns "34-36 detached cursor-agent background worker
  processes ... (~5.5 GB total)" that survive quitting; staff confirm there is no cap or teardown. [170130](https://forum.cursor.com/t/170130):
  16 worktree sessions overnight crash the window because each window has one renderer memory budget.
- adelope in r/ClaudeCode 1q9dmxd: "if you run 20+ instance of it via web terminals like xterm/vscode it will bring your computer to a crawl".

### C7. Agents do destructive things, and nothing stops them (4 threads)

- r/ClaudeCode [1xqfp7m](https://www.reddit.com/r/ClaudeCode/comments/1xqfp7m/opus_55_xhigh_just_deleted_all_my_apps_data/) (2026-11-07,
  4,198 points, 1,603 comments): "Claude Code just wiped my Mac's ~/Library" through an `xargs` and `rm -rf` mistake while the person was away;
  the top reply points at `--dangerously-skip-permissions`.
- Cursor forum [179296](https://forum.cursor.com/t/179296) (2026-11-25): "Agent deleted multi-day work product and moved personal backups without
  authorization" on Windows 11, to free disk space.
- r/ClaudeCode 1x1esxn (13,000 browser windows). HN 46103532 (listing only, 544 points): "Google Antigravity just deleted the contents of
  whole drive".

### C8. Phone and remote links drop or miss alerts (4 threads)

- r/ClaudeCode 1rdr7ga, m0j0m0j: "forever spinner, nothing happening ... /clear doesn't work and new conversations don't work ... not
  worth it." r/codex 1tdvm9a: "Keep seeing this 'waiting for desktop' on my phone."
- HN 45647166 (Claude Code on the web), Yeroc about Happy Coder: "about 1/2 the time session notifications weren't coming through and the
  developers of the tool seem busy pushing it off in other directions rather than in making the core functionality bullet-proof".
- GitHub (listing only): openai/codex #32908 push not delivered on iOS.

### C9. Vendor account and terms risk (3 threads)

- HN [49548452](https://news.ycombinator.com/item?id=49548452) (2026-09-03, 338 points): "Google Antigravity TOS: 3rd party usage can get
  Google account suspended". warpech: "What is third party? If I self-host OpenClaw, is that third party? If I write my own harness ... Why
  bother creating a CLI and OAuth interface if your ToS punishes for using it". ThatPlayer asks whether `agy -p` called from Codex counts.
- HN [48222529](https://news.ycombinator.com/item?id=48222529) (771 points) "Google's Antigravity bait and switch"; iKlsR on Windows: "had to
  purge everything and lost all my history".
- r/ClaudeAI [1xzipn8](https://www.reddit.com/r/ClaudeAI/comments/1xzipn8/i_built_my_custom_agent_manager_7_months_and_8000/): "I asked
  claude, this seems to be very grey area of using Anthropic subscription" (CrowdGoesWildWoooo); the author changed the app.

### C10. Parallel agents produce plausible wrong work (3 threads)

- HN 44533004, swalsh: "as you scale, you end up with compounded false affirmatives. Model adds some fallback mechanism that makes it work,
  tests pass". codingdave: "AI cannot do this yet." HN 47629485 (Imbue, 100+ agents): "behavioral drift between parallel agent instances is
  nearly invisible". r/ClaudeAI 1xzipn8 and r/ChatGPTCoding 1y3axj0 reach for tests as the gate: "give each agent a tight spec and a test it has
  to pass before it pings me" (djknowss).

## 3. Praise and criticism of each named tool

Tools in the brief that had no HN story I could find through Algolia: Terragon, T3 Code (no launch thread; only the 2026-11-24 privacy post and
mentions), Parallel Code, Vibeyard, agent-deck, ccmanager, opcode. They appear only as names in other threads, if at all.

- **Conductor** (closed source, Mac): praise for UI and for "took 90% of the friction out of working with and using worktrees" (adam-eclse, HN
  50369503). Criticism: GitHub OAuth scope, Mac-only, loses Claude Code's feel (HN 44594584), bought by Meta (above).
- **Claude Squad:** its own Show HN has one comment ([43575127](https://news.ycombinator.com/item?id=43575127)). Its co-creator calls it "the most
  popular+used of these 'claude code multiplexers'" (HN 44594584); a user found the "interface was very clunky" and had no uninstall.
- **Crystal:** "Does One Thing Really Well. ... rough around the edges" and works with an already checked-out repo (HN 44594584, SOLAR_FIELDS and
  jbentley1). Replaced by Nimbalyst per REPORT.md.
- **Vibe Kanban:** "feels like the same increase in productivity increase from when I first used Cursor" (lharries); criticism: telemetry that
  gathered emails (fixed), "doesn't provide anything that some terminal windows and git worktrees can't offer" (helsinki), now sunsetting.
- **Superset / Paradev:** praise from long-term users ("40-50 agent sessions" over several repos, sessions survive updates, native TUIs). Criticism:
  Mac-first, login wall, 2 GB Electron, freezing, Linear integration behind a paywall (HN 48236770).
- **Orca:** praise: "Orca is incredible", sidebar of sessions across repos and two computers, phone app (r/ClaudeCode 1vwjgyv). Criticism: UI bugs
  (HN 50369503), slow remote work, a large install, "very dense and confusing" UI (r/ClaudeAI 1xvyxav, Anovo, who built their own).
- **T3 Code:** the most recommended Conductor replacement in HN 50369503 and r/codex 1y3652l ("T3 is the answer"). Praised for the "Done / Input"
  sidebar and for remote-machine use; the privacy post is the one open criticism.
- **Paseo:** "Fully open-source, I've had no issues with it" and one user runs it on a Hetzner box (HN 50369503). The Show HN's complaints are about
  the word "beautiful" and about shipping from a phone.
- **Herdr and cmux:** praised as multiplexers with agent state, toasts and jump-to-blocked (r/ChatGPTCoding 1y3axj0, r/ClaudeCode 1viwdnh). tbd's author says
  Herdr "rel[ies] on screen scraping" (1viwdnh).
- **Emdash** ([HN 47140322](https://news.ycombinator.com/item?id=47140322), 206 points): wants a signed Windows installer (martinald); "Start Run Script
  button ... just greys out" (noff01, r/ClaudeCode 1r9wcxc).
- **Omnara** (310 and 147 points): "using Claude Code from your phone is kind of great" versus "you've reinvented SSH+screen except slower" and "So
  you're just a Claude Code wrapper?" Messages pass through its servers, with no end-to-end encryption yet.
- **Happy Coder:** notifications dropped about half the time for one user (HN 45647166). The Show HN had 30 points and 8 comments.
- **Sculptor** ([HN 45427697](https://news.ycombinator.com/item?id=45427697), 176 points): praised for safe containerised runs; "free while in beta.
  Ok, and then what?"; the page crashed an iPhone browser.
- **Boxes.dev** (HN 48399358): praised pricing that sleeps when idle; asked about defensibility against the labs and for any-VPS support.
- **Baton:** the site was criticised as unreadable (HN 47599771). **Nimbalyst:** listed in a user's stack (r/ClaudeCode 1viwdnh); its two HN threads
  have 4 and 5 comments, not read in detail.
- **ccusage** (HN 44610925): used widely; one user runs "$600-800/mo in terms of usage" on a $100 plan; a security worry about running `npx` code.
  **CodeBurn** (HN 47759035): doubt from a user ("holy slop") and "Doesn't seem to work with Cursor Agent."
- **Codex app** ([HN 46859054](https://news.ycombinator.com/item?id=46859054), 805 points): Mac-first; OpenAI staff say Windows is coming and sandboxing
  there is the slow part. The in-app browser annotations are praised (r/codex 1svaj3v).
- **Cursor CLI** ([HN 44830221](https://news.ycombinator.com/item?id=44830221)): "Claude Code finally has a serious competitor", "seems pretty basic".
  The Cursor forum shows the Windows and hook problems listed under W10.
- **agy (Antigravity CLI):** most of the talk is about terms and quota (C9, C1), not about running several at once. I found no thread about managing
  many agy sessions.

## 4. Does Harbor already cover it?

Checked in `C:\dev\harbor\app\src`, `C:\dev\harbor\docs\claude\` and `C:\dev\harbor\CLAUDE.md` on 2026-11-26. "Not found" means my search
of those folders for the terms named returned nothing, not that I read every file.

| Want or complaint | Harbor today | Evidence |
|---|---|---|
| W1 status, needs-me, jump | **Partly.** Rail shows working and idle, windows answer questions and permissions in place, a "finished while you were away" rule, desktop OS notifications on a pane going from working to idle. No phone push found, and no jump-to-next-needing-me key found. | `docs/claude/views.md:38`; `docs/claude/conversation.md:33`; `app/src/main/notify.js:3`; `app/web/src/main.jsx:109` registers `/sw.js` but a search of `app/web` and `app/src` for a `push` event listener found none. Jump key: not checked. |
| W2 worktrees, ports, untracked files | **Partly.** A workspace pool leases fixed worktree slots to lanes and launchers. No port, database or `.env` copy handling found. Not a default for ordinary chat windows (I did not verify how a person starts one). | `docs/claude/lanes.md`; searches for "port conflict/collision/offset" in `docs/claude` and `app/src` returned nothing. |
| W3 phone with push and approve | **Partly.** A phone web app is live and answers cards; no push, and no approve-from-alert. Self-hosted, so the relay-privacy complaint (C5) does not apply. | `app/web`; memory index "Harbor Mobile live on Legion"; no push listener (above). |
| W4 cost, plan room, resume after limit | **Partly.** Plan usage dropdown, move a session to another plan, usage-limit and model-switch cards, a cache-warmth chip. No dollar cost per session, no auto-resume. | `docs/claude/views.md:46`; `app/src/main/actions/change-plan.js` (`movePlan`); `docs/claude/conversation.md:77`; search for autoResume/autoContinue returned nothing. Cache chip: from REPORT.md, not re-opened. |
| W5 real CLIs, any provider, own subscription | **Yes.** Four providers; each CLI runs in a pty; a `>_` toggle shows the raw terminal; chat is built from transcripts. | `CLAUDE.md` (first section); `_context.md`. |
| W6 survive app close | **Yes.** Session daemon keeps each pty; dormancy and reconcile exist. | `docs/claude/sessiond.md`. |
| W7 find an old session | **Partly.** Rail, pins, titles and a search. REPORT.md says the search covers project, title and first prompt only; I did not re-check that line. | `docs/claude/views.md:24`; REPORT.md section 5. |
| W8 diffs and review | **No.** No diff component found in the renderer (matches were Artifacts, Notes and unrelated files). | REPORT.md section 2; `app/src/renderer` search for "diff". |
| W9 task-per-agent board | **No.** The Tasks view is the person's own list, not agents; Orch view runs batches of workers. | `docs/claude/views.md:56`. |
| W10 Windows | **Yes, and it is the niche.** Native Windows app; popup rules; Windows ConPTY daemon. | `CLAUDE.md`. |
| W11 multi-machine, cloud | **No.** One machine plus a phone over the tailnet. A search of `docs/claude/sessiond.md` and `views.md` for ssh and remote machine found nothing. | |
| W12 agents messaging each other | **Yes.** `bin/harbor-msg` and the inbox hook, plus the Orch view and team chart. | `docs/claude/conversation.md` (mentions `harbor-msg`); memory index "Team chart 2026-11-02". |
| C1 limits opaque | **Partly** (see W4). Harbor reads every account's usage; it does not predict, alert, or resume. | as W4 |
| C2 person is the bottleneck | **Partly.** W1 and W7 features reduce it. Nothing found that limits how many sessions run. | |
| C3 collisions (ports, DB, shared dirs) | **No** for runtime collisions. Lanes give separate worktrees. A guard like Bulkhead (kill by name, held ports, shared branches) was not found. | as W2 |
| C4 tools vanish | **Not a gap in Harbor.** It is local, and has a public mirror (CLAUDE.md "public repo" bullet). A positioning point. | `CLAUDE.md` |
| C5 privacy | **Yes for what I checked.** No analytics library found in `app/src` or `app/web/src`. The crash dump setting is `uploadToServer: false`. | `app/src/main/crash-capture.js:103`; search for sentry, posthog, mixpanel, amplitude, google-analytics returned nothing. |
| C6 heavy app | **Addressed, not measured here.** Performance doctrine, a renderer leak fix, a 16-window cap. | `docs/claude/performance.md`; CLAUDE.md `use-callback` bullet. |
| C7 destructive agents | **Not in Harbor.** Harbor recognises the "bypass permissions" footer but adds no guard of its own; the guards on this machine are Pat's hooks, outside Harbor. | `app/src/main/session-send.js:5224`. |
| C8 phone drops alerts | **Partly.** A link watchdog and send queue exist; no push to drop. | `app/src/server/link-watchdog.js`; memory index phone entries. |
| C9 vendor terms | **Partly.** Harbor types into the real CLI, which is the posture users say avoids the "Agent SDK" meter. It sets `AGY_CLI_DISABLE_AUTO_UPDATE`. Worker runs that use `claude -p` or `agy -p` were not checked here. | REPORT.md section 10. |
| C10 plausible wrong work | **Partly.** Orch and lanes exist; REPORT.md section 9 already lists a test gate before landing. | |

## 5. What this adds to REPORT.md's short list

1. **Phone push for "needs you" is wanted by more separate threads than any other mobile item** (W3, C8) and is the part Harbor lacks. It also
   raises REPORT.md item 8 above item 6.
2. **Runtime isolation per lane (ports, database, temp dirs)** is a repeated failure story (C3, W2) that REPORT.md does not mention. Cursor's
   forum has an open-source guard (Bulkhead) that shows the checks people want.
3. **Plan-room and "continue after reset" is backed by votes.** openai/codex #21073 has 94 reactions; users of competing tools praise showing all
   accounts' remaining usage (tbd). Harbor already has the data from its 15 accounts.
4. **The strongest positioning facts from users**: local, no account, real CLI, sessions survive updates, and no vendor can shut it down
   (C4, C5, W5, W6). Several users switched tools after the Conductor announcement.
5. **A caution on dashboards**: users say a sidebar that only lists what needs them still leaves them as the scheduler. They want the question and
   a default answer in the alert. Harbor's in-window answer cards already do this on the desktop.

## 6. Not done or not verified

- GitHub Discussions of anthropics/claude-code and openai/codex were not opened. I used Issues search by reactions instead, and only read titles
  and counts. The search API rate-limited me once and I waited.
- r/ClaudeCode `sort=new` was not run. r/LocalLLaMA and r/GoogleGeminiAI returned almost nothing on topic (the agy threads are on HN and GitHub).
  r/google_antigravity and r/vibecoding were not read beyond titles.
- HN comment bodies of Orca ([47549197](https://news.ycombinator.com/item?id=47549197)), Nimbalyst, Happy, 1Code, Pizza Bot, Foremerge and the
  merge-queue thread were saved but not read in depth.
- Cursor forum: I read 12 topics. I did not search for `agent` CLI threads about hooks on Windows beyond 177677, 177989 and 177889.
- The "separate threads" counts are from hand tallies of what I read. A want mentioned only inside comments I did not read is not counted.
- I did not open the Anthropic policy on programmatic use (June 2026); its effect is as the users describe it.

## Appendix: threads read

HN (saved under `C:\dev\.orch\harbor\oss-deep\w4\hn\`): 44594584, 50369503, 44533004, 48236770, 46368739 (skimmed), 48377250, 47140322,
44878650, 46991591, 45427697, 48399358, 47599771, 44610925, 47759035, 46859054, 44830221, 50645541, 47629485, 49548452, 48222529, 45967814,
50636552, 43575127, 45647166 (grep only).
Reddit (`C:\dev\.orch\harbor\oss-deep\w4\r-t1.txt` to `r-t4.txt`): r/ClaudeCode 1viwdnh, 1t1q54w, 1q9dmxd, 1r9wcxc, 1vj5ktu, 1ue5inx, 1vwjgyv,
1x1esxn, 1sciznh, 1y4p7gi, 1x1z70y, 1rg4wdy, 1xcnrxk, 1xqfp7m, 1x4aqyi, 1rdr7ga, 1xwk66v, 1xhvnjw; r/ClaudeAI 1xvyxav, 1xzipn8, 1vahwvi,
1xst2qe, 1s4idaq; r/ChatGPTCoding 1vx0hb6, 1y3axj0; r/cursor 1wgt9x7, 1s0k46x, 1rrrwba; r/codex 1y3652l, 1tdvm9a, 1svaj3v, 1rokhh3;
r/OpenAI 1xw6xzn, 1rdxlo2.
Cursor forum (`cf\threads.txt`): 179238, 177889, 177677, 177989, 175910, 170130, 175337, 175983, 178144, 179296, 170506, 177021.
Search rows: `s-all.txt` (1,174 rows) in the same folder.
