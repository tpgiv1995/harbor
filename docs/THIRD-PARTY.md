# Third-party material

Direct dependencies from both [the application manifest](../app/package.json)
and [the daemon manifest](../app/src/daemon/package.json), checked against the
installed package metadata on 2026-09-19. The lockfiles pin the dependency trees;
this table is not a complete transitive-license inventory.

| Scope | Package | Required range | Installed version | Declared license |
| --- | --- | --- | --- | --- |
| Application | `@excalidraw/excalidraw` | `^0.18.1` | 0.18.1 | MIT |
| Application | `@xterm/addon-fit` | `^0.10.0` | 0.10.0 | MIT |
| Application | `@xterm/xterm` | `^5.5.0` | 5.5.0 | MIT |
| Application | `react` | `^19.1.1` | 19.2.7 | MIT |
| Application | `react-dom` | `^19.1.1` | 19.2.7 | MIT |
| Application | `ws` | `^8.21.1` | 8.21.1 | MIT |
| Daemon | `@xterm/addon-unicode11` | `0.9.0` | 0.9.0 | MIT |
| Daemon | `@xterm/headless` | `6.0.0` | 6.0.0 | MIT |
| Daemon | `koffi` | `3.1.6` | 3.1.6 | MIT |
| Daemon | `node-pty` | `1.1.0` | 1.1.0 | MIT |
| Build/test and desktop runtime | `@playwright/test` | `^1.52.0` | 1.52.0 | Apache-2.0 |
| Build/test and desktop runtime | `electron` | `^37.2.6` | 37.10.3 | MIT |
| Build/test and desktop runtime | `electron-builder` | `^25.1.8` | 25.1.8 | MIT |
| Build/test and desktop runtime | `vite` | `^7.0.6` | 7.3.6 | MIT |

Electron is declared as a development dependency but ships as the desktop
runtime, including Chromium, Node.js and V8. Preserve its upstream notices when
packaging. Installer notice inclusion has not been verified in this refresh.

## Bundled fonts

All six files under [the font directory](../app/assets/fonts/) are covered by
the two upstream SIL Open Font License 1.1 texts now shipped alongside them:

| Files | Included license | Upstream |
| --- | --- | --- |
| IBMPlexMono-400.woff2, IBMPlexMono-500.woff2, IBMPlexMono-600.woff2 | [IBM Plex OFL](../app/assets/fonts/IBM-Plex-OFL.txt) | [IBM/plex](https://github.com/IBM/plex/blob/master/LICENSE.txt) |
| SchibstedGrotesk-Regular.ttf, SchibstedGrotesk-SemiBold.ttf, SchibstedGrotesk-Bold.ttf | [Schibsted Grotesk OFL](../app/assets/fonts/Schibsted-Grotesk-OFL.txt) | [Schibsted project](https://github.com/schibsted/schibsted-grotesk/blob/main/OFL.txt) |

The packaging configuration copies these notices into licenses/fonts under
the application's resources directory. Font files themselves were not changed.

## Marks and artwork

See [NOTICE](../NOTICE) for provider marks and artwork. The exact source and
license of app/assets/logo-claude.svg remain unverified from repository records.
The trademark notice is not evidence of an SVG copyright license. Establish its
source or replace/remove it before publication; this refresh does not close that
item. The existing generated hero texture is reused.
