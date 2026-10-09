'use strict';

// CLI update checker: "an update is available" for the three provider CLIs
// (claude, codex, cursor), the way the Claude desktop app does it. Built
// 2026-09-03 to Pat's rule: check automatically, NEVER install on its own, and
// show what an update changes and what it may break in Harbor BEFORE the click.
//
// The fear this exists to answer, verbatim: "an update that reverts a change
// we've made and then we flail and burn usage like crazy for something that
// changed in the update". So the checker does three things a version number
// alone cannot:
//
//   1. It reads the release notes for exactly the versions being crossed
//      (installed exclusive, latest inclusive), not "the latest release".
//   2. It tags every note line that touches a Harbor contract with WHY Harbor
//      cares and WHICH proof re-runs it. That list lives in IMPACT_FLAGS below
//      and is derived from docs/claude/*.md, so it grows with the doctrine.
//   3. It snapshots the CLI's config files before an install, and can diff or
//      restore them at any time afterwards. Config drift usually happens on
//      the CLI's FIRST RUN after an update, not at install time, which is why
//      configDiff() is a standing command and not a step in install().
//
// Shape mirrors model-catalog.js: discovered at boot plus every six hours,
// off under HARBOR_E2E and behind an env kill switch, every failure honest,
// per provider, and non-fatal. Everything is injected so the suite runs with
// no network, no npm, and no real home directory.

const path = require('node:path');
const { cliCommand } = require('./cli-command.js');

const NPM_REGISTRY = 'https://registry.npmjs.org';
const CLAUDE_CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const CODEX_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=40';
// Unauthenticated Connect-RPC unary call, verified 2026-09-03: the cursor agent
// CLI has no npm package and no plain "latest version" file, but its own
// `update` command asks this endpoint (src/commands/update-core.ts in the
// bundle) and it answers { version, url } with no credential.
const CURSOR_LATEST_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl';

const PROVIDER_IDS = ['claude', 'codex', 'cursor'];

const PROVIDERS = {
  claude: { id: 'claude', label: 'Claude Code', pkg: '@anthropic-ai/claude-code', source: 'npm' },
  codex: { id: 'codex', label: 'Codex', pkg: '@openai/codex', source: 'npm' },
  cursor: { id: 'cursor', label: 'Cursor Agent', pkg: null, source: 'cursor-agent' },
};

// A version we are willing to hand to a shell as part of a package spec. Every
// install argument is checked against this first: the version comes off the
// network, and "npm install -g pkg@<whatever the registry said>" is not a place
// to trust a remote string.
const SAFE_VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,63}$/;

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

// Compare two version strings. Handles both shapes Harbor meets: npm semver
// (2.1.258, 0.154.0-alpha.3) and the cursor agent's date build
// (2026.08.31-4057e58). The numeric dot segments before the first '-' decide
// it; a suffix only matters on a tie, where an ABSENT suffix ranks higher
// (1.0.0 beats 1.0.0-alpha.1) and two different build hashes on the same core
// compare equal, so a same-day cursor rebuild never nags as "newer".
function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value || '').trim();
    const dash = text.indexOf('-');
    const core = dash < 0 ? text : text.slice(0, dash);
    const suffix = dash < 0 ? '' : text.slice(dash + 1);
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), suffix };
  };
  const va = parse(a);
  const vb = parse(b);
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i += 1) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (va.suffix === vb.suffix) return 0;
  // A prerelease suffix ranks below the bare release. Two different suffixes on
  // one core are builds of the same version, not an upgrade path.
  if (!va.suffix) return 1;
  if (!vb.suffix) return -1;
  return 0;
}

function isNewer(latest, installed) {
  if (!latest || !installed) return false;
  return compareVersions(latest, installed) > 0;
}

// ---------------------------------------------------------------------------
// Impact flags: the Harbor contracts an update can break
// ---------------------------------------------------------------------------
//
// Each flag is { id, re, why, verify }. A release-note line matching `re`
// renders with `why` under "may affect Harbor", and `verify` names the command
// that re-proves that contract after the install. Seeded from docs/claude/
// (conversation.md for the ask sheet and transcript, providers.md for launch,
// homes and the model catalog, sessiond.md for the screen model).
//
// REVERTED is deliberately provider-independent and listed first: "an update
// that reverts a change we've made" is the exact failure Pat named, and a
// revert can appear in any CLI's notes.
const REVERTED_FLAG = {
  id: 'reverted',
  // "revert" plus the words a changelog actually uses for the same act: roll
  // back / rollback, back out / backout, reinstate. This is the exact fear Pat
  // named ("an update that reverts a change we've made"), so the net is wide.
  re: /\brevert(s|ed|ing)?\b|\broll(s|ed|ing)?[\s-]?back\b|\brollback\b|\bback(s|ed|ing)?[\s-]?out\b|\bbackout\b|\bre-?instate(s|d)?\b/i,
  why: 'This line UNDOES an earlier change. If Harbor was built against the behaviour being reverted, the update silently takes it back.',
  verify: 'npm test -- --exclude daemon --exclude bin',
};

const IMPACT_FLAGS = {
  claude: [
    {
      id: 'ask-dialog',
      re: /AskUserQuestion|permission prompt|permission dialog|\bdialog\b|approval prompt/i,
      why: 'Harbor answers AskUserQuestion, permission and resume dialogs by WALKING THE PTY SCREEN, not the transcript. A change to how a dialog is drawn breaks the ask sheet.',
      verify: 'node scripts/drive-ask-sheet-win.js',
    },
    {
      id: 'claude-json',
      re: /\.claude\.json|claude\.json/i,
      why: 'Harbor reads ~/.claude.json for the account email, the per-folder trust markers bin/ai pre-accepts, and installMethod/autoUpdates.',
      verify: 'npm test -- providers',
    },
    {
      id: 'settings',
      re: /settings\.json|managed settings|settings file/i,
      why: 'Each config home\'s settings.json carries Harbor\'s hooks, permissions and statusline wiring across three plans.',
      verify: 'npm test -- providers',
    },
    {
      id: 'trust',
      re: /\btrust(ed|s)?\b|workspace trust/i,
      why: 'bin/ai pre-accepts the per-folder trust marker in BOTH path spellings (CLI 2.1.229 respelled project keys with forward slashes). A trust change makes every launch stop at a prompt.',
      verify: 'npm test -- bin/ai-launch-argv',
    },
    {
      id: 'hooks',
      re: /\bhooks?\b/i,
      why: 'Pat\'s guard, style-lint and doctrine-reinjection hooks run from settings.json in all three homes.',
      verify: 'powershell ~/.claude/hooks/test-hooks.ps1',
    },
    {
      id: 'plugins',
      re: /plugin|marketplace|skill/i,
      why: 'capabilities.js enumerates plugins and live slash commands for the command-bar capability menu; the three homes share a junctioned plugins/ dir.',
      verify: 'npm test -- capabilities',
    },
    {
      id: 'transcript',
      // "resumed" too (2026-10-09): 2.1.295 "the removed turns coming back,
      // when the session was ... resumed after being killed" matched nothing,
      // and dormancy kills and Harbor resumes sessions every day.
      re: /transcript|\.jsonl|jsonl|projects director|session id|--session-id|\bresum(?:e|ed|es|ing)\b|--continue|\B-p\b/i,
      why: 'The history index, the transcript parser, resume and the minted --session-id all read ~/.claude/projects. A transcript or session-id change is felt by every rail row and every conversation window.',
      verify: 'npm test -- transcript',
    },
    {
      id: 'statusline',
      re: /status ?line/i,
      why: 'The statusline tee is how Harbor learns usage, the context gauge denominator, and the takeover owner pid.',
      verify: 'npm test -- usage',
    },
    {
      id: 'screen',
      // Deliberately narrower than "anything about the terminal": a bare
      // "render" or "terminal" matched 43 percent of a real four-version
      // changelog, and a flag that fires on everything says nothing. A resize
      // or blank-row line IS a screen line when it is about the terminal
      // (2.1.269 "rows ... going blank in fullscreen after resizing the
      // terminal" matched nothing here, while ensureDialogSize live-resizes
      // the pty on purpose; 2026-09-14), so those two words are anchored to a
      // terminal/fullscreen/pty word on the same line: an image "resized" or a
      // VSCode tab "going blank" must not fire it.
      // 2026-10-09 (2.1.295): a new terminal protocol ("Program Status
      // Protocol (OSC 7501)", a query written into every pane at startup), tab
      // stops and bidirectional text "drawing over nearby rows" all matched
      // nothing; the last is the same overdraw class as the emoji width bug.
      re: /emoji|wrap(ped|ping)? line|word wrap|alternate screen|\bANSI\b|\bcolumns?\b|repaint|redraw|terminal (width|size|render)|^(?=.*\b(?:terminal|fullscreen|pty)\b).*(?:resiz(?:e|ed|es|ing)\b|\bblank\b)|\bOSC ?\d+\b|\btab stops?\b|\bbidirectional\b/i,
      why: 'The daemon models the pty SCREEN. Width, emoji width and alternate-screen changes desync that model, which is exactly what broke the ask card on 2026-09-03.',
      verify: 'node scripts/drive-ask-sheet-win.js',
    },
    {
      id: 'model',
      // A family name with a version (2026-10-07): "Added Claude Haiku 5.5
      // (`claude-haiku-5-5`)" matched nothing here, and a new model is the
      // line that most needs the seed, the menus and the worker recipes.
      re: /\/model\b|model id|model picker|\beffort\b|--effort|\bclaude-(?:opus|sonnet|haiku|fable|mythos)-\d|\b(?:Opus|Sonnet|Haiku|Fable|Mythos) \d+(?:\.\d+)?\b/i,
      why: 'model-catalog.js scans the installed binary for launchable ids and bin/ai forwards --effort at launch. A renamed id or dropped flag empties the capability menu.',
      verify: 'npm test -- model-catalog',
    },
    {
      id: 'auto-update',
      // claude.exe added 2026-09-25: 2.1.281 "Fixed a race in which Claude Code
      // sessions updating at the same moment could delete each other's claude.exe
      // backup" matched nothing, and it is the file the out-of-band install chain
      // exists to replace.
      re: /auto ?-? ?update|installMethod|install method|self-?update|claude\.exe/i,
      why: 'Harbor deliberately keeps autoUpdates FALSE and installMethod "global". The update chip can replace Claude while existing sessions keep their loaded version until resumed. Changes to self-updating or executable replacement need verification.',
      verify: 'node -e "console.log(require(process.env.USERPROFILE+\'/.claude.json\').autoUpdates)"',
    },
    {
      id: 'mcp',
      re: /\bMCP\b/,
      why: 'The MCP server list feeds the capability menu, and Pat\'s three homes are reconciled to one MCP union by claude-sync.',
      verify: 'node C:/tools/claude-sync/sync-plans.mjs',
    },
    // 2026-09-25 (2.1.281): "the dangerous `rm` prompt in
    // --dangerously-skip-permissions ... wait 2 minutes, then deny" matched no
    // flag, yet it is a NEW dialog in the exact mode every Harbor launch uses.
    {
      id: 'bypass-mode',
      re: /dangerously-skip-permissions|bypass(?:Permissions)? mode|permission mode|defaultMode/i,
      why: 'Harbor launches every claude session with --dangerously-skip-permissions. A prompt that appears in that mode is a dialog the ask card must surface, and a mode change alters what every pane does unattended.',
      verify: 'node scripts/drive-ask-sheet-win.js',
    },
    // Same review: "queued messages show ... above the spinner" (2.1.281) and
    // "pasted multi-line text ... bracketed paste" (2.1.282) matched nothing.
    // 2026-10-07: neither did "pasted text ... sent as if it had been typed"
    // (2.1.290, 2.1.292, 2.1.293), which is how the CLI classifies every
    // multi-line Harbor send.
    // 2026-10-09: the left-arrow "backgrounding" messages draw next to the
    // composer box that delivery confirmation reads (2.1.295 "Backgrounding
    // cancelled"), and matched nothing.
    {
      id: 'composer',
      re: /queued messages?|messages? queued|bracketed paste|send now|type-?ahead|keys typed|pasted text|\bpastes\b|as typed|typed text|\bbackgrounding\b/i,
      why: 'session-send confirms a delivery by reading the composer box and the echo above it, and sends every message as a bracketed paste plus Enter. A change to either is felt by every send.',
      verify: 'node_modules/electron/dist/electron.exe scripts/drive-resume-hooks-win.js',
    },
    // 2026-10-07 (2.1.292): "Changed usage limit messages to write claude.ai
    // settings links with https://" matched nothing, and model-switch.js reads
    // that screen.
    {
      id: 'usage-limit',
      re: /usage limits?\b|usage credits|extra usage|rate limit/i,
      why: 'model-switch.js recognizes the usage-limit, checking-credits and session-paused screens by their title lines and draws the CLI\'s own choices as a card. A wording or layout change sends them back to the raw fallback panel.',
      verify: 'npm test -- model-switch',
    },
    // 2026-10-09 (2.1.295): the /loop wakeup notice, the cancelled-wakeup
    // notice and the stopped-MCP-call notice matched no flag, and the first
    // was a notice background-tasks.js did not match. Narrow on purpose:
    // `claude agents` background sessions and services are not this fold.
    {
      id: 'background-tasks',
      re: /\bbackground (?:tasks?|agents?(?!')|subagents?|workflows?|shells?|commands?)\b|\/loop\b|\bwakeups?\b|\btask[- ]notifications?\b|\bTaskStop\b|\bscheduled tasks?\b|\btasks panel\b|\btask ids?\b/i,
      why: 'background-tasks.js folds the whole transcript for background work: launch results, the CLI\'s task notifications, TaskStop, /loop wakeups and the stopped-on-resume notices. A notice it does not match leaves a finished task counted as running, and the session stays in the light-blue background state instead of ready.',
      verify: 'npm test -- delegations',
    },
    // 2026-10-09 (2.1.295): "Fixed `--tools` ... not applying to built-in
    // tools that register after launch" matched nothing, and the titler's
    // empty room is built from exactly these flags.
    {
      id: 'titler',
      re: /--tools\b|--setting-sources\b|--disable-slash-commands\b|--strict-mcp-config\b|--system-prompt\b|--max-turns\b|\bMAX_THINKING_TOKENS\b/,
      why: 'titles.js mints every rail title with claude -p in an empty room: no tools, no setting sources, no slash commands, a strict empty MCP config and zero thinking. A change to any of those flags changes what each title call loads and costs.',
      verify: 'npm test -- titles',
    },
  ],
  codex: [
    {
      id: 'rollout',
      re: /rollout|session_meta|item_completed|event_msg|response_item/i,
      why: 'transcript.js applyCodexLine parses the rollout item stream. 0.147.0 moved the conversation once already and Harbor rendered empty windows over live sessions until it was found.',
      verify: 'npm test -- transcript',
    },
    {
      id: 'resume',
      re: /\bresume\b|\bfork\b|--output-last-message|\bexec\b/i,
      why: 'bin/ai composes "codex resume ... <id>" for dead sessions and orchestration workers launch through codex exec.',
      verify: 'npm test -- providers',
    },
    {
      id: 'sandbox',
      re: /sandbox|approval|dangerously-bypass|permission/i,
      why: 'Harbor resumes codex with --dangerously-bypass-approvals-and-sandbox. If that flag is renamed or gated, every codex resume stops at a prompt no Harbor surface can answer.',
      verify: 'npm test -- providers',
    },
    {
      id: 'config-toml',
      re: /config\.toml|CODEX_HOME|\bprofile\b/i,
      why: 'A codex profile travels as CODEX_HOME, and ~/.codex/config.toml is the file that decides model, approvals and MCP for that home.',
      verify: 'npm test -- providers',
    },
    {
      id: 'models',
      re: /models_cache|model picker|model catalog|model (list|id|name|slug)|default model|\/model\b|\bGPT-\d/i,
      why: 'Harbor discovers codex models from models_cache.json for the new-session popover.',
      verify: 'npm test -- capabilities',
    },
    {
      id: 'visibility',
      // "Enabled fullscreen transcripts by default" (0.157.0) matched nothing
      // here, and it moved the whole pane onto the alternate screen.
      re: /visibilit|\bTUI\b|alternate screen|alt[- ]screen|full-?screen|scrollback|repaint|redraw/i,
      why: 'The codex pane is read through the same pty screen model as claude; a TUI rewrite changes what Harbor sees. bin/ai pins tui.fullscreen_transcript=false so panes keep the inline transcript Harbor was proven against.',
      verify: 'npm test -- transcript',
    },
    // 2026-09-25: codex 0.157.0 "Enabled automatic background-server startup"
    // and "migration prompts for older models" both matched NO flag, and they
    // were the two lines that mattered most in that release.
    {
      id: 'daemon',
      re: /background[- ]server|\bdaemon\b|app-server|auto-?start|self-?update|in-app update/i,
      why: 'Every Harbor codex pane runs --no-daemon: one pane, one process, one thread. The shared server copies codex into CODEX_HOME/packages, outlives the pane, keeps that copy after npm moves on, and can update itself.',
      verify: 'npm test -- ai-launch-argv',
    },
    {
      id: 'startup-screen',
      re: /migration prompt|model migration|startup (prompt|screen|dialog)|onboarding|\brecovery (choice|prompt)s?\b|\bmodal\b/i,
      why: 'Harbor types into a codex pane once its screen settles. A startup screen that takes Enter eats that message: the model-migration screen also writes model = ... into config.toml. bin/ai acknowledges every migration models_cache.json lists; a new startup screen needs the same treatment.',
      verify: 'npm test -- ai-launch-argv',
    },
  ],
  cursor: [
    {
      id: 'resume',
      re: /--resume|--force|--trust|--print|\B-p\b|\byolo\b|workspace trust|auto-?update/i,
      why: 'bin/ai composes "cursor-agent --force --trust --disable-auto-update" (plus "--resume <id>"). --trust keeps the interactive Workspace Trust screen, whose first option takes Enter, from eating Harbor\'s first send; --disable-auto-update keeps a pane from installing the next build itself. An unknown option makes the pane exit on open.',
      verify: 'npm test -- ai-launch-argv',
    },
    {
      id: 'transcripts',
      re: /agent-transcripts|transcript|chat history|\bchats?\b/i,
      why: 'provider-history.js scans ~/.cursor/projects/*/agent-transcripts, and a durable id-to-cwd sidecar is the only thing that makes a dormant cursor session resumable.',
      verify: 'npm test -- provider-history',
    },
    {
      id: 'install-layout',
      re: /versions director|install (path|layout|location)|\.local\/bin|cursor-agent\.(cmd|ps1)/i,
      why: 'Harbor reads the installed version from the newest folder under cursor-agent/versions/, and on Windows bin/ai launches that folder\'s node.exe index.js directly (sessiond cannot run the .cmd/.ps1 handoff). A layout change breaks both.',
      verify: 'npm test -- ai-launch-argv',
    },
  ],
};

function flagsFor(provider) {
  return [REVERTED_FLAG, ...(IMPACT_FLAGS[provider] || [])];
}

// Tag one note line with every flag it matches. Returns the flag descriptors
// without their regexes so the payload is structured-clonable over IPC.
function tagLine(provider, line) {
  const hits = flagsFor(provider).filter((flag) => flag.re.test(line));
  return {
    text: line,
    flags: hits.map(({ id, why, verify }) => ({ id, why, verify })),
  };
}

// ---------------------------------------------------------------------------
// Release-note parsing
// ---------------------------------------------------------------------------

// The claude CHANGELOG.md is "## <version>" sections, newest first, with "- "
// bullets. Returns [{ version, lines }] in file order.
function parseClaudeChangelog(markdown) {
  const sections = [];
  let current = null;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const heading = /^##\s+v?([0-9][0-9A-Za-z.+-]*)\s*$/.exec(raw.trim());
    if (heading) {
      current = { version: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
    if (bullet) current.lines.push(bullet[1]);
  }
  return sections;
}

// GitHub releases for openai/codex. Tags are rust-v<version>; prereleases
// (0.154.0-alpha.N) and drafts are dropped because Harbor never installs one.
function parseCodexReleases(releases) {
  if (!Array.isArray(releases)) return [];
  return releases
    .filter((release) => release && !release.prerelease && !release.draft)
    .map((release) => {
      const tag = String(release.tag_name || '');
      const version = /^rust-v(.+)$/.exec(tag)?.[1] || null;
      if (!version) return null;
      const lines = [];
      for (const raw of String(release.body || '').split(/\r?\n/)) {
        const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
        if (!bullet) continue;
        const text = bullet[1];
        // The auto-appended commit roll-up under "## Changelog" repeats every
        // bullet as "#42632 Fix ... @author"; it is noise beside the real notes.
        if (/^#\d+\s/.test(text)) continue;
        lines.push(text);
      }
      if (/^\s*Full Changelog:/m.test(release.body || '') && !lines.length) {
        lines.push('No release notes were published for this version.');
      }
      return { version, lines };
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));
}

// The sections strictly ABOVE installed and up to and including latest: the
// versions this click would actually cross. Newest first.
function sectionsBetween(sections, installed, latest) {
  return (sections || []).filter((section) => {
    if (!section?.version) return false;
    if (installed && compareVersions(section.version, installed) <= 0) return false;
    if (latest && compareVersions(section.version, latest) > 0) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Config snapshot and diff
// ---------------------------------------------------------------------------

// The files an update can quietly rewrite, per provider. The config HOMES are
// DISCOVERED on disk, never hardcoded: every `.claude*` directory beside the
// user's home is a claude config home and every `.codex*` a codex one, so the
// real set of profiles is found rather than named (which also keeps any one
// operator's private profile names out of the product source). Absent files are
// skipped by the caller; this is the CONFIG surface only, not the whole home
// (transcripts and caches are not settings).
async function configTargets(provider, home, env, readdir) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const homeDirs = async (re) => {
    try {
      return (await readdir(home))
        .map((entry) => (typeof entry === 'string' ? entry : entry.name))
        .filter((name) => re.test(name));
    } catch {
      return [];
    }
  };
  if (provider === 'claude') {
    const out = [path.join(home, '.claude.json')];
    for (const dir of await homeDirs(/^\.claude(-[\w.-]+)?$/)) {
      out.push(path.join(home, dir, '.claude.json'));
      out.push(path.join(home, dir, 'settings.json'));
    }
    return out;
  }
  if (provider === 'codex') {
    return (await homeDirs(/^\.codex(-[\w.-]+)?$/)).map((dir) => path.join(home, dir, 'config.toml'));
  }
  if (provider === 'cursor') {
    return [
      path.join(home, '.cursor', 'cli-config.json'),
      path.join(home, '.cursor', 'hooks.json'),
      path.join(home, '.cursor', 'argv.json'),
      path.join(local, 'cursor-agent', 'cursor-agent.ps1'),
    ];
  }
  return [];
}

// A snapshot copy is flattened to one filename per source so the directory is
// readable by eye; the manifest keeps the real path.
function snapshotName(source) {
  return source.replace(/[\\/:]+/g, '_').replace(/^_+/, '');
}

// Credential-shaped key names only. A bare "key" substring is too wide to be
// useful: half the interesting keys in a settings file end in "Key" and
// redacting them would turn the diff into a wall of "(redacted)".
const SECRET_KEY_RE = /^key$|^auth$|token|secret|password|passwd|credential|cookie|authorization|authentication|oauth|bearer|apikey|accesskey|privatekey|secretkey|clientsecret/;
// Whole objects that hold credentials even when their OWN key name does not read
// as one: an OAuth account, an env block, an MCP server definition. These are
// redacted wholesale so a nested token cannot ride out inside a truncated dump.
const SECRET_CONTAINER_RE = /^(oauthaccount|env|mcpservers?|apikeyhelper)$/;

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z]/g, '');

// Redact by key name at EVERY depth. The diff is a UI payload and .claude.json
// holds an OAuth account and MCP env blocks; before 2026-09-03 only the TOP
// level key was checked, so a top-level object whose own name was innocuous
// (oauthAccount, env) had its nested token JSON-dumped straight into the UI.
function redactDeep(key, value) {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_RE.test(normalized) || SECRET_CONTAINER_RE.test(normalized)) return '(redacted)';
  if (Array.isArray(value)) return value.map((item) => redactDeep('', item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(k, v);
    return out;
  }
  return value;
}

function truncate(value, limit = 120) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return 'null';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

// Values are redacted by KEY NAME at every depth before truncation. A config
// comparison must not become a credential viewer.
function renderValue(key, value) {
  return truncate(redactDeep(key, value));
}

function diffJson(beforeText, afterText) {
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return null;
  }
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push({ key, value: renderValue(key, after[key]) });
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push({ key, from: renderValue(key, before[key]), to: renderValue(key, after[key]) });
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) removed.push({ key, value: renderValue(key, before[key]) });
  }
  return { kind: 'json', added, removed, changed };
}

function diffText(beforeText, afterText) {
  const lines = (text) => String(text).split(/\r?\n/).length;
  return {
    kind: 'text',
    changed: beforeText !== afterText,
    lineDelta: lines(afterText) - lines(beforeText),
  };
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

function emptyProviderState(id) {
  return {
    id,
    label: PROVIDERS[id]?.label || id,
    installed: null,
    latest: null,
    source: PROVIDERS[id]?.source || null,
    checkedAt: null,
    dismissed: [],
    notes: null,
    flags: [],
    history: [],
    error: null,
  };
}

function emptyState() {
  const providers = {};
  for (const id of PROVIDER_IDS) providers[id] = emptyProviderState(id);
  return { checkedAt: null, providers };
}

/**
 * @param {object} options
 * @param {Function} [options.fetchImpl]  global fetch by default
 * @param {Function} [options.execFile]   promisified execFile(file, args, opts)
 * @param {Function} [options.readFile]   fsp.readFile
 * @param {Function} [options.writeFile]  fsp.writeFile
 * @param {Function} [options.mkdir]      fsp.mkdir
 * @param {Function} [options.readdir]    fsp.readdir (snapshot listing)
 * @param {object}   [options.env]
 * @param {Function} [options.homedir]
 * @param {Function} [options.now]
 * @param {string}   [options.stateFile]  defaults to ~/.harbor/cli-updates.json
 * @param {string}   [options.fixtureFile] HARBOR_CLI_UPDATES_FIXTURE, a prepared
 *                                        state used INSTEAD of the network so a
 *                                        drive can see the chip without one.
 * @param {Function} [options.log]
 */
function createCliUpdateChecker(options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir || (() => require('node:os').homedir());
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  const now = options.now || (() => new Date());
  const log = options.log || (() => {});
  const fsp = require('node:fs/promises');
  const readFile = options.readFile || fsp.readFile;
  const writeFile = options.writeFile || fsp.writeFile;
  const mkdir = options.mkdir || fsp.mkdir;
  const readdir = options.readdir || fsp.readdir;
  const execFile = options.execFile || require('node:util').promisify(require('node:child_process').execFile);

  // Shared app state lives at ~/.harbor on win32, deliberately outside
  // %APPDATA% (the MSIX virtualization rule); same home as config.json.
  const home = homedir();
  const stateFile = options.stateFile
    || env.HARBOR_CLI_UPDATES_FILE
    || path.join(home, '.harbor', 'cli-updates.json');
  const snapshotRoot = options.snapshotRoot
    || path.join(path.dirname(stateFile), 'cli-updates', 'snapshots');
  const fixtureFile = options.fixtureFile || env.HARBOR_CLI_UPDATES_FIXTURE || null;

  let state = emptyState();
  let loaded = false;
  let loading = null;
  const listeners = new Set();
  const installedListeners = new Set();
  const installOwners = new Set();
  const provisionalMissing = new Set();
  const installedRevisions = Object.fromEntries(PROVIDER_IDS.map((id) => [id, 0]));

  const emit = () => { for (const listener of listeners) { try { listener(state); } catch { /* a listener must not break a check */ } } };

  let persistence = Promise.resolve();
  const persist = () => {
    const content = `${JSON.stringify(state, null, 2)}\n`;
    persistence = persistence.then(async () => {
      try {
        await mkdir(path.dirname(stateFile), { recursive: true });
        await writeFile(stateFile, content);
      } catch (error) {
        log(`cli-updates: state write failed: ${error.message}`);
      }
    });
    return persistence;
  };

  const load = async () => {
    if (loaded) return state;
    if (loading) return loading;
    loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
        const merged = emptyState();
        merged.checkedAt = parsed?.checkedAt || null;
        for (const id of PROVIDER_IDS) {
          const provider = { ...merged.providers[id], ...(parsed?.providers?.[id] || {}), id };
          // A persisted file can carry `dismissed: null` (or a non-array), which
          // would throw the moment dismiss() called .includes on it; coerce the
          // list-shaped fields back to arrays here (2026-09-03).
          provider.dismissed = Array.isArray(provider.dismissed) ? provider.dismissed : [];
          provider.history = Array.isArray(provider.history) ? provider.history : [];
          merged.providers[id] = provider;
        }
        state = merged;
      } catch {
        // No state yet, or a corrupt file. An empty state is always answerable.
        state = emptyState();
      }
      // 2026-09-20: persisted installed versions are evidence of a previous read,
      // not current truth. No caller or subscriber can see them before this read.
      await reconcileLocal(true);
      loaded = true;
      return state;
    })().finally(() => { loading = null; });
    return loading;
  };

  // Every network call gets a deadline. Without one, a single endpoint that
  // accepts the connection and never sends a body would hang the whole check
  // forever (the Promise.all below waits for every provider), so a wedged
  // registry could pin the checker on "Checking..." with no way out (2026-09-03).
  const FETCH_TIMEOUT_MS = 15_000;
  // The deadline covers fetching AND consuming the body. Clearing the timer once
  // headers arrive left a stalled body read hanging forever, pinning check() on
  // "Checking..." (2026-09-03 round-2 fix), so the consumer runs inside the
  // deadline and the timer is cleared only after the body is read.
  const fetchWithTimeout = async (url, init, consume) => {
    if (!fetchImpl) throw new Error('no fetch implementation');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  };

  const okOrThrow = (response) => {
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };

  const getJson = async (url, headers = {}) => fetchWithTimeout(
    url, { headers }, (response) => okOrThrow(response).json(),
  );

  const getText = async (url, headers = {}) => fetchWithTimeout(
    url, { headers }, (response) => okOrThrow(response).text(),
  );

  // npm global prefix. On win32 the answer is %APPDATA%\npm and asking npm
  // costs a process spawn for a constant, so the constant is used first and
  // `npm prefix -g` is only the fallback.
  const npmPrefix = async () => {
    if (env.HARBOR_NPM_PREFIX) return env.HARBOR_NPM_PREFIX;
    if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'npm');
    try {
      const { stdout } = await execFile('npm', ['prefix', '-g'], { windowsHide: true, timeout: 20_000 });
      return String(stdout).trim();
    } catch {
      return null;
    }
  };

  // Installed version WITHOUT running the CLI: the package.json the global
  // install left on disk. Spawning `claude --version` at boot costs seconds
  // and starts the very process Harbor is trying not to disturb.
  const installedNpm = async (pkg) => {
    const prefix = await npmPrefix();
    if (!prefix) return null;
    const file = path.join(prefix, 'node_modules', ...pkg.split('/'), 'package.json');
    try {
      return JSON.parse(await readFile(file, 'utf8'))?.version || null;
    } catch {
      return null;
    }
  };

  // Only an explicit install probes the executable. Package metadata can be
  // current while a failed native download leaves an unusable placeholder.
  // Follow this package's bin entry, never an older executable found on PATH.
  const verifyNpmExecutable = async (id, expected) => {
    try {
      const prefix = await npmPrefix();
      if (!prefix) throw new Error('npm prefix unavailable');
      const root = path.resolve(prefix, 'node_modules', ...PROVIDERS[id].pkg.split('/'));
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[id];
      if (!entry) throw new Error('package has no bin entry');
      const binary = path.resolve(root, entry);
      if (!binary.startsWith(root + path.sep)) throw new Error('bin entry is outside its package');
      const javascript = /\.[cm]?js$/i.test(binary);
      const result = await execFile(javascript ? process.execPath : binary,
        javascript ? [binary, '--version'] : ['--version'], {
          windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
          env: { ...env, ...(javascript ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        });
      const output = String(result?.stdout || '').trim();
      const match = id === 'claude'
        ? /^(\S+) \(Claude Code\)$/.exec(output)
        : /^codex-cli (\S+)$/.exec(output);
      if (match?.[1] !== expected) throw new Error(`version response did not identify ${id} ${expected}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `${id} executable verification failed: ${error.message}` };
    }
  };

  const CURSOR_VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

  const cursorRoot = () => env.HARBOR_CURSOR_AGENT_DIR
    || path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cursor-agent');

  // The cursor launcher picks the newest folder under versions/, so that IS the
  // installed version (see cursor-agent.ps1).
  const installedCursor = async () => {
    try {
      const entries = await readdir(path.join(cursorRoot(), 'versions'));
      const names = entries
        .map((entry) => (typeof entry === 'string' ? entry : entry.name))
        .filter((name) => CURSOR_VERSION_RE.test(name))
        .sort(compareVersions);
      return names.length ? names[names.length - 1] : null;
    } catch {
      return null;
    }
  };

  const readInstalled = (id) => PROVIDERS[id].source === 'npm'
    ? installedNpm(PROVIDERS[id].pkg) : installedCursor();

  const clearSettledNotes = (provider) => {
    if (!isNewer(provider.latest, provider.installed)) {
      provider.notes = null;
      provider.flags = [];
    } else if (provider.notes?.sections) {
      provider.notes = { ...provider.notes, sections: sectionsBetween(provider.notes.sections, provider.installed, provider.latest) };
      const matched = new Set();
      for (const section of provider.notes.sections) {
        for (const line of section.lines || []) {
          for (const flag of flagsFor(provider.id)) if (flag.re.test(line)) matched.add(flag.id);
        }
      }
      provider.flags = [...matched];
    }
  };

  const installedChanged = (id, installed, source = 'external') => {
    if (installed !== null) provisionalMissing.delete(id);
    const provider = state.providers[id];
    const from = provider.installed;
    if (from === installed) return;
    installedRevisions[id] += 1;
    provider.installed = installed;
    clearSettledNotes(provider);
    // An initial discovery or an unreadable installation is not an install.
    if (source === 'external' && from && installed) {
      provider.history = [{ from, to: installed, at: now().toISOString(), ok: true,
        source, snapshot: null }, ...provider.history].slice(0, 20);
    }
    for (const listener of installedListeners) {
      try { listener({ provider: id, from, installed, source }); }
      catch (error) { log(`cli-updates: installed listener failed: ${error.message}`); }
    }
  };

  let lastReconcile = -Infinity;
  let reconciling = null;
  const reconcileLocal = async (force = false) => {
    // Fixtures are complete simulated installations; never mix in real homes.
    if (fixtureFile || env.HARBOR_E2E === '1') return state;
    if (reconciling) return reconciling;
    if (!force && now().getTime() - lastReconcile < 30000) return state;
    reconciling = (async () => {
      const revisions = { ...installedRevisions };
      const versions = await Promise.all(PROVIDER_IDS.map((id) => installOwners.has(id) ? undefined : readInstalled(id)));
      let changed = false;
      for (let i = 0; i < PROVIDER_IDS.length; i += 1) {
        const id = PROVIDER_IDS[i];
        // 2026-09-20: a slow sibling read must not commit a sample taken before
        // an install. Its owner records the final disk version and attribution.
        if (versions[i] === undefined || installOwners.has(id) || revisions[id] !== installedRevisions[id]) continue;
        // 2026-09-20: npm briefly removes package.json while replacing a global
        // install. Preserve its version until a separate reconcile also misses
        // it; a successful read, even unchanged, breaks the missing-read streak.
        if (versions[i] === null && state.providers[id].installed) {
          if (!provisionalMissing.has(id)) {
            provisionalMissing.add(id);
            continue;
          }
        }
        provisionalMissing.delete(id);
        if (state.providers[id].installed !== versions[i]) {
          installedChanged(id, versions[i]);
          changed = true;
        }
      }
      lastReconcile = now().getTime();
      if (changed) { await persist(); emit(); }
      return state;
    })().finally(() => { reconciling = null; });
    return reconciling;
  };

  const reconcile = async ({ force = false } = {}) => {
    await load();
    return reconcileLocal(force);
  };

  const latestNpm = async (pkg) => {
    const body = await getJson(`${NPM_REGISTRY}/${pkg}/latest`);
    // A 200 with no usable version is a FAILED check, not "no update": throwing
    // lets checkProvider preserve the last-known latest instead of dropping it.
    if (!body?.version) throw new Error(`npm returned no version for ${pkg}`);
    return body.version;
  };

  const latestCursor = async () => {
    const body = await fetchWithTimeout(
      CURSOR_LATEST_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: JSON.stringify({ channel: 'prod' }),
      },
      (response) => okOrThrow(response).json(),
    );
    if (!body?.version) throw new Error('cursor endpoint returned no version');
    return body.version;
  };

  // Release notes are BEST EFFORT and never hide an update: a GitHub rate limit
  // (403/429) or an unreachable changelog answers "notes unavailable" while the
  // version comparison stands on its own.
  const fetchNotes = async (id, installed, latest) => {
    if (!installed || !latest || !isNewer(latest, installed)) return null;
    try {
      if (id === 'claude') {
        const markdown = await getText(CLAUDE_CHANGELOG_URL);
        const sections = sectionsBetween(parseClaudeChangelog(markdown), installed, latest);
        return { fetchedFor: latest, sections };
      }
      if (id === 'codex') {
        const releases = await getJson(CODEX_RELEASES_URL, { Accept: 'application/vnd.github+json' });
        const sections = sectionsBetween(parseCodexReleases(releases), installed, latest);
        return { fetchedFor: latest, sections };
      }
      return {
        fetchedFor: latest,
        sections: [],
        unavailable: 'Cursor publishes no machine-readable release notes for the agent CLI.',
      };
    } catch (error) {
      const rateLimited = error.status === 403 || error.status === 429;
      return {
        fetchedFor: latest,
        sections: [],
        unavailable: rateLimited
          ? 'Release notes are rate limited right now; the version difference above is still real.'
          : `Release notes could not be fetched: ${error.message}`,
      };
    }
  };

  const checkProvider = async (id) => {
    const previous = state.providers[id] || emptyProviderState(id);
    const provider = PROVIDERS[id];
    const next = { ...previous, id, label: provider.label, source: provider.source, error: null };
    try {
      next.installed = provider.source === 'npm'
        ? await installedNpm(provider.pkg)
        : await installedCursor();
    } catch (error) {
      next.installed = null;
      next.error = `installed version unreadable: ${error.message}`;
    }
    try {
      next.latest = provider.source === 'npm'
        ? await latestNpm(provider.pkg)
        : await latestCursor();
      next.latestStale = false;
    } catch (error) {
      // Keep the last KNOWN latest so an offline or rate-limited check does not
      // erase an update the user already saw and make the chip vanish; mark it
      // stale rather than dropping the signal (2026-09-03).
      next.latest = previous.latest || null;
      next.latestStale = Boolean(previous.latest);
      next.error = `latest version unknown: ${error.message}`;
    }
    next.checkedAt = now().toISOString();
    // Only refetch notes when the target version moved; the changelog for a
    // version already described has not changed.
    if (isNewer(next.latest, next.installed)) {
      if (previous.installed !== next.installed || previous.notes?.fetchedFor !== next.latest || !previous.notes?.sections?.length) {
        next.notes = await fetchNotes(id, next.installed, next.latest);
      }
    } else {
      next.notes = null;
    }
    const matched = new Set();
    for (const section of next.notes?.sections || []) {
      for (const line of section.lines) {
        for (const flag of flagsFor(id)) if (flag.re.test(line)) matched.add(flag.id);
      }
    }
    next.flags = [...matched];
    return next;
  };

  // Every provider is checked independently and one failure never sinks the
  // others; this is the model-catalog posture, per provider.
  const runCheck = async () => {
    await load();
    // Kill switch and E2E isolation are hard, on the on-demand IPC too, not just
    // at boot: a disabled checker must never reach the network, and under E2E the
    // only network-shaped path is a prepared fixture (2026-09-03).
    if (env.HARBOR_NO_UPDATE_CHECK === '1') return state;
    if (fixtureFile) {
      try {
        const parsed = JSON.parse(await readFile(fixtureFile, 'utf8'));
        const merged = emptyState();
        for (const id of PROVIDER_IDS) {
          merged.providers[id] = { ...merged.providers[id], ...(parsed?.providers?.[id] || {}), id };
        }
        merged.checkedAt = parsed?.checkedAt || now().toISOString();
        state = merged;
        await persist();
        emit();
        return state;
      } catch (error) {
        // Fail CLOSED: a bad fixture path must not silently become a real network
        // check (that is how an E2E run reaches the internet by accident).
        log(`cli-updates: fixture unreadable (${error.message}); not falling through to the network`);
        return state;
      }
    }
    if (env.HARBOR_E2E === '1') return state;
    const results = await Promise.all(PROVIDER_IDS.map(async (id) => {
      try {
        return await checkProvider(id);
      } catch (error) {
        log(`cli-updates: ${id} check failed: ${error.message}`);
        return { ...(state.providers[id] || emptyProviderState(id)), error: error.message, checkedAt: now().toISOString() };
      }
    }));
    // A network request can span an external install or a click. Re-read local
    // truth at commit time so its old installed snapshot can never win.
    await reconcileLocal(true);
    const providers = {};
    for (const result of results) {
      // Preserve any install history or dismissal that landed WHILE the check was
      // in flight: the fetched result carries only the version, notes and flags
      // fields, and replacing the whole provider would regress a concurrent
      // install() or dismiss() (2026-09-03 round-2 fix).
      const live = state.providers[result.id] || emptyProviderState(result.id);
      providers[result.id] = { ...result, installed: live.installed, history: live.history, dismissed: live.dismissed };
      clearSettledNotes(providers[result.id]);
    }
    state = { checkedAt: now().toISOString(), providers };
    await persist();
    emit();
    return state;
  };

  // Coalesce concurrent checks: the boot timer, the 6-hour interval and a manual
  // "Check now" can overlap, and running them at once wastes calls and lets a
  // slower one's earlier snapshot overwrite a newer result (2026-09-03).
  let inFlightCheck = null;
  const check = async () => {
    if (inFlightCheck) return inFlightCheck;
    inFlightCheck = runCheck().finally(() => { inFlightCheck = null; });
    return inFlightCheck;
  };

  const dismiss = async (id, version) => {
    await load();
    const provider = state.providers[id];
    if (!provider) return { ok: false, reason: `unknown provider: ${id}` };
    if (!version) return { ok: false, reason: 'no version to skip' };
    const dismissed = Array.isArray(provider.dismissed) ? provider.dismissed : [];
    if (!dismissed.includes(version)) provider.dismissed = [...dismissed, version];
    await persist();
    emit();
    return { ok: true, dismissed: provider.dismissed };
  };

  // ---- config snapshot / diff / restore -----------------------------------

  const snapshotConfig = async (id, { from, to } = {}) => {
    await load();
    if (!PROVIDERS[id]) return { ok: false, reason: `unknown provider: ${id}` };
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const label = `${stamp}-${from || 'unknown'}-to-${to || 'unknown'}`;
    const dir = path.join(snapshotRoot, id, label);
    // 0700/0600: a config file can hold OAuth material, so its copy must be no
    // more readable than the original. Windows ignores the POSIX bits (the
    // profile ACL already contains this), but the copy is correct if the code
    // ever runs on POSIX.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const files = [];
    for (const source of await configTargets(id, home, env, readdir)) {
      let content;
      try {
        content = await readFile(source, 'utf8');
      } catch (error) {
        // Only a genuinely ABSENT file is skipped. A permission or I/O failure
        // means we could NOT capture a config that exists, so it must fail the
        // whole snapshot (and abort the install), never pass as "no config yet"
        // and leave that file with no rollback point (2026-09-03 round-2 fix).
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
      const name = snapshotName(source);
      await writeFile(path.join(dir, name), content, { mode: 0o600 });
      files.push({ source, name });
    }
    await writeFile(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify({ provider: id, id: label, from: from || null, to: to || null, at: now().toISOString(), files }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { ok: true, id: label, dir, files: files.map((entry) => entry.source) };
  };

  const listSnapshots = async (id) => {
    try {
      const entries = await readdir(path.join(snapshotRoot, id));
      return entries
        .map((entry) => (typeof entry === 'string' ? entry : entry.name))
        .sort();
    } catch {
      return [];
    }
  };

  // Runnable AT ANY TIME, on purpose: a CLI usually rewrites its config on the
  // FIRST RUN after an update, not during the install, so "did this update
  // change my settings" is a question asked hours later.
  const configDiff = async (id, snapshotId) => {
    if (!PROVIDERS[id]) return { ok: false, reason: `unknown provider: ${id}` };
    const snapshots = await listSnapshots(id);
    const chosen = snapshotId || snapshots[snapshots.length - 1];
    if (!chosen) return { ok: false, reason: 'no config snapshot has been taken for this CLI yet' };
    // A snapshot id names a directory under snapshotRoot/<id>; a caller-supplied
    // id with ".." or a separator would escape the store, so it must be a plain
    // basename that is actually in the listing (2026-09-03).
    if (path.basename(chosen) !== chosen || !snapshots.includes(chosen)) {
      return { ok: false, reason: `unknown config snapshot: ${chosen}` };
    }
    const dir = path.join(snapshotRoot, id, chosen);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (error) {
      return { ok: false, reason: `snapshot manifest unreadable: ${error.message}` };
    }
    const files = [];
    for (const entry of manifest.files || []) {
      let before;
      let after;
      // A manifest is written by snapshotConfig, but a tampered one must not let
      // entry.name escape the snapshot dir with ".." (2026-09-03 round-2).
      if (path.basename(String(entry.name || '')) !== entry.name) {
        files.push({ source: entry.source, error: 'refused an out-of-bounds snapshot entry' });
        continue;
      }
      try {
        before = await readFile(path.join(dir, entry.name), 'utf8');
      } catch (error) {
        files.push({ source: entry.source, error: `snapshot copy unreadable: ${error.message}` });
        continue;
      }
      try {
        after = await readFile(entry.source, 'utf8');
      } catch {
        files.push({ source: entry.source, missing: true });
        continue;
      }
      const json = entry.source.endsWith('.json') ? diffJson(before, after) : null;
      files.push({ source: entry.source, diff: json || diffText(before, after) });
    }
    const changedCount = files.filter((file) => (
      file.missing
      || (file.diff?.kind === 'text' && file.diff.changed)
      || (file.diff?.kind === 'json' && (file.diff.added.length || file.diff.removed.length || file.diff.changed.length))
    )).length;
    return { ok: true, snapshotId: chosen, takenAt: manifest.at || null, from: manifest.from || null, to: manifest.to || null, files, changedCount };
  };

  // Explicit only. Nothing calls this on its own, and the UI confirms first.
  const restoreConfig = async (id, snapshotId) => {
    if (!PROVIDERS[id]) return { ok: false, reason: `unknown provider: ${id}` };
    const snapshots = await listSnapshots(id);
    const chosen = snapshotId || snapshots[snapshots.length - 1];
    if (!chosen) return { ok: false, reason: 'no config snapshot to restore' };
    if (path.basename(chosen) !== chosen || !snapshots.includes(chosen)) {
      return { ok: false, reason: `unknown config snapshot: ${chosen}` };
    }
    const dir = path.join(snapshotRoot, id, chosen);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (error) {
      return { ok: false, reason: `snapshot manifest unreadable: ${error.message}` };
    }
    const restored = [];
    const failed = [];
    const homeRoot = path.resolve(home) + path.sep;
    for (const entry of manifest.files || []) {
      // Restore WRITES to entry.source, so a tampered manifest is a write-anywhere
      // primitive unless both the snapshot copy name is a basename and the
      // destination stays inside the user home (2026-09-03 round-2).
      const dest = path.resolve(String(entry.source || ''));
      if (path.basename(String(entry.name || '')) !== entry.name || !dest.startsWith(homeRoot)) {
        failed.push({ source: entry.source, reason: 'refused an out-of-bounds snapshot entry' });
        continue;
      }
      try {
        const content = await readFile(path.join(dir, entry.name), 'utf8');
        // 0600 so a restored credential-bearing file (a deleted .claude.json
        // recreated here) is never world-readable on POSIX (2026-09-03).
        await writeFile(entry.source, content, { mode: 0o600 });
        restored.push(entry.source);
      } catch (error) {
        failed.push({ source: entry.source, reason: error.message });
      }
    }
    return { ok: failed.length === 0, snapshotId: chosen, restored, failed };
  };

  // ---- install ------------------------------------------------------------

  // The argv for a manual install. Exposed so the UI can SHOW the command it is
  // about to run, and so the test can assert on it without spawning anything.
  const installCommand = (id, version) => {
    const provider = PROVIDERS[id];
    if (!provider) return null;
    if (provider.source === 'npm') {
      const spec = `${provider.pkg}@${version}`;
      // execFile cannot launch npm.cmd directly on win32 (Node refuses .cmd
      // without a shell), and shell:true would put a remote version string
      // through a command line. cmd.exe /c with an argv array is neither.
      return process.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/c', 'npm', 'install', '-g', spec] }
        : { file: 'npm', args: ['install', '-g', spec] };
    }
    // Cursor is not on npm; its own `update` subcommand IS its installer.
    const launcher = path.join(cursorRoot(), process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
    return cliCommand(launcher, ['update']);
  };

  // Never called by a timer, a boot path, or a check. Only ever by an explicit
  // click, which is the whole point of this feature.
  const runInstall = async (id, version) => {
    await load();
    const provider = PROVIDERS[id];
    if (!provider) return { ok: false, reason: `unknown provider: ${id}` };
    const target = version || state.providers[id]?.latest;
    if (!target) return { ok: false, reason: 'no target version' };
    if (!SAFE_VERSION_RE.test(target)) return { ok: false, reason: `refusing an unsafe version string: ${target}` };
    // Ignore the throttle at a click: the watcher may have installed seconds ago.
    await reconcileLocal(true);
    const observedFrom = await readInstalled(id);
    const from = observedFrom || state.providers[id].installed || null;
    const changedBeforeClick = observedFrom !== null && state.providers[id].installed !== observedFrom;
    if (observedFrom !== null) installedChanged(id, observedFrom);
    if (changedBeforeClick) { await persist(); emit(); }
    if (observedFrom === target) {
      const verified = provider.source === 'npm' ? await verifyNpmExecutable(id, target) : { ok: true };
      if (verified.ok) {
        await persist();
        emit();
        return { ok: true, alreadyInstalled: true, installed: from, target, output: 'Already installed' };
      }
      // A retry repairs a partial install instead of trusting the same metadata.
    }

    const snapshot = await snapshotConfig(id, { from, to: target }).catch((error) => (
      { ok: false, reason: error.message }
    ));
    // No rollback point, no install. The entire reason this feature exists is so
    // an update that rewrites a config can be undone; installing without a good
    // snapshot would remove exactly that safety (2026-09-03). A snapshot of a CLI
    // that has no config yet still succeeds with zero files, so this only stops a
    // genuine snapshot failure.
    if (!snapshot?.ok) {
      return {
        ok: false,
        target,
        reason: `config snapshot failed, so the install was not run (no rollback point): ${snapshot?.reason || 'unknown'}`,
      };
    }

    const command = installCommand(id, target);
    let output = '';
    let ok = false;
    let error = null;
    try {
      const result = await execFile(command.file, command.args, {
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
      output = `${result?.stdout || ''}${result?.stderr || ''}`;
      ok = true;
    } catch (spawnError) {
      output = `${spawnError?.stdout || ''}${spawnError?.stderr || ''}`;
      error = spawnError?.message || String(spawnError);
    }

    let installed = null;
    try {
      installed = provider.source === 'npm' ? await installedNpm(provider.pkg) : await installedCursor();
    } catch { /* the re-read is best effort; the history entry still lands */ }
    // The install "worked" when the version on disk actually moved to the target.
    // npm can exit 0 and leave the old tree (a shim, a permission fault), and
    // cursor's own updater can install a version OTHER than the one reviewed; the
    // disk is the honest answer for every provider (2026-09-03). compareVersions
    // treats two same-day cursor builds as equal, so a rebuild is never a false
    // failure. An updater that exited 0 but whose on-disk version cannot even be
    // READ is a failure too, not a silent success on the stale cached version.
    if (ok && !installed) {
      ok = false;
      error = error || 'the updater exited cleanly but the installed version could not be read from disk';
    } else if (ok && installed && compareVersions(installed, target) !== 0) {
      ok = false;
      error = error || `the updater exited cleanly but ${installed} is installed, not ${target}`;
    }
    if (ok && provider.source === 'npm') {
      const verified = await verifyNpmExecutable(id, target);
      ok = verified.ok;
      if (!ok) error = verified.error;
    }

    // A successful entry names the build actually on disk. cursor-agent update
    // always takes Cursor's newest build, so a same-day rebuild published after
    // the review lands instead of the reviewed one (2026-10-01: 14929f9 reviewed,
    // e373342 installed); the entry keeps the request beside it, never in place of it.
    const entry = {
      from, to: ok && installed ? installed : target, at: now().toISOString(), ok, source: 'harbor', error: error || null, snapshot: snapshot?.id || null,
      ...(ok && installed && installed !== target ? { requested: target } : {}),
    };
    installedChanged(id, installed, 'harbor');
    const current = state.providers[id] || emptyProviderState(id);
    state.providers[id] = {
      ...current,
      installed,
      history: [entry, ...(current.history || [])].slice(0, 20),
      error: ok ? null : (error || current.error),
    };
    await persist();
    emit();

    const tail = String(output).split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
    return {
      ok,
      installed: state.providers[id].installed,
      target,
      error: error || null,
      snapshotId: snapshot?.id || null,
      output: tail,
      command: `${command.file} ${command.args.join(' ')}`,
    };
  };

  const install = async (id, version) => {
    await load();
    if (installOwners.has(id)) return { ok: false, reason: 'an install is already in progress for this provider' };
    installOwners.add(id);
    // Invalidate any local read sampled before this install acquired ownership.
    installedRevisions[id] = (installedRevisions[id] || 0) + 1;
    try { return await runInstall(id, version); }
    finally { installOwners.delete(id); }
  };

  // The note lines this update would cross, each already tagged with the Harbor
  // contracts it touches.
  const releaseNotes = async (id) => {
    await load();
    const provider = state.providers[id];
    if (!provider) return { ok: false, reason: `unknown provider: ${id}` };
    const sections = (provider.notes?.sections || []).map((section) => ({
      version: section.version,
      lines: section.lines.map((line) => tagLine(id, line)),
    }));
    const verify = [];
    for (const section of sections) {
      for (const line of section.lines) {
        for (const flag of line.flags) if (!verify.some((v) => v.id === flag.id)) verify.push(flag);
      }
    }
    return {
      ok: true,
      provider: id,
      installed: provider.installed,
      latest: provider.latest,
      unavailable: provider.notes?.unavailable || null,
      sections,
      verify,
    };
  };

  return {
    check,
    reconcile,
    state: async () => {
      await load();
      await reconcileLocal();
      return state;
    },
    dismiss,
    install,
    installCommand,
    releaseNotes,
    snapshotConfig,
    listSnapshots,
    configDiff,
    restoreConfig,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    onInstalledChanged: (listener) => { installedListeners.add(listener); return () => installedListeners.delete(listener); },
    stateFile,
    snapshotRoot,
  };
}

// Which providers have an update the user has not skipped. The chip's count.
function pendingUpdates(state) {
  const providers = state?.providers || {};
  return PROVIDER_IDS
    .map((id) => providers[id])
    .filter((provider) => (
      provider
      && isNewer(provider.latest, provider.installed)
      && !(provider.dismissed || []).includes(provider.latest)
    ));
}

module.exports = {
  createCliUpdateChecker,
  compareVersions,
  isNewer,
  parseClaudeChangelog,
  parseCodexReleases,
  sectionsBetween,
  tagLine,
  flagsFor,
  configTargets,
  diffJson,
  diffText,
  pendingUpdates,
  PROVIDER_IDS,
  PROVIDERS,
  IMPACT_FLAGS,
  REVERTED_FLAG,
};
