# The phone client

Harbor's mobile client is an installable web app (a PWA) served by a small
headless Node server. This document is the whole setup, and it is honest about
which parts are automated (few) and which are yours to do (most).

## Where the server runs, and why it matters

**On whatever machine your agent sessions run on.** The server drives the same
session daemon the desktop app does, over a local socket, and that daemon has to
be next to your code. There is no remote-daemon mode: pointing the server at a
different computer's sessions is not a supported arrangement, and nothing in the
code pretends otherwise.

That leaves you two real choices.

### Option A: your own machine (start here)

Run the server on the laptop or desktop you already work on. Nothing extra to
buy, nothing extra to maintain, and the sessions you see on the phone are the
same ones on your screen.

The catch is the obvious one: when that machine sleeps, the phone client stops.
If you only reach for your phone while the machine is awake, this is the whole
story and Option B is not worth the trouble.

### Option B: a second, always-on machine

If you want the phone to work while your laptop is shut, run Harbor's server on
a machine that stays awake. A cheap always-on box, a home server, a spare
laptop with sleep disabled: any of them work.

**The thing to understand before you do this**: the sessions live on that
machine. The agent's working directory, its git checkout and its files are all
over there, not on your laptop. So this only makes sense if you are content to
treat the always-on machine as where that work happens, and move code between
machines the way you normally would, by pushing and pulling a branch. Sharing a
working directory over a network file system between two machines running agents
against it is a good way to corrupt something.

Set it up exactly as in Option A, on that machine, then add it to the same
Tailscale tailnet as your phone.

## Steps

All commands run from `app/`.

### 1. Build the web client

```sh
npm run build:web        # builds app/dist-web/
```

Nothing does this for you. If you skip it, the server starts, answers `/health`,
and returns 404 for every page, which looks like a network problem and is not.

### 2. Start the server once, by hand

```sh
npm run start:server
```

It prints the address it bound to and the path of its access token. By default
it binds to `127.0.0.1:8787`, which is enough to open it in a browser on the
same machine and confirm it works before involving a phone.

### 3. Reach it from the phone

The server refuses to bind to anything except loopback or a Tailscale address
(`100.64.0.0/10`). This is deliberate: what is behind it can type into agent
sessions running with permissions bypassed, so it must not be reachable from a
network you do not control. Read `docs/SECURITY-MOBILE.md` before going further.

Install [Tailscale](https://tailscale.com) on both the server machine and the
phone, sign both into the same tailnet, then either:

- bind directly to the machine's own tailnet address:

  ```sh
  HARBOR_SERVER_HOST=100.x.y.z npm run start:server
  ```

  (`tailscale ip -4` prints yours), or

- keep the loopback bind and put Tailscale Serve in front of it, which gets you
  HTTPS and a stable name:

  ```sh
  tailscale serve --bg --https=443 http://127.0.0.1:8787
  ```

Tailscale **Funnel** would publish this on the public internet. Do not use it.

### 4. Get the token onto the phone

Every mutating call (starting a session, sending a message, answering a dialog)
needs a 64-character bearer token, generated on first start and stored at
`<userData>/server-token` with mode `0600`. Open the server's URL on the phone
and paste the token into the connect screen, or open a link of the form
`https://<host>/#token=<token>&url=<server-url>`.

To print that link in one step (MagicDNS host when Tailscale is up, else
loopback):

```sh
npm run mint:server-link
```

There is no QR code and no pairing flow. Getting the token across is manual,
and if you send it to yourself through a chat app, remember that you have just
put a credential in a chat app.

### 5. Add it to the home screen

In Safari or Chrome on the phone, use Share, then Add to Home Screen. It runs
full screen from then on.

## Keeping it running

`npm run start:server` dies with the terminal that started it. Templates for
each platform are in [`setup/service/`](service/); each one needs the paths
edited to match your checkout, and each says so at the top.

| Platform | Template | Install |
| --- | --- | --- |
| Linux | `service/harbor-server.service` | Copy to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now harbor-server` |
| macOS | `service/com.harbor.server.plist` | Copy to `~/Library/LaunchAgents/`, then `launchctl load -w ~/Library/LaunchAgents/com.harbor.server.plist` |
| Windows | `service/harbor-server-task.ps1` | Run it once in an elevated PowerShell; it registers a logon-triggered Scheduled Task |

Logs go wherever your supervisor puts them: `journalctl --user -u harbor-server`
on Linux once the unit above is installed, the two log paths in the plist on
macOS, and the task's own output file on Windows.

The author's machine is Windows now (the Linux install behind the original
template was retired 2026-08-10), so the Windows task template is the one that
matches the machine these are maintained on; the Linux and macOS templates are
the unvalidated ones. All three are starting points with the right shape, not
tested artifacts, and the table above is deliberately not written as though
they were.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `HARBOR_SERVER_HOST` | Bind address. Loopback or `100.64.0.0/10` only; anything else is refused at startup. |
| `HARBOR_SERVER_PORT` | Port, default `8787`. |
| `HARBOR_WEB_DIST` | Where the built PWA lives, if not `app/dist-web/`. |
| `HARBOR_TAILNET_LOGINS` | Optional. Lets a peer proven to be on the tailnet skip the token. Linux only, because it reads the peer uid from procfs. |

## When it does not work

- **Every page 404s**: `npm run build:web` was not run, or `HARBOR_WEB_DIST`
  points somewhere else.
- **Refuses to start, naming the bind address**: you asked it to bind to
  something that is neither loopback nor a Tailscale address. That guard is not
  advisory.
- **Connects, then everything read-only**: the token is wrong or missing. Read
  `<userData>/server-token` again; it is regenerated only if deleted.
- **Phone cannot reach the host at all**: that is Tailscale, not Harbor. Check
  `tailscale status` on both ends first.
