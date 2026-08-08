# Testing Harbor on a real iPhone

`app/scripts/ios-device-probe.js` evaluates JavaScript in the real Harbor PWA on a USB-paired iPhone. It is a manual diagnostic, not part of Harbor's default verification gate: the phone is not expected to be connected during ordinary builds or tests.

## Prerequisites

Install the USB and build dependencies (package names shown for Debian/Ubuntu):

```bash
sudo apt install usbmuxd libimobiledevice-utils autoconf automake libtool pkg-config \
  libimobiledevice-dev libusbmuxd-dev libplist-dev libssl-dev
```

Build `ios-webkit-debug-proxy` with warnings excluded from `-Werror`:

```bash
git clone https://github.com/google/ios-webkit-debug-proxy.git
cd ios-webkit-debug-proxy
./autogen.sh
CFLAGS=-Wno-error ./configure
make
sudo make install
```

On the iPhone, enable **Settings > Safari > Advanced > Web Inspector**. Connect it over USB, unlock it, and accept the trust/pairing prompt. Confirm that libimobiledevice sees it:

```bash
idevice_id -l
idevicepair validate
```

Linux desktop automount may start `gvfsd-gphoto2`, which claims the phone's USB configuration and prevents the debug proxy from attaching. Unmount the iPhone from the desktop file manager before starting the proxy. If needed, inspect and unmount the GPhoto mount explicitly:

```bash
gio mount -l | grep -i gphoto
gio mount -u 'gphoto2://[usb:BUS,DEVICE]/'
```

Use the exact URI printed by `gio mount -l`. Verify `gvfsd-gphoto2` no longer holds the device before continuing. Reconnecting the phone can remount it, so repeat this step when necessary.

## Start the proxy

With the phone unlocked and Harbor open in Mobile Safari, start the proxy using the UDID printed by `idevice_id -l`:

```bash
ios_webkit_debug_proxy -c "$(idevice_id -l | head -n 1):9222" -d
```

Keep it running in that terminal. In another terminal, `curl http://127.0.0.1:9222/json` should list the inspectable Harbor page. The probe defaults to `ws://127.0.0.1:9222/devtools/page/1`; if the listing reports a different page endpoint, pass it with `IOS_WS`.

WebKit on iOS 12.2 and newer uses its multi-target protocol. A bare `Runtime.evaluate` receives `"'Runtime' domain was not found"`; the checked-in probe preserves the required `Target.sendMessageToTarget` / `Target.dispatchMessageFromTarget` wrapping.

## One-shot evaluation

Run from the Harbor repository root:

```bash
node app/scripts/ios-device-probe.js --eval 'innerHeight'
```

The command prints the returned value and exits. For a non-default page endpoint:

```bash
IOS_WS=ws://127.0.0.1:9222/devtools/page/2 \
  node app/scripts/ios-device-probe.js --eval 'location.href'
```

If no phone/page is available, the command exits non-zero with a connection or 15-second target timeout diagnostic; it does not wait indefinitely.

## Record and read a mobile geometry trace

Install the recorder in the currently open Harbor page:

```bash
node app/scripts/ios-device-probe.js --install-recorder
```

On the iPhone, focus and blur the composer, open and close the software keyboard, scroll, and reproduce the layout behavior. Then read the trace:

```bash
node app/scripts/ios-device-probe.js --read-trace
```

The trace takes a baseline snapshot and then records every `visualViewport` resize and scroll plus every `focusin` and `focusout`. Each snapshot contains `innerHeight`, visual viewport height/offset/scale, `scrollY`, and `getBoundingClientRect()` measurements for `.composer`, `.composer textarea`, `.composer-send`, `.shell-bottom-anchor`, `.app-shell`, and `.conv`. Re-running `--install-recorder` stops the previous listeners, clears the old trace, and starts a fresh one. The latest 400 snapshots are retained in the page.

If Mobile Safari reloads the PWA, install the recorder again because the in-page trace is cleared.
