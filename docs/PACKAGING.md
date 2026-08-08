# Packaging Harbor

How to build a Harbor installer, what the native-module constraint actually
is, and why signing and notarization are deliberately absent. Read
`setup/linux/README.md`, `setup/windows/README.md` and `setup/macos/README.md`
first for how to *run* Harbor; this document is about producing the
installer, not about what happens once someone runs it.

**Nothing in this document has been verified by actually running
`electron-builder`.** It was written by reading `electron-builder`'s
documented behaviour and by reading Harbor's own source to find every place
that assumes a real, on-disk layout, not by producing and testing an
installer end to end. Treat the first real CI run (or the first local
`npm run dist`) as the actual test of everything below, and expect to fix
something. That is stated plainly rather than hedged because the alternative
is a document that reads as proven when it is not.

## Building locally

**A local build can pick up your own files, and one of them is named after your
projects.** `app/assets/project-icons/` is empty in the repository and
gitignored, but Vite globs it at build time, so any icon you dropped in there is
bundled into `app/dist/` and therefore into whatever installer you build. The
filenames are derived from your project labels, so an installer built on a
machine with a real icon set carries a list of that person's project names.

This does not affect releases: `.github/workflows/build.yml` builds from a clean
checkout where that folder is empty. It affects an installer you build by hand
and then hand to somebody. If that is what you are doing, empty the folder
first, or build from a fresh clone.

```sh
cd app
npm install                # devDependencies now include electron-builder
npm run pack                # unpacked app only, no installer, fastest loop
npm run dist                # installer(s) for the platform you're running on
npm run dist:linux          # AppImage + deb (only produces real output on Linux)
npm run dist:win            # NSIS installer (only produces real output on Windows,
                             # or on another platform with wine installed)
npm run dist:mac            # dmg, x64 and arm64 (only produces real output on macOS)
```

Every one of those scripts runs the renderer build (`vite build` ->
`app/dist/`) and the phone-client web build (`vite build --config
vite.web.config.js` -> `app/dist-web/`) first, then installs
`app/src/daemon`'s own dependencies (see below), then invokes
`electron-builder`. Output lands in `app/release/` (not `app/dist/`, which is
already the renderer's own build output directory and would otherwise be
both an input to packaging and a target the packager writes into at the same
time). `app/release/` is not yet in `.gitignore`; add it before committing
anything built with these scripts.

Cross-building for a different OS than the one you're running mostly does
not work without extra tooling `electron-builder` would need installed
separately (Wine for Windows targets from Linux/macOS, for example). The
GitHub Actions workflow below sidesteps that by building each target on its
own native OS.

## The native-module constraint: node-pty

`app/src/daemon/node_modules/node-pty` is a native addon (a native module
per platform and CPU architecture, not portable JavaScript) vendored under
`app/src/daemon/`, which has its own `package.json` and its own
`package-lock.json`, separate from `app/package.json`. It is gitignored:
nothing under `app/src/daemon/node_modules/` is committed to the repository,
so a fresh checkout does not have it. Both `pack:daemon-deps` (a new script
this batch added) and the CI workflow run `npm ci` inside
`app/src/daemon` before packaging, specifically so this does not get
silently left out.

What that native module actually needs is more specific than "rebuild it for
Electron," which is the usual `electron-builder` native-module story and is
**not** what applies here:

- `node-pty` is required by `app/src/daemon/keeper.js`, which is spawned as
  a plain **system Node** child process (`spawn(process.execPath, [...])`
  from `app/src/daemon/daemon.js`), never loaded inside the Electron main
  process itself. `electron-builder`'s automatic native-module rebuild
  (`npmRebuild`, on by default) exists to rebuild native addons against
  *Electron's* Node ABI, because it assumes the native module is `require`d
  by Electron. That assumption is wrong here, so this batch turns
  `npmRebuild` off (`"npmRebuild": false` in `app/package.json`'s `build`
  block) rather than let it do the wrong kind of rebuild.
- The vendored `node-pty` (1.1.0) ships prebuilt native binaries in its own
  `prebuilds/` directory for `darwin-x64`, `darwin-arm64`, `win32-x64` and
  `win32-arm64`, built against Node-API (N-API), which is ABI-stable across
  Node versions. Its loader (`lib/utils.js`, `loadNativeModule`) tries
  `build/Release`, then `build/Debug`, then `prebuilds/<platform>-<arch>`,
  catching and moving past a failed `require()` at each step. So on Windows
  and macOS, the vendored package's own prebuilds load with **no rebuild
  step required at all**; this was confirmed by reading that loader, not by
  running it there. Linux has no prebuild in this package and instead has a
  locally compiled `build/Release/pty.node` (built once, on the machine this
  batch was authored on, via the `install` script's `node-gyp rebuild`
  fallback), which the same N-API stability should make loadable by any
  Node 22 on Linux x64, but the CI workflow's `npm ci` step inside
  `app/src/daemon` reruns that build fresh on the `ubuntu-latest` runner
  rather than rely on whatever happened to be committed from a dev machine
  (nothing under `node_modules/` is committed anyway, so this is really "the
  only way Linux gets a `pty.node` in CI at all," not a belt-and-suspenders
  extra).
- **Not handled**: the macOS job builds both an x64 and an arm64 dmg from a
  single `npm install --prefix app/src/daemon` run on one runner
  architecture. If that only produces (or the search order only picks up) a
  native binary for the runner's own architecture, and no matching prebuild
  is found for the other, `node-pty` fails to load on whichever mac dmg
  target did not match. This did not get a real fix in this batch: it would
  need arch-targeted rebuilds (`npm_config_arch` / `--arch`) run twice on the
  mac leg, one per target architecture, and that was left undone because it
  could not be verified without a Mac runner to test it on. Flagged here so
  it is not silently assumed to work.

## Why `asar` is disabled for the whole app, not just node-pty

`electron-builder`'s usual answer to "a native module can't run from inside
an asar archive" is `asarUnpack`: keep the app compressed into
`app.asar`, but copy the listed native-module files out to a sibling
`app.asar.unpacked/` directory at packaging time, and `require()` finds them
there transparently. `app/package.json`'s `build.asarUnpack` still lists
`src/daemon/node_modules/node-pty/**/*`, so that mechanism is wired up and
ready if `asar` is ever turned back on.

But `build.asar` is set to `false` for the whole package, not left at its
default `true` with `asarUnpack` doing the work, because `asarUnpack` alone
provably does not fix the actual failure here. The evidence:

- `bin/harbor-sessiond` (which `app/src/main/lifecycle.js` and
  `app/src/main/index.js` shell out to as the *default* session backend --
  see `app/src/main/session-daemon/factory.js`, `resolveSessionBackend`,
  which defaults to `'sessiond'` unless `HARBOR_SESSION_BACKEND=herdr` is
  set) computes `appRoot = path.resolve(__dirname, '../app')` and then
  `require()`s `app/src/daemon/daemon.js` and related files straight from
  that path, as plain files on a real filesystem, because `bin/` is invoked
  by plain system Node, which has no idea how to read the inside of an
  `.asar` archive (asar-transparency is an Electron/Node-with-Electron's-fs
  patch feature, not a plain-Node one).
  - In a standard `asar: true` package, there is no directory literally
    named `app` next to `bin/` at all: there is `app.asar` (a single file)
    and, if `asarUnpack` matched anything, `app.asar.unpacked` (a
    differently-named directory holding only the unpacked subset). Neither
    name is `'../app'`. `bin/harbor-sessiond`'s hardcoded relative path
    would resolve to a directory that does not exist, and the default
    session backend would fail to start once packaged.
  - `bin/` itself is not part of `app/`'s own build; it lives at the
    **repository root**, one level above `app/`, and is shipped via
    `build.extraResources` (`{ "from": "../bin", "to": "bin" }`), landing at
    `resources/bin/` in the packaged app. `app/src/main/lifecycle.js` and
    `app/src/main/actions/launch.js` resolve `bin/`'s own scripts the same
    way (`path.resolve(__dirname, '../../../bin/...')` and
    `'../../../../bin/...'` respectively), which happens to land at
    `resources/bin/` too, whether or not `asar` is enabled, because that
    math is pure string arithmetic on `__dirname` and does not care whether
    the path happens to pass through a virtual `.asar` mount point. That
    part would have worked either way; the `bin/harbor-sessiond` ->
    `'../app'` lookup is the part that specifically requires a real `app`
    directory.
- With `asar: false`, `electron-builder` places the packaged app as a plain
  directory literally named `app` under `resources/` (this is
  `electron-builder`/Electron's own documented convention for the no-asar
  case; it is also how Electron itself looks for an app when there is no
  `app.asar`), which is exactly what `bin/harbor-sessiond`'s `'../app'`
  needs. That is the actual reason for this choice: it is not a broader
  security or size trade-off being made deliberately, it is the only
  packaging-only (no code change) fix for a real path assumption in a file
  this batch is not allowed to edit (`bin/` is out of scope for this
  change).

If `bin/harbor-sessiond`'s path assumption is ever fixed in code (for
example, deriving `appRoot` from something that survives being inside an
asar, or shipping a small resolver that checks both `app` and
`app.asar.unpacked`), `asar` can go back to `true` and `asarUnpack` alone
would then be sufficient for `node-pty`. Until then, disabling `asar`
entirely is the correct choice given the constraint, not a workaround left
in place out of caution.

**This was not verified by producing and running a packaged build.** The
reasoning above is from reading `electron-builder`'s documented unpacking
behaviour and Harbor's own source; a real build's first run is the actual
test of it.

## Signing and notarization: deliberately absent

There is no `afterSign` hook and no notarization step anywhere in this
batch's configuration, on purpose, not as an oversight:

- **Windows**: the NSIS installer is unsigned. Windows SmartScreen will warn
  on first run. Fixing that needs a code-signing certificate, which is a
  paid, identity-verified purchase, not something to wire up speculatively.
- **macOS**: `build.mac.identity` is explicitly `null` (forces an unsigned
  build even if a signing identity happens to be present on the machine
  running the build), `hardenedRuntime` is `false`, and
  `gatekeeperAssess` is `false`. Apple notarization needs an Apple Developer
  Program membership and credentials (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
  or an API key) supplied as CI secrets that do not exist in this
  repository. An unsigned, un-notarized `.dmg` will be Gatekeeper-blocked on
  first open; the workaround (right-click -> Open, or clearing the
  quarantine attribute) is exactly what `setup/macos/README.md` already
  documents for running from source, and applies the same way to a built
  `.dmg`.
- If real signing is set up later, the natural place for a notarization step
  is `build.afterSign` in `app/package.json`, pointed at a script under
  `app/build/` that calls `@electron/notarize` (or equivalent), gated on the
  relevant secrets being present so a fork or a secrets-less run degrades to
  "skip, don't fail." That does not exist yet; this paragraph is the
  planning note for whoever adds it, not a description of something already
  wired up.

The operating principle, matching what `.github/workflows/build.yml` and
`.github/workflows/ci.yml` both say in their own header comments: a workflow
step that needs a secret this repository does not have fails on every run,
which is strictly worse than not having the step. Nothing in either workflow
requires a secret.

## `npm ci` in the workflows

Both workflows use `npm ci`. It is the right choice for CI: it installs exactly
what the lockfile says and fails loudly if `package.json` and
`package-lock.json` have drifted apart, instead of quietly resolving something
newer.

That was not true for a short window. `electron-builder` was added to
`app/package.json` without the lockfile being regenerated, so the two disagreed
and `npm ci` refused, correctly. The workflows were written around it with
`npm install` and a comment explaining why. That was the wrong shape of fix: the
repository's own CI was avoiding a problem a user cloning the repo would hit on
their first command. The lockfile is regenerated and committed, and `npm ci`
resolves cleanly from a fresh clone.

If you add a dependency, regenerate the lockfile in the same change. A
`--package-lock-only` install updates it without touching an existing
`node_modules`, which matters when a daemon on that machine is holding a native
module open.

## Files shipped, and what's deliberately left out

`app/package.json`'s `build.files` is an allowlist: `package.json`,
`dist/**/*` (the built renderer), `dist-web/**/*` (the built phone-client
web app), `src/**/*` (all of it, including `src/daemon/` and its vendored
`node-pty`), and `node_modules/ws/**/*` (the one runtime dependency of
`src/server/`, the phone-client bridge server; see below). Everything else
in `app/` -- `test/`, `docs/`, `scripts/`, `verify/`, `test-results/`,
`web/` (the phone client's *source*, as opposed to `dist-web/`, its built
output), and the rest of `node_modules/` (`react`, `react-dom`,
`@xterm/xterm`, `@xterm/addon-fit`, `electron`, `vite`, `electron-builder`,
`@playwright/test`) -- is excluded by simply not being in the allowlist.
A handful of explicit negative patterns (`!**/*.test.js`, `!**/*.md`,
`!**/.claude/**`, `!**/test/**`, `!**/tests/**`, `!**/fixtures/**`,
`!**/docs/**`) additionally strip test files and documentation that live
*inside* an otherwise-included tree, most notably `node-pty`'s own bundled
`*.test.js` files and its `README.md`.

`bin/` ships via `build.extraResources` rather than `build.files`, because it
lives one directory above `app/` (at the repository root) and `files` only
reaches inside the project directory `electron-builder` is run from.

**`app/src/server/` (the phone-client bridge server, started with
`npm run start:server`) is shipped as source but is not wired up to run
automatically inside the packaged app.** Nothing in `app/src/main/`
`require`s or spawns it; it is a genuinely separate, standalone Node process
today (see the "phone client" section of the root `README.md`). Its one
runtime dependency, `ws`, is bundled (`node_modules/ws/**/*` in the files
allowlist) specifically so that running `node resources/app/src/server`
from an installed release has a chance of working, but this was not driven
end to end, and there is no menu item, script, or documented command that
launches it from an installed release today. Treat "the phone client runs
from an installed build" as unproven, not as a shipped feature.

## Icons

`app/build/icon.png` (1024x1024) and `app/build/icon.ico` are copies of the
existing `app/assets/icon-1024.png` and `app/assets/icon.ico`. `electron-builder`
generates the platform-specific icon formats it needs (`.icns` for macOS, the
multi-resolution `.ico` for Windows NSIS, PNG sizes for the Linux targets)
from `build.linux.icon` / `build.win.icon` / `build.mac.icon` referencing
these, per its own documented single-source-icon behavior. This was not
verified by producing a build and inspecting the resulting `.icns`/installer
icon; if it looks wrong, providing platform-native source files directly
(an `.icns` for mac, a full multi-size `.ico` for Windows -- the existing
`app/assets/icon.ico` already is one) is the fallback.

## What the GitHub Actions workflows do

`.github/workflows/build.yml`: on a `v*` tag push or manual dispatch, builds
Harbor on `ubuntu-latest`, `windows-latest` and `macos-latest` (one native
runner per target, so nothing is cross-compiled), runs `npm ci` then the
matching `dist:*` script, and uploads whatever installer files land in
`app/release/` as a workflow artifact per OS. It does not sign, notarize,
publish a GitHub Release, or touch any secret.

`.github/workflows/ci.yml`: on push to `main` and on every pull request,
installs the pinned Herdr 0.7.4 CLI (some unit tests spawn it in an isolated
named session; see `app/test/herdr/harness.js`), then runs `npm ci` and
`npm test` (the unit suite only) on `ubuntu-latest`. It deliberately does
**not** run `npm run test:e2e`: that suite requires an isolated X server
(`xvfb-run`) and an isolated D-Bus session (`dbus-run-session`) together (see
`app/scripts/e2e.js` and the "A harness cannot open a native file dialog
either" note in `CLAUDE.md`), is specified as a two-consecutive-green-runs
gate, and reproducing that reliably in a first pass was judged more likely to
produce a red or hanging check than a real one. Wiring it up is left as
follow-up work; `npm run test:e2e` remains the local/pre-release gate exactly
as documented in `CLAUDE.md`.

## Known-flaky test signal, unrelated to this batch

While verifying `npm test` for this batch, a second, back-to-back run showed
17 failures (out of 1,063 + 37), all clustered in daemon/`keeper`/pty
integration tests (`test/daemon/`, `test/actions/`, one in
`test/herdr/control-latency.test.js`). This machine had dozens of leaked
`app/src/daemon/keeper.js` processes going back several days, and what
appeared to be two concurrent `herdr server` processes, at the time. That
matches the flake category `setup/linux/README.md` already documents
("Run the suite on a quiet machine... indistinguishable from a leak") and
predates this batch; nothing touched by this batch (`app/package.json`'s
`scripts`/`devDependencies`/`build` keys, the two workflow files, the setup
docs, or this document) is read by the test runtime. It is noted here rather
than silently ignored, and rather than "fixed," because fixing it would mean
touching `src/` or killing processes on a live machine, both out of this
batch's scope and out of `npm test`'s.
