#!/usr/bin/env python3
"""harbor-index.py: index Claude Code session transcripts for the session picker.

Part of Harbor (see the repository README).

Scans the configured Claude projects directory for */<uuid>.jsonl (main-session transcripts
only; subagent transcripts live in subdirectories and are excluded), extracts
per-session metadata, and caches it so repeat runs only re-read changed files.

Subcommands:
  emit    [--since X] [--project P] [--all] [--rebuild]   TSV rows for fzf
  preview <session-id>                                    human preview panel
  meta    <session-id>                                    JSON metadata for one session

Row format (tab-separated): id, local timestamp, project label, title.
The picker displays fields 2-4 and keeps field 1 (the id) hidden.
"""

import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import PureWindowsPath

HOME = os.path.abspath(os.path.expanduser("~"))


def load_harbor_config():
    filename = os.environ.get("HARBOR_CONFIG_FILE")
    if not filename:
        return {}
    try:
        with open(filename, encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


CONFIG = load_harbor_config()
PATH_CONFIG = CONFIG.get("paths") if isinstance(CONFIG.get("paths"), dict) else {}
PROJECTS_DIR = PATH_CONFIG.get("projectsDir") or os.path.join(HOME, ".claude", "projects")
CACHE_DIR = PATH_CONFIG.get("cacheDir") or os.path.join(HOME, ".cache", "harbor")
CACHE_FILE = os.path.join(CACHE_DIR, "index.json")
CACHE_VERSION = 2  # v2: entries carry "command"; settings commands lose the title fallback

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$"
)

# Prompts that start with these are UI/system noise, not something Pat typed.
NOISE_PREFIXES = (
    "<command-name>",
    "<command-message>",
    "<local-command-stdout",
    "<system-reminder",
    "<task-notification",
    "[SYSTEM NOTIFICATION",
    "Caveat: The messages below",
    "[Request interrupted",
)

HEAD_LINE_CAP = 400        # stop head scan after this many lines
HEAD_BYTE_CAP = 2_000_000  # or this many bytes, whichever first
TAIL_BYTES = 65_536

# Pure settings commands say nothing about what a session IS. Every P/T/S
# preset launch opens with "/effort xhigh", so a settings command only holds
# the title fallback until any other command appears (live-caught 2026-07-24:
# a gold-sweep session sat in the rail titled "/effort" while the real
# identity, /dml-gold-sweep, was two lines below it in the transcript head).
SETTINGS_COMMANDS = frozenset((
    "/effort", "/model", "/fast", "/config", "/permissions", "/theme",
    "/statusline", "/compact", "/clear", "/resume",
))

PROJECT_LABEL_WIDTH = 26
TITLE_MAX = 110


def parse_ts(s):
    """ISO-8601 (usually ...Z) to aware local datetime, or None."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def clean_text(text, limit):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def extract_user_text(obj):
    """Return the human-typed text of a user record, or None if it's noise."""
    if obj.get("type") != "user" or obj.get("isSidechain") or obj.get("isMeta"):
        return None
    message = obj.get("message") or {}
    content = message.get("content")
    text = None
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                break
    if not text or not text.strip():
        return None
    if text.lstrip().startswith(NOISE_PREFIXES):
        return None
    return text


def project_label(cwd):
    if not cwd:
        return "(unknown)"
    if "\\" in cwd or re.match(r"^[A-Za-z]:", cwd):
        winpath = PureWindowsPath(cwd)
        parts = [p for p in winpath.parts if p != winpath.anchor]
        return "win: " + "/".join(parts[-2:]) if parts else "win: ?"
    if cwd == HOME:
        return "~"
    dev = os.path.join(HOME, "dev")
    if cwd == dev:
        return "dev"
    if cwd.startswith(dev + os.sep):
        return os.path.relpath(cwd, dev)
    if cwd.startswith(HOME + os.sep):
        rel = os.path.relpath(cwd, HOME)
        parts = rel.split(os.sep)
        return os.sep.join(parts[-2:]) if len(parts) > 1 else rel
    parts = cwd.split(os.sep)
    return os.sep.join(parts[-2:])


def parse_transcript(path):
    """Head+tail scan of one transcript. Returns a cache entry dict."""
    cwd = None
    start_ts = None
    summary = None
    first_prompt = None
    command_name = None  # fallback title for slash-command-only sessions

    bytes_read = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for lineno, line in enumerate(f):
            # Cap checks come AFTER parsing so an oversized line (huge paste in
            # the opening prompt) still contributes before the scan stops.
            if lineno >= HEAD_LINE_CAP or bytes_read > HEAD_BYTE_CAP:
                break
            bytes_read += len(line)
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cwd is None and obj.get("cwd"):
                cwd = obj["cwd"]
            if start_ts is None and obj.get("timestamp"):
                start_ts = obj["timestamp"]
            if summary is None and obj.get("type") == "summary" and obj.get("summary"):
                summary = obj["summary"]
            if first_prompt is None:
                text = extract_user_text(obj)
                if text:
                    first_prompt = text
            if (
                obj.get("type") == "user"
                and (command_name is None
                     or command_name.split()[0] in SETTINGS_COMMANDS)
            ):
                message = obj.get("message") or {}
                content = message.get("content")
                if isinstance(content, str):
                    raw = content
                elif isinstance(content, list):
                    raw = " ".join(
                        item.get("text", "")
                        for item in content
                        if isinstance(item, dict) and item.get("type") == "text"
                    )
                else:
                    raw = ""
                m = re.search(r"<command-name>(/[^<]+)</command-name>", raw)
                if m:
                    cand = m.group(1).strip()
                    args = re.search(r"<command-args>([^<]*)</command-args>", raw)
                    if args and args.group(1).strip():
                        cand = f"{cand} {args.group(1).strip()}"
                    # A settings command holds the fallback only until any
                    # other command shows up; never the reverse.
                    if (
                        command_name is None
                        or cand.split()[0] not in SETTINGS_COMMANDS
                    ):
                        command_name = cand
            if cwd and start_ts and first_prompt:
                break

    # Tail scan: last activity timestamp, late summaries, recent prompts.
    # If the final line alone exceeds the window (giant tool result), the
    # first pass sees nothing; retry once with a much larger window.
    last_ts = None
    recent_prompts = []
    size = os.path.getsize(path)
    for window in (TAIL_BYTES, 1_048_576):
        with open(path, "rb") as f:
            if size > window:
                f.seek(size - window)
                f.readline()  # discard the partial line at the seek point
            tail_lines = f.read().decode("utf-8", errors="replace").splitlines()
        for line in reversed(tail_lines):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if last_ts is None and obj.get("timestamp"):
                last_ts = obj["timestamp"]
            if summary is None and obj.get("type") == "summary" and obj.get("summary"):
                summary = obj["summary"]
            if len(recent_prompts) < 3:
                text = extract_user_text(obj)
                if text:
                    recent_prompts.append(clean_text(text, 240))
            if last_ts and summary and len(recent_prompts) >= 3:
                break
        if last_ts or size <= window:
            break
    recent_prompts.reverse()

    title = summary or first_prompt or command_name
    return {
        "cwd": cwd,
        "start": start_ts,
        "last": last_ts,
        "title": clean_text(title, TITLE_MAX) if title else None,
        "first_prompt": clean_text(first_prompt, 1200) if first_prompt else None,
        "command": clean_text(command_name, TITLE_MAX) if command_name else None,
        "recent": recent_prompts,
    }


TITLES_FILE = os.environ.get(
    "HARBOR_TITLES_FILE", os.path.join(CACHE_DIR, "session-titles.json")
)


def load_generated_titles():
    try:
        with open(TITLES_FILE, encoding="utf-8") as f:
            data = json.load(f)
        titles = data.get("titles") if isinstance(data, dict) else None
        return titles if isinstance(titles, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def apply_generated_titles(files):
    """Overlay Haiku-generated titles (harbor-titles.py) in memory only; the
    saved cache keeps raw parsed titles so deleting the sidecar reverts.
    BATCH TITLE prompts are never renamed: that prefix is how orchestration
    workers are detected across the app."""
    titles = load_generated_titles()
    if not titles:
        return files
    for entry in files.values():
        generated = titles.get(entry.get("id"))
        if not generated:
            continue
        raw = entry.get("title") or ""
        if raw.lstrip().startswith("BATCH TITLE:"):
            continue
        entry["title"] = clean_text(str(generated), TITLE_MAX)
    return files


def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("v") == CACHE_VERSION:
            return data["files"]
    except (OSError, json.JSONDecodeError, KeyError):
        pass
    return {}


def save_cache(files):
    os.makedirs(CACHE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=CACHE_DIR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"v": CACHE_VERSION, "files": files}, f)
    os.replace(tmp, CACHE_FILE)


def discover():
    """Yield (session_id, path, mtime, size) for every main-session transcript."""
    try:
        project_dirs = os.listdir(PROJECTS_DIR)
    except OSError:
        return
    for d in project_dirs:
        dpath = os.path.join(PROJECTS_DIR, d)
        if not os.path.isdir(dpath):
            continue
        try:
            names = os.listdir(dpath)
        except OSError:
            continue
        for name in names:
            if not UUID_RE.match(name):
                continue
            fpath = os.path.join(dpath, name)
            try:
                st = os.stat(fpath)
            except OSError:
                continue
            yield name[:-6], fpath, st.st_mtime, st.st_size


def refresh_index(rebuild=False):
    cache = {} if rebuild else load_cache()
    fresh = {}
    to_parse = []
    for sid, path, mt, sz in discover():
        cached = cache.get(path)
        if cached and cached.get("mt") == mt and cached.get("sz") == sz:
            fresh[path] = cached
        else:
            to_parse.append((sid, path, mt, sz))

    if len(to_parse) > 200:
        print(
            f"indexing {len(to_parse)} sessions (first run takes a minute)...",
            file=sys.stderr,
        )
    errors = 0
    for n, (sid, path, mt, sz) in enumerate(to_parse, 1):
        try:
            entry = parse_transcript(path)
        except OSError:
            errors += 1
            continue
        entry.update({"id": sid, "mt": mt, "sz": sz})
        fresh[path] = entry
        if len(to_parse) > 200 and n % 300 == 0:
            print(f"  {n}/{len(to_parse)}", file=sys.stderr)

    if errors:
        print(f"warning: {errors} transcript(s) unreadable, skipped", file=sys.stderr)
    if (to_parse or len(fresh) != len(cache)) and os.environ.get("HARBOR_INDEX_READ_ONLY") != "1":
        save_cache(fresh)
    return apply_generated_titles(fresh)


def entry_last_dt(path, entry):
    return parse_ts(entry.get("last")) or datetime.fromtimestamp(
        entry["mt"]
    ).astimezone()


def parse_since(spec):
    """'today', '7d', '36h', '2w', or 'YYYY-MM-DD' to a local cutoff datetime."""
    now = datetime.now().astimezone()
    if spec == "today":
        # The display day rolls at 06:00 (Pat works past midnight; the GUI
        # uses the same rule, see app/src/shared/date-roll.cjs).
        start = now.replace(hour=6, minute=0, second=0, microsecond=0)
        if now < start:
            start -= timedelta(days=1)
        return start
    m = re.fullmatch(r"(\d+)([dhw])", spec)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return now - timedelta(**{{"d": "days", "h": "hours", "w": "weeks"}[unit]: n})
    dt = parse_ts(spec + "T00:00:00")
    if dt:
        return dt
    sys.exit(f"harbor-index: bad --since value: {spec!r} (use today, 7d, 36h, 2w, or YYYY-MM-DD)")


def cmd_emit(args):
    def flag_value(flag):
        i = args.index(flag)
        if i + 1 >= len(args) or args[i + 1].startswith("--"):
            sys.exit(f"harbor-index: {flag} requires a value")
        return args[i + 1]

    index = refresh_index(rebuild="--rebuild" in args)
    since = parse_since(flag_value("--since")) if "--since" in args else None
    project_filter = flag_value("--project").lower() if "--project" in args else None
    show_all = "--all" in args

    # The Windows->Linux migration copied some transcripts into two encoded
    # project dirs, so the same session id can exist at two paths. Keep only
    # the most recently touched copy of each id.
    best = {}
    for path, entry in index.items():
        sid = entry["id"]
        if sid not in best or entry["mt"] > best[sid][1]["mt"]:
            best[sid] = (path, entry)

    rows = []
    skipped_untitled = 0
    for path, entry in best.values():
        label = project_label(entry.get("cwd"))
        if project_filter and project_filter not in label.lower() and project_filter not in (entry.get("cwd") or "").lower():
            continue
        last_dt = entry_last_dt(path, entry)
        if since and last_dt < since:
            continue
        # Count hidden-empty only among rows that pass the active filters, so
        # the note reflects what --all would actually add to THIS view.
        title = entry.get("title")
        if not title:
            if not show_all:
                skipped_untitled += 1
                continue
            title = "(no user messages)"
        rows.append((last_dt, entry["id"], label, title, entry.get("first_prompt"), entry.get("cwd")))

    rows.sort(key=lambda r: r[0], reverse=True)
    # Opt-in 5th column for GUI search (D2: first-prompt search is load-bearing
    # for the home-dir project). The 4-column shape stays the contract for hist.
    with_first_prompt = "--with-first-prompt" in args
    # Opt-in trailing cwd column (GUI project-folder anchor). Like the first
    # prompt, never part of the default 4-column hist/fzf contract.
    with_cwd = "--with-cwd" in args
    out = []
    for last_dt, sid, label, title, first_prompt, cwd in rows:
        # GUI consumers (--with-first-prompt) need the FULL label: truncation
        # splits a project's identity between sidebar and herdr workspaces and
        # defeated the execute mutex for 21 real projects (round-2 finding).
        if with_first_prompt:
            label_padded = label
        else:
            label_padded = label[:PROJECT_LABEL_WIDTH].ljust(PROJECT_LABEL_WIDTH)
        line = f"{sid}\t{last_dt.strftime('%Y-%m-%d %H:%M')}\t{label_padded}\t{title}"
        if with_first_prompt:
            fp = (first_prompt or "").replace("\t", " ").replace("\n", " ")[:300]
            line += f"\t{fp}"
        if with_cwd:
            line += "\t" + (cwd or "").replace("\t", " ").replace("\n", " ")
        out.append(line)
    sys.stdout.write("\n".join(out) + ("\n" if out else ""))
    if skipped_untitled and not show_all:
        plural = "" if skipped_untitled == 1 else "s"
        print(
            f"note: {skipped_untitled} empty session{plural} hidden (no user messages; --all shows them)",
            file=sys.stderr,
        )


UUID_BARE_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


def build_home_map():
    """session id -> 'personal' | 'team' | 'plan3', detected from per-home artifacts.

    history.jsonl rows (typed prompts, weight 2 each) outvote session-env /
    file-history entries (weight 1; those also appear from idle cross-home
    resumes). A session is assigned to the single highest-scoring home; ties
    (no unique winner) and unknown ids are omitted, and callers fall back to the
    team default. Costs ~30 ms, so it is computed fresh on demand.
    """
    configured = CONFIG.get("profiles") if isinstance(CONFIG.get("profiles"), list) else []
    if configured:
        valid_profiles = [
            profile for profile in configured
            if isinstance(profile, dict) and profile.get("configHome") and profile.get("id")
        ]
        homes = tuple(
            (idx, profile["configHome"], profile["id"])
            for idx, profile in enumerate(valid_profiles)
        )
    else:
        homes = (
            (0, os.path.join(HOME, ".claude"), "personal"),
            (1, os.path.join(HOME, ".claude-team"), "team"),
            (2, os.path.join(HOME, ".claude-plan3"), "plan3"),
        )
    width = len(homes)
    scores = {}
    for idx, root, _label in homes:
        try:
            with open(os.path.join(root, "history.jsonl"), encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        sid = json.loads(line).get("sessionId")
                    except (json.JSONDecodeError, AttributeError):
                        continue
                    if sid:
                        scores.setdefault(sid, [0] * width)[idx] += 2
        except OSError:
            pass
        for d in ("session-env", "file-history"):
            try:
                for name in os.listdir(os.path.join(root, d)):
                    if UUID_BARE_RE.match(name):
                        scores.setdefault(name[:36], [0] * width)[idx] += 1
            except OSError:
                pass
    result = {}
    for sid, s in scores.items():
        top = max(s)
        if top > 0 and s.count(top) == 1:
            result[sid] = homes[s.index(top)][2]
    return result


def cmd_tree(args):
    """Emit a desktop-app-style tree: projects with carets, sessions nested.

    Row format (tab-separated, field 1 hidden by the picker):
      F:-           + new session in any folder...
      P:<label>     caret + project name + session count + last-active
      N:<cwd>       + new session here            (only under expanded projects)
      S:<id>        nested session row            (only under expanded projects)
    Expanded projects arrive newline-separated in $HIST_EXPANDED.
    """
    index = refresh_index()
    show_all = "--all" in args
    expanded = set(filter(None, os.environ.get("HIST_EXPANDED", "").split("\n")))

    best = {}
    for path, entry in index.items():
        sid = entry["id"]
        if sid not in best or entry["mt"] > best[sid][1]["mt"]:
            best[sid] = (path, entry)

    groups = {}
    for path, entry in best.values():
        title = entry.get("title")
        if not title and not show_all:
            continue
        label = project_label(entry.get("cwd"))
        last_dt = entry_last_dt(path, entry)
        groups.setdefault(label, []).append(
            (last_dt, entry["id"], title or "(no user messages)", entry.get("cwd"))
        )

    out = []
    for label, sessions in sorted(
        groups.items(), key=lambda kv: max(s[0] for s in kv[1]), reverse=True
    ):
        sessions.sort(key=lambda s: s[0], reverse=True)
        newest = sessions[0][0]
        caret = "▾" if label in expanded else "▸"
        n = len(sessions)
        out.append(
            f"P:{label}\t{caret} {label.ljust(28)} {n:>4} session{'s' if n != 1 else ''}   last {newest.strftime('%Y-%m-%d %H:%M')}"
        )
        if label in expanded:
            cwd = sessions[0][3]
            if cwd and "\\" not in cwd:
                out.append(f"N:{cwd}\t      +  new session here")
            shown = sessions[:12]
            for last_dt, sid, title, _ in shown:
                out.append(
                    f"S:{sid}\t      └ {last_dt.strftime('%Y-%m-%d %H:%M')}  {title}"
                )
            hidden = len(sessions) - len(shown)
            if hidden > 0:
                out.append(
                    f"M:{label}\t      … {hidden} more session{'s' if hidden != 1 else ''} (enter: full list)"
                )
    out.append("F:-\t+  new session in any folder...")
    sys.stdout.write("\n".join(out) + "\n")


def cmd_hydrate(args):
    """Emit the data the harbor hydrator needs to mirror the desktop app:
    recent projects and their newest sessions, one TSV row each:
        label <TAB> cwd <TAB> session_id <TAB> home <TAB> tab_label
    Defaults: projects active in the last 14 days, newest 6 sessions each.
    """
    days = 7
    per = 6
    max_projects = 9
    if "--days" in args:
        days = int(args[args.index("--days") + 1])
    if "--per" in args:
        per = int(args[args.index("--per") + 1])
    if "--max-projects" in args:
        max_projects = int(args[args.index("--max-projects") + 1])
    cutoff = datetime.now().astimezone() - timedelta(days=days)

    index = refresh_index()
    homes = build_home_map()
    best = {}
    for path, entry in index.items():
        sid = entry["id"]
        if sid not in best or entry["mt"] > best[sid][1]["mt"]:
            best[sid] = (path, entry)

    groups = {}
    for path, entry in best.values():
        cwd = entry.get("cwd")
        title = entry.get("title")
        if not title or not cwd or "\\" in cwd or not os.path.isdir(cwd):
            continue
        last_dt = entry_last_dt(path, entry)
        groups.setdefault(project_label(cwd), []).append(
            (last_dt, entry["id"], title, cwd)
        )

    out = []
    ordered = sorted(groups.items(), key=lambda kv: max(s[0] for s in kv[1]), reverse=True)
    kept = [(l, s) for l, s in ordered if max(x[0] for x in s) >= cutoff][:max_projects]
    for label, sessions in kept:
        sessions.sort(key=lambda s: s[0], reverse=True)
        for last_dt, sid, title, cwd in sessions[:per]:
            tab = re.sub(r"\s+", " ", title)[:24]
            if " " in tab and len(title) > 24:
                tab = tab.rsplit(" ", 1)[0]
            out.append(
                f"{label}\t{cwd}\t{sid}\t{homes.get(sid, 'team')}\t{tab}"
            )
    sys.stdout.write("\n".join(out) + ("\n" if out else ""))


def cmd_preview_tree(field1):
    kind, _, rest = field1.partition(":")
    if kind == "S":
        cmd_preview(rest)
    elif kind == "P":
        index = apply_generated_titles(load_cache()) or refresh_index()
        best = {}
        for path, entry in index.items():
            sid = entry["id"]
            if sid not in best or entry["mt"] > best[sid][1]["mt"]:
                best[sid] = (path, entry)
        rows = [
            (entry_last_dt(p, e), e.get("title"), e.get("cwd"))
            for p, e in best.values()
            if project_label(e.get("cwd")) == rest and e.get("title")
        ]
        rows.sort(reverse=True, key=lambda r: r[0])
        print(rest)
        print("─" * 40)
        if rows:
            print(f"directory    {rows[0][2] or '(unknown)'}")
        print(f"sessions     {len(rows)}")
        print()
        print("recent:")
        for dt, title, _ in rows[:8]:
            print(f"  {dt.strftime('%m-%d %H:%M')}  {clean_text(title, 60)}")
        print()
        print("enter: expand/collapse")
    elif kind == "N":
        print(f"start a NEW Claude session in\n{rest}\n\n(enter to launch)")
    elif kind == "M":
        print(f"show every {rest} session in the full searchable list")
    else:
        print("pick any folder, then a new Claude session starts there")


def find_entry(index, sid):
    matches = [(p, e) for p, e in index.items() if e.get("id") == sid]
    if not matches:
        return None, None
    return max(matches, key=lambda pe: pe[1]["mt"])


def cmd_meta(sid):
    index = apply_generated_titles(load_cache()) or refresh_index()
    path, entry = find_entry(index, sid)
    if not entry:
        index = refresh_index()
        path, entry = find_entry(index, sid)
    if not entry:
        sys.exit(f"harbor-index: session {sid} not found")
    print(
        json.dumps(
            {
                "id": sid,
                "cwd": entry.get("cwd"),
                "project": project_label(entry.get("cwd")),
                "title": entry.get("title"),
                "path": path,
                "home": build_home_map().get(sid),
            }
        )
    )


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n / 1:.1f} {unit}"
        n /= 1024


def cmd_preview(sid):
    index = apply_generated_titles(load_cache()) or refresh_index()
    path, entry = find_entry(index, sid)
    if not entry:
        print(f"session {sid} not in index yet (press ctrl-r to reload)")
        return
    start = parse_ts(entry.get("start"))
    last = entry_last_dt(path, entry)
    print(entry.get("title") or "(no title)")
    print("─" * 40)
    print(f"project      {project_label(entry.get('cwd'))}")
    print(f"directory    {entry.get('cwd') or '(unknown)'}")
    if start:
        print(f"started      {start.strftime('%a %Y-%m-%d %H:%M')}")
    print(f"last active  {last.strftime('%a %Y-%m-%d %H:%M')}")
    print(f"size         {human_size(entry.get('sz', 0))}")
    print(f"session id   {sid}")
    if entry.get("first_prompt"):
        print()
        print("first prompt:")
        print(f"  {entry['first_prompt']}")
    if entry.get("recent"):
        print()
        print("recent prompts:")
        for p in entry["recent"]:
            print(f"  • {p}")


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__.strip())
    cmd, rest = args[0], args[1:]
    if cmd == "emit":
        cmd_emit(rest)
    elif cmd == "tree":
        cmd_tree(rest)
    elif cmd == "hydrate":
        cmd_hydrate(rest)
    elif cmd == "meta" and rest:
        cmd_meta(rest[0])
    elif cmd == "preview" and rest:
        cmd_preview(rest[0])
    elif cmd == "preview-tree" and rest:
        cmd_preview_tree(rest[0])
    else:
        sys.exit(__doc__.strip())


if __name__ == "__main__":
    main()
