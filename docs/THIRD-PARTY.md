# Third-party dependencies

This list covers the packages in the `dependencies` object of
`/home/you/dev/harbor/app/package.json`, i.e. what Harbor actually
depends on at runtime (as opposed to `devDependencies`, which are build and
test tooling only, listed separately below).

License values below were read directly from each package's own
`package.json` `"license"` field under `/home/you/dev/harbor/app/node_modules/`,
not inferred. Where a package could not be found there, that is stated
instead of guessing.

| Package | Required range | Installed version | License | Verified from |
|---|---|---|---|---|
| `@xterm/addon-fit` | `^0.10.0` | 0.10.0 | MIT | `app/node_modules/@xterm/addon-fit/package.json` |
| `@xterm/xterm` | `^5.5.0` | 5.5.0 | MIT | `app/node_modules/@xterm/xterm/package.json` |
| `react` | `^19.1.1` | 19.2.7 | MIT | `app/node_modules/react/package.json` |
| `react-dom` | `^19.1.1` | 19.2.7 | MIT | `app/node_modules/react-dom/package.json` |
| `ws` | `^8.21.1` | 8.21.1 | MIT | `app/node_modules/ws/package.json` (re-checked 2026-08-07 after `npm install`; this row previously read "not installed / unverified" because the dependency had not been installed when the table was first written) |

## Build/dev-only dependencies (not redistributed as application code)

These are in `devDependencies` in `app/package.json` and were not audited
above because they are not part of what ships at runtime inside a Harbor
session:

- `@playwright/test` (test runner)
- `electron` (the desktop runtime Harbor's own code runs inside)
- `vite` (renderer build tool)

Note on `electron` specifically: it is the packaging runtime the app is
distributed inside, and itself bundles Chromium, Node.js, and V8 under their
own licenses. This document does not attempt to reproduce those licenses;
if/when this app is packaged for distribution (e.g. via `electron-builder`
or similar), verify that the packaging step includes Electron/Chromium's own
upstream license notices, since that was not checked as part of this batch.

## Other third-party material

Bundled logos and images are third-party material but are not npm packages,
so they are not in this table. See `/home/you/dev/harbor/NOTICE` for those
(trademark logos used for interoperability, plus one asset and one logo of
unverified provenance).

This repository previously carried a verbatim mirror of Herdr's own
documentation under `docs/upstream-herdr-docs/`. That mirror was removed:
Herdr's docs are AGPL-licensed, and shipping them inside an MIT-licensed
repository was a licensing conflict, not a housekeeping choice. See
`docs/UPSTREAM-HERDR.md` for the current pointer to Herdr's upstream docs.
