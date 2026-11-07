#!/usr/bin/env bash
# Build Harbor from this checkout and install it as /Applications/Harbor.app,
# with its Dock icon, ready to open from Finder or Spotlight.
#
#   setup/macos/install.sh            build + install + open
#   setup/macos/install.sh --no-open  build + install only
#
# `npm start` runs Harbor from a terminal with the stock Electron icon and no
# app in /Applications. This script builds an unpacked app for the host CPU
# only (so the packed node-pty prebuild always matches the architecture it
# runs on; see docs/PACKAGING.md) through the same `npm run pack` path the
# release workflow uses, so build.mac.extraResources and scripts/after-pack.js
# apply unchanged.
#
# Safe to re-run after `git pull`: a previous /Applications/Harbor.app is moved
# to the Trash, never deleted, and a running session daemon is handed over to
# the new build (its sessions survive) instead of being killed.
set -euo pipefail

OPEN_AFTER=1
[ "${1:-}" = "--no-open" ] && OPEN_AFTER=0

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$REPO/app"
DEST="/Applications/Harbor.app"
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS"

# Prerequisites ---------------------------------------------------------------
command -v git >/dev/null || die "git is missing (install Xcode Command Line Tools: xcode-select --install)"
xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools are missing: run xcode-select --install, then re-run"
command -v node >/dev/null || die "Node.js is missing: install Node from nodejs.org or Homebrew"
command -v npm >/dev/null || die "npm is missing: it ships with Node.js"
# The minimum comes from app/package.json "engines", so this check cannot drift
# from the version the project actually requires.
NODE_CHECK="$(node -e '
  const want = String(require(process.argv[1]).engines.node || "").replace(/^>=\s*/, "");
  const num = (v) => v.split(".").map((n) => Number(n) || 0);
  const [a, b] = [num(process.versions.node), num(want)];
  let ok = true;
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) { ok = (a[i] || 0) > (b[i] || 0); break; } }
  console.log(`${ok ? 1 : 0} ${want}`);
' "$APP_DIR/package.json")"
[ "${NODE_CHECK%% *}" = 1 ] || die "Node $(node -v) is too old; Harbor needs ${NODE_CHECK#* } or newer"
command -v claude >/dev/null || printf 'note: the claude CLI is not on PATH; Harbor can still open, but Claude sessions need it\n'

case "$(uname -m)" in
  arm64) ARCH_FLAG=--arm64; OUT="$APP_DIR/release/mac-arm64/Harbor.app" ;;
  x86_64) ARCH_FLAG=--x64; OUT="$APP_DIR/release/mac/Harbor.app" ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

# Build -----------------------------------------------------------------------
# npm ci: the lockfile is committed, so install exactly it. Its postinstall
# packs the session daemon's own dependencies (scripts/pack-daemon-deps.js).
say "Installing dependencies"
(cd "$APP_DIR" && npm ci --no-audit --no-fund)
say "Building Harbor ($(git -C "$REPO" rev-parse --short HEAD), $(uname -m))"
(cd "$APP_DIR" && npm run pack -- --mac "$ARCH_FLAG")
[ -d "$OUT" ] || die "build finished but $OUT is missing"
[ -f "$OUT/Contents/Resources/icon.icns" ] || die "built app has no icon.icns"
[ -d "$OUT/Contents/Resources/app/src/daemon/node_modules/node-pty" ] || die "built app has no session daemon dependencies"

# Install ---------------------------------------------------------------------
# The session daemon also runs as a process named Harbor, so ask Launch
# Services whether the APP is running rather than matching process names.
gui_running() { [ "$(osascript -e 'application id "com.harbor.desktop" is running' 2>/dev/null)" = true ]; }
if gui_running; then
  say "Quitting the running Harbor window"
  osascript -e 'tell application id "com.harbor.desktop" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do gui_running || break; sleep 1; done
  gui_running && die "Harbor is still running; quit it and re-run"
fi
if [ -e "$DEST" ]; then
  OLD="$HOME/.Trash/Harbor-$(date +%Y%m%d-%H%M%S).app"
  say "Moving the previous Harbor.app to the Trash ($(basename "$OLD"))"
  mv "$DEST" "$OLD"
fi
say "Installing to $DEST"
ditto "$OUT" "$DEST"
# Unsigned build (build.mac.identity is null): clear quarantine so Gatekeeper
# does not block the first launch.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
# Make Finder and the Dock pick up the icon immediately.
touch "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true

# Session daemon ----------------------------------------------------------------
SESSIOND=( env ELECTRON_RUN_AS_NODE=1 "$DEST/Contents/MacOS/Harbor" "$DEST/Contents/Resources/bin/harbor-sessiond" )
if "${SESSIOND[@]}" status --json >/dev/null 2>&1; then
  say "Handing the running session daemon over to the new build"
  "${SESSIOND[@]}" handover --json || printf 'note: handover refused; the old daemon keeps running until it is restarted\n'
else
  say "Starting the session daemon"
  "${SESSIOND[@]}" start --json
fi

say "Installed Harbor $(defaults read "$DEST/Contents/Info.plist" CFBundleShortVersionString) ($(defaults read "$DEST/Contents/Info.plist" CFBundleVersion))"
if [ "$OPEN_AFTER" = 1 ]; then open -a "$DEST"; fi
echo "Done. Harbor is in /Applications. Drag it to the Dock to keep it there."
