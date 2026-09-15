# 07 — Decision log & future work

**What this document is for:** the *why*. Every non-obvious choice in this
project, the alternative that was rejected, and the reason. When you come back
in six months and wonder "why on earth is it done that way?", the answer should
be here. The second half is what to build next, ranked honestly.

## Contents

- [How to read a decision entry](#how-to-read-a-decision-entry)
- [Architecture decisions](#architecture-decisions)
- [Hardware decisions](#hardware-decisions)
- [Security decisions](#security-decisions)
- [Decisions made during this project](#decisions-made-during-this-project)
- [Open questions](#open-questions)
- [Future work, ranked](#future-work-ranked)

---

## How to read a decision entry

Each entry states the decision, the alternatives that were genuinely
considered, and the reason one won. A decision with no rejected alternative is
not a decision; it is a default, and it is not recorded here.

---

## Architecture decisions

### D1 — Sit in front of OctoPrint rather than talk to the printer directly

**Decision:** this app speaks HTTP to OctoPrint. It never opens the serial port.

**Rejected:** driving `/dev/ttyUSB0` directly from Node.

**Why:** the serial protocol is stateful, timing-sensitive, and full of
firmware-specific quirks — resends, checksums, busy protocols, temperature
report formats that differ between Marlin versions. OctoPrint has absorbed a
decade of that. Reimplementing it would be the whole project, and would be
worse. It also means OctoPrint's own interface, terminal and plugin ecosystem
remain available on port 5000 for everything this dashboard deliberately does
not do.

**Cost:** an extra hop, and a hard dependency. If OctoPrint is down, this app
can only report that it is down. That is the correct behaviour, and the
dashboard shows it as an explicit offline state with the real reason.

### D2 — Relay the camera server-side

**Decision:** the browser requests `/api/camera/stream` from this app; this app
fetches the phone's MJPEG stream and pipes it through.

**Rejected:** pointing an `<img>` tag straight at `http://192.168.1.50:8080/video`.

**Why:** the phone's address is a LAN address. From outside the house there is
no route to it, so the direct approach works at home and silently fails
everywhere else — the worst possible failure mode, because it looks fine while
you are testing. Relaying also keeps the phone's address and any camera
credentials out of the browser entirely.

**Cost:** the Pi carries the video traffic. On a 640×480 stream this is
negligible; at 1080p it is not, which is why the setup guide says to turn the
resolution down.

### D3 — One server-side poll loop, not one per browser tab

**Decision:** a single background loop polls OctoPrint every 2.5 seconds and
caches one snapshot. Every browser reads that cache.

**Rejected:** each browser polling OctoPrint (directly or through a proxy).

**Why:** two reasons, and the second is the important one.

1. Five open tabs are still one request every 2.5 s, not five.
2. **Anomaly detection runs whether or not a browser is open.** If detection
   lived in the frontend, closing the tab would switch off the safety net —
   and closing the tab is exactly what you do when you leave the house.

### D4 — No frontend build step

**Decision:** plain HTML, CSS and JavaScript, served as-is from `public/`.

**Rejected:** React/Vue/Svelte with a bundler.

**Why:** the target is a Raspberry Pi 3B. A build toolchain there is slow to
install, slow to run, and a recurring source of breakage across Node upgrades.
Nothing here needs a framework: it is one page with a poll loop. As a bonus you
can edit the UI over SSH and just reload the page.

**Cost:** no component model, no type checking. At this size, that is fine.

### D5 — An NDJSON log file, not SQLite

**Decision:** events are newline-delimited JSON in `data/events.log`, rotated
at 2 MB, with the last 200 held in memory.

**Rejected:** `better-sqlite3`.

**Why:** `better-sqlite3` compiles native code. On a Pi that is slow to install
and breaks on every Node major upgrade — a recurring maintenance tax for a
feature that is "show me the last fifty things that happened". A text file is
readable with `cat`, greppable, `jq`-able, and cannot fail to compile.

**Cost:** no queries beyond "recent". Nothing here needs them.

### D6 — A G-code allowlist, not a pass-through

**Decision:** the maintenance buttons map to five fixed command sets defined in
`server/index.js`. There is no endpoint that accepts arbitrary G-code.

**Rejected:** a terminal box in the UI, like OctoPrint's own.

**Why:** this app is reachable from the internet behind a single password.
Arbitrary G-code from a browser means anyone who gets past that password can
set the hotend to 300 °C, disable thermal protection, or drive the nozzle
through the bed. Five known-safe commands is a far smaller blast radius, and
OctoPrint's own terminal is still there on the LAN for the rare case you need
it.

**Cost:** adding a command means editing `MAINTENANCE_COMMANDS` and
redeploying. That is a feature, not a bug.

### D7 — Stateless session cookies

**Decision:** the session cookie is `<expiry>.<hmac>`, verified by
recomputation. No server-side session store.

**Rejected:** an in-memory or on-disk session table.

**Why:** restarting the service (which you do every time you edit `.env`)
would otherwise log you out. With a fixed `SESSION_SECRET`, sessions survive
restarts and reboots with no storage at all.

**Cost:** a token cannot be revoked before it expires without changing
`SESSION_SECRET` — which invalidates every session at once. For a single-user
tool that is the right trade, and changing the secret is a one-line fix if a
device is lost.

### D8 — Discover heaters instead of hardcoding them

**Decision:** the sensor list is built from whatever OctoPrint reports matching
`tool<n>` or `bed`.

**Rejected:** hardcoding the SV02's layout.

**Why:** it costs nothing — and the hardcoded version would have been wrong.
The SV02 was first assumed to have two hotends; its firmware reports
`EXTRUDER_COUNT:1`, two drives feeding one shared nozzle. Because the heater
list comes from what OctoPrint reports, and whether the nozzle is shared comes
from the printer profile, both layouts work with the same code. See
[08 — Deployment log](08-deployment-log.md#2-correction-the-sv02-has-one-shared-nozzle-not-two-hotends).

## Hardware decisions

### D9 — Raspberry Pi rather than a laptop or a phone

**Decision:** a Pi 3B runs OctoPrint and this app.

**Rejected:**
- **A laptop.** Has to stay on and awake with sleep disabled; installing
  OctoPrint on it is more work than flashing a card; it is a machine you want
  to take with you.
- **Octo4a on an old Android phone.** Genuinely works and runs real OctoPrint —
  but some handsets cannot charge and use USB OTG simultaneously, which is
  fatal for something meant to run for days, and the community is much smaller
  when something breaks.
- **An MKS WiFi module** (the ESP8266 board the Robin Nano accepts). This is
  the one people reach for when they want "no extra computer", so it is worth
  being precise: it gives wireless file transfer and basic control. It does
  **not** run OctoPrint, so there is no camera, no temperature alerts, no
  auto-pause, no notifications, and no dashboard. **It replaces the SD card, not
  the computer.**

**Why:** there is no version of "smart printer with a camera and failure
detection" that does not involve a small computer next to the printer. Given
that, the Pi is the cheapest, lowest-power, most-supported option, and OctoPi
means flashing an image instead of installing software.

### D10 — A phone as the camera

**Decision:** an old Android phone running IP Webcam.

**Rejected:** a USB webcam or the Raspberry Pi Camera Module.

**Why:** the phone is free, its camera and autofocus are better than a cheap
USB webcam, it needs no cable run to the Pi, and it has its own screen for
aiming. It costs a USB port on the Pi nothing at all.

**Cost:** it must stay on a charger, stay awake, and hold a fixed IP —
three failure modes a wired camera does not have. This is the weakest link in
the system, and the DHCP reservation is not optional.

### D11 — Tailscale rather than port forwarding

**Decision:** remote access via Tailscale.

**Rejected:**
- **Port forwarding 8088.** Puts a login form on the public internet, forever,
  protected by one password. Not worth it for the convenience saved.
- **Cloudflare Tunnel.** Genuinely good, and the right answer if you need a
  public URL you can *share*. It is documented in the app's README as an
  alternative.

**Why:** Tailscale exposes nothing publicly. Nobody can even attempt to log in.
For a household tool with one user, that is strictly better than any
authenticated public endpoint.

## Security decisions

| Decision | Why |
|---|---|
| The OctoPrint API key never reaches the browser | The server attaches it in one place. A compromised browser session cannot exfiltrate a key it never had. |
| Constant-time password comparison, both sides pre-hashed | Hashing first fixes the comparison length, so timing does not leak the password's length. |
| Login throttled: 8 attempts per IP per 15 minutes | This form is reachable from outside the house. An unthrottled password field is an open invitation. |
| Uploads restricted to `.gcode`/`.gco`/`.g`, filename sanitised, 250 MB cap | Prevents path traversal via the filename and stops a large upload filling the SD card. |
| `TRUST_PROXY_HTTPS` marks the cookie Secure-only | Behind a tunnel, the session cookie should never travel in clear text. |
| App refuses to boot on incomplete configuration | Far better than starting up half-broken and failing confusingly later. Missing password or API key is named explicitly and it exits. |

**Stated limits, honestly:** one shared password with no per-user accounts; the
throttle is in memory and resets on restart; there is no CSRF token (mitigated
by `SameSite=lax` and the fact that every mutating route is `POST`/`DELETE`
with a JSON body). For a single-user tool on a private network overlay, these
are acceptable. On a public URL they would deserve another look.

## Decisions made during this project

### D12 — Repository layout

**Decision:** flattened `sv02control/sv02-control/` to `sv02-control/`, moved
the firmware PDFs and superseded files into `reference/`, and created
`Documents/` for this documentation set.

**Why:** the double nesting was accidental and would have been permanent once
pushed. `reference/` separates *source material we were given* from *the
project we are building*, which matters when someone new opens the repo.

### D13 — Fixed the mocks' standalone guard

**Decision:** the mock OctoPrint and mock camera used
``import.meta.url === `file://${process.argv[1]}` `` to detect being run
directly. Changed to `pathToFileURL(process.argv[1]).href`.

**Why:** on Windows `process.argv[1]` is `E:\path\to\file.mjs`, so the
comparison never matched and `node test/mocks/octoprint.mjs` exited
immediately with status 0 — succeeding silently while doing nothing. The
documented no-hardware trial was therefore impossible on Windows. `pathToFileURL`
is correct on every platform. The test suite still passes 37/37.

### D14 — Documentation lives in `Documents/`, code docs stay with the code

**Decision:** project-level documentation (overview, roadmap, runbook,
architecture, operations) goes in `Documents/`. The app's own `README.md`,
`START-HERE.md`, `SETUP-PROMPT.md` and `docs/` stay inside `sv02-control/`.

**Why:** `sv02-control/` should remain a self-contained, independently usable
application. Someone who copies just that folder to a Pi gets everything they
need to run it. `Documents/` is *this build's* record, which is a different
audience and a different lifetime.

## Open questions

Things not yet decided, with the information needed to decide them.

| Question | What decides it |
|---|---|
| Should `AUTO_PAUSE_ON_ANOMALY` be `true`? | Whether a false positive that ruins a print costs more than a real fault that runs on for another hour. Start `false`, watch the log for a month, then decide with evidence. |
| Are 15 °C / 30 s the right thresholds? | Real print data. Part-cooling fans on bridges cause legitimate dips. Tune after seeing a month of logs, not before. |
| Fit a BLTouch? | Almost certainly yes — see below. The only question is when. |
| Reflash printer firmware? | Only if there is a specific reason. See [06 — Firmware & hardware](06-firmware-and-hardware.md). If the printer prints fine and OctoPrint connects, reflashing is risk with no return. |
| Move the camera off the phone? | Whether you want the phone back. A Pi Camera Module or USB webcam is more reliable but needs a cable run and gives up autofocus. |

## Future work, ranked

Ranked by value per hour of effort, most valuable first.

### 1. Fit the official Sovol BLTouch kit — *an afternoon, ~$15–40*

The highest-value change available. It stops you levelling the bed by hand, and
it makes the dashboard's existing **Auto bed level** button do something real —
with **no change to this app**.

Sovol sells a kit made for the SV02, which is what makes this easy: a bracket
that fits, a harness that plugs in, and a matching firmware build.

⚠️ **The SV02-specific trap:** the touchscreen has its *own* firmware that must
be flashed alongside the mainboard, or the new menu options simply will not
appear. This catches people out. Details in
[06 — Firmware & hardware](06-firmware-and-hardware.md).

Afterwards: set the Z-offset with `M851 Z-x.xx` from OctoPrint's terminal,
press **Save settings to EEPROM** in the dashboard (that is `M500`), and add
`G29` to your slicer's start G-code.

> Levelling compensation fixes a *slightly* uneven bed. It does not fix a badly
> tilted one. Get the bed physically flat with the knobs first, so the mesh is
> correcting fractions of a millimetre.

### 2. Timelapse from the camera relay — *a day*

The server already receives every frame. Writing one frame per layer change to
disk and stitching them is a contained feature, and the output is the single
most satisfying thing a printer can produce.

### 3. Filament runout sensor — *an afternoon*

A switch that pauses the print when filament runs out. Cheap, and it converts
"eight wasted hours" into "swap the spool and resume". Handled at the firmware
or OctoPrint level; the dashboard shows the pause automatically.

### 4. A dedicated camera — *an hour*

A Pi Camera Module or USB webcam removes the three phone-shaped failure modes
(charge, sleep, changing IP) and gives you the phone back. Costs autofocus and
a cable run.

### 5. Klipper conversion — *a weekend*

Worth it for input shaping and pressure advance alone — faster prints at the
same quality. The MKS Robin Nano can run it with the Pi as host. You lose the
stock touchscreen menus in exchange for a web interface. Do this for the print
quality, not for the probe.

### 6. Load-cell "nozzle as probe" — *weeks; a real engineering project*

The genuine Prusa MK4 answer: probe on contact *force*, so the probe point is
the print point, with zero X/Y offset and no sensitivity to bed material.
`[load_cell_probe]` is in mainline Klipper now, so it is no longer
fork-and-pray.

But be honest about the cost: it needs Klipper, a load cell and ADC, and a
**redesigned toolhead mount on a flexure** so contact force transfers into the
sensor and nothing else does. (The SV02's single shared nozzle at least means
solving that once, not once per nozzle.)

**A BLTouch solves the problem you actually have.** Treat this as a project for
later, and only if you convert to Klipper for other reasons. The full analysis
is in [nozzle-probe-research.md](../sv02-control/docs/nozzle-probe-research.md).

### Not planned, and why

| Idea | Why not |
|---|---|
| Multi-user accounts | It is a household tool. One password is the right amount of ceremony. |
| Hosting the dashboard in the cloud | Structurally impossible — a datacentre cannot reach `localhost:5000` or `192.168.1.50`. Only a static *demo* can be hosted, and `demo/build.mjs` already produces one. |
| A G-code terminal in the dashboard | See [D6](#d6--a-g-code-allowlist-not-a-pass-through). OctoPrint's own terminal is there on the LAN. |
| Replacing OctoPrint | See [D1](#d1--sit-in-front-of-octoprint-rather-than-talk-to-the-printer-directly). It would be the whole project, and worse. |

---

Back to **[the index](README.md)**
