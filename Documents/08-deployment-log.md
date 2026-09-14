# 08 — Deployment log

**What this document is for:** what actually happened when this was built on
real hardware, on **14–15 September 2026**, and the problems that only showed
up once real equipment was involved. The runbook in
[03](03-pi-and-octoprint-runbook.md) tells you what *should* happen. This one
records what *did*, including four things the original documentation got
wrong.

## Contents

- [The system as built](#the-system-as-built)
- [Five real problems, and what each one taught](#five-real-problems-and-what-each-one-taught)
- [What changed in the code](#what-changed-in-the-code)
- [Remote access](#remote-access)
- [Verification evidence](#verification-evidence)
- [Still outstanding](#still-outstanding)

---

## The system as built

| Component | Actual value |
|---|---|
| Printer | Sovol SV02, **two independent hotends**, two thermistors |
| Host | Raspberry Pi 3 Model B Rev 1.2, `armv7l`, 869 MB RAM |
| OS | Raspbian GNU/Linux 12 (bookworm), OctoPi 1.1.0 |
| OctoPrint | 1.11.2, connected `/dev/ttyUSB0` @ **115200**, auto-connect on boot |
| Node.js | **v20.20.2** from Node's official `linux-armv7l` tarball, in `/usr/local` |
| npm | 10.8.2 |
| LAN address | `octopi.local` / `192.168.2.102` |
| Tailscale | `octopi` at `100.127.82.57`, `octopi.tail928e81.ts.net` |
| Camera | Android phone at `192.168.2.143:8080` (IP Webcam) |
| Dashboard | `:8088`, systemd `sv02-control`, enabled |
| Tunnel | `cloudflared` quick tunnel, systemd, enabled |

---

## Five real problems, and what each one taught

### 1. OctoPrint connected to a simulator, not the printer

**Symptom:** everything looked perfect — "Operational", live temperatures, the
lot. None of it was real.

**Cause:** OctoPi ships OctoPrint's built-in **virtual printer**, which appears
in the serial-port list as `/tmp/printer`. OctoPrint had auto-connected to it
at 250000 baud instead of to `/dev/ttyUSB0`.

**Why it is dangerous:** it is the most convincing possible false positive. A
simulator produces plausible temperatures, accepts commands and reports
success. Every downstream check passes while the printer sits untouched.

**Fix:** disconnect, reconnect explicitly to `/dev/ttyUSB0` at 115200, and set
`autoconnect: true` so it never silently picks the simulator again.

> **Always confirm the port reads `/dev/ttyUSB0`, never `/tmp/printer`.**

### 2. "Shared nozzle" silently discarded the second hotend

**Symptom:** `tool0` and `tool1` reported *exactly* the same value, to two
decimal places, every single sample.

**Cause:** the setup wizard left **Shared nozzle** ticked. That tells OctoPrint
there is one heater, so it throws away `tool1`'s real reading and reports
`tool0`'s value in both slots.

**Why it matters:** the dashboard would have shown two temperature cards with
plausible numbers, while the second hotend was **not monitored at all**. A
thermal fault on it would have been invisible to the anomaly detector — the
exact failure this project exists to catch.

**Fix:** untick Shared nozzle. Two independent readings appeared immediately
(`21.68 / 21.56`, drifting separately — real thermistor noise).

> **Two real thermistors never agree to two decimal places. If they do, this is why.**

### 3. NodeSource has dropped 32-bit ARM entirely

**Symptom:** the documented install command produced Node **18 with no npm**.

**Cause:**

```
Error: Unsupported architecture: armhf. Only amd64, arm64 are supported.
```

NodeSource's setup script now refuses `armhf` outright — not just for Node 22,
as the original docs assumed, but for **Node 20 as well**. The script exits,
`apt-get install nodejs` silently falls back to Raspbian's own `nodejs`
package, and that package **does not include npm**.

**Fix:** use Node's own official `linux-armv7l` tarball. Node 20 is the last
major line that publishes one.

```bash
V=v20.20.2
curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-armv7l.tar.xz"
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
```

⚠️ This installs to `/usr/local/bin/node`, **not** `/usr/bin/node`. The systemd
unit's `ExecStart` must match, or the service fails to start.

### 4. Under-voltage on an undersized power supply

**Symptom:** none visible. Found only by asking.

```
throttled=0x50005
```

| Bit | Meaning |
|---|---|
| 0 | under-voltage **now** |
| 2 | throttled **now** |
| 16 | under-voltage has occurred |
| 18 | throttling has occurred |

The supply was **5 V 1.0 A**; a Pi 3B wants **2.5 A**, more with a USB device
attached. The Pi was browning out and down-clocking before doing any real work.

**Why it was worth stopping for:** under-voltage during heavy SD writes is how
cards get corrupted, and `npm install` was the next step. An hour of re-flashing
avoided by a two-minute check.

**After swapping the supply:** `throttled=0x50000` — the live flags cleared,
core voltage rose 1.2000 V → 1.3062 V, and it stayed clean through the Node
install and `npm install`.

> `vcgencmd get_throttled` returning anything other than `0x0` deserves a look.
> The low bits are *now*; bits 16–19 are *since boot* and only clear on reboot.

### 5. ⚠️ A CSS rule made login appear broken — self-inflicted

**Symptom:** "I click Sign in and nothing happens." Meanwhile the server logged
**eight successful logins**, four of them within 30 seconds.

**Cause:** the `hidden` attribute works only because the browser's default
stylesheet says `[hidden] { display: none }`. **Any author rule that sets
`display` overrides it.** The redesign introduced:

```css
.login { display: grid; }
```

So `#login-screen` could never be hidden. Login succeeded, the dashboard
rendered underneath, and the login form stayed painted on top of it —
indistinguishable from a failed login.

The same bug pinned `.camera-overlay` (`display: grid`) and `.camera-badge`
(`display: flex`) permanently on screen.

**Fix:** one line, now carrying a comment explaining why it must not be removed:

```css
[hidden] { display: none !important; }
```

**How it was found:** a real Chromium driven against the live site. The test
output named it precisely, where reading the code had not:

```
FAIL  login screen is GONE after signing in
PASS  dashboard is VISIBLE after signing in    ← it was there all along
```

> **The lesson:** the server logs said login worked; the user said it did not.
> Both were true. When two reliable observations disagree, the fault is in the
> layer nobody is looking at — here, CSS specificity. Any UI framework that
> toggles `.hidden` or the `hidden` attribute needs this rule.

---

## What changed in the code

| Change | Why |
|---|---|
| `[hidden] { display: none !important; }` | Problem 5. Every show/hide in `app.js` depends on it. |
| Rebuilt UI: dark theme, five tabs | The original was functional but plain |
| Jog pad, per-axis homing | Parity with OctoPrint's most-used control |
| Extrude / retract with hotend picker | Filament changes and purging |
| Live temperature chart, server-side history | A failing heater is obvious at a glance; history survives reload |
| Fan / speed / flow sliders, Z babystep | Mid-print tuning |
| `getHistory()` in `monitor.js`, `GET /api/history` | 720 samples ≈ 30 min |
| Node install rewritten in 4 documents | Problem 3 — the published command is broken on this hardware |
| Repo URL corrected to `SovolSmart` | Was pointing at a repository that does not exist |
| `pathToFileURL()` in the test mocks | The POSIX-only guard silently no-opped on Windows |

**New endpoints.** Still an allowlist, never a G-code pass-through: the browser
picks a verb and sends a **number**, the server decides the G-code and clamps
the number.

| Endpoint | G-code | Mid-print |
|---|---|---|
| `/api/control/jog` | `G91` → `G0 <axis><d> F<rate>` → `G90` | ❌ refused |
| `/api/control/home` | `G28 [X Y Z]` | ❌ refused |
| `/api/control/extrude` | `T<n>` → `G91` → `G1 E<d> F300` → `G90` | ❌ refused |
| `/api/control/fan` | `M106 S<0-255>` / `M107` | ✅ allowed |
| `/api/control/feedrate` | `M220 S<10-300>` | ✅ allowed |
| `/api/control/flow` | `M221 S<50-150>` | ✅ allowed |
| `/api/control/babystep` | `M290 Z<±0.5>` | ✅ allowed |

Motion is refused mid-print because it would fight the print for control of the
head. Tuning is allowed because adjusting it mid-print is the entire point.
Extrusion below 170 °C is refused with a clear reason rather than letting
Marlin ignore it silently.

**Always wrap a relative move back to `G90`.** Leaving the firmware in `G91`
silently corrupts the next print, and there is a test asserting the full
three-command sequence.

---

## Remote access

Two layers, deliberately.

**Cloudflare quick tunnel** — a public HTTPS URL with zero setup.

⚠️ **The hostname changes on every restart.** A quick tunnel is anonymous, so
Cloudflare has no account to reserve a name against. Mitigated with an
`announce-tunnel` systemd unit that reads the new URL from the journal after
boot and pushes it to the ntfy topic.

**Tailscale** — `100.127.82.57`, permanent, private, survives reboots. The
better day-to-day answer. Funnel adds a permanent *public* HTTPS name
(`octopi.tail928e81.ts.net`) and is free, but **Serve and Funnel each need
enabling once** in the Tailscale admin console before they work.

⚠️ **`TRUST_PROXY_HTTPS` is a trap.** `true` marks the session cookie `Secure`,
which is correct behind HTTPS — but over plain `http://` on the LAN the browser
then **refuses to store it**, so login silently bounces back. Currently `false`
so both the LAN and tunnel URLs work. Over the tunnel the cookie still travels
inside HTTPS regardless; the flag only governs whether the browser will *also*
send it over plain HTTP.

---

## Verification evidence

**Tests: 50 passing, 0 failing** (was 37; 13 added for the new endpoints,
covering clamping, the `G91`/`G90` wrapper, the cold-extrusion refusal, and
both the mid-print refusals and the mid-print allowances).

**`npm run check` on the Pi:**

```
OctoPrint  (http://localhost:5000)
  ✓ Connected in 476ms — OctoPrint 1.11.2
  ✓ Printer connected. Heaters reported: bed, tool0, tool1
Notifications  (https://ntfy.sh/...)
  ✓ Test notification sent
```

**Real-browser test through the public URL**, phone viewport — login, dashboard
visibility, three heater cards, two nozzles reading *different* values, all
five tabs, six jog buttons, both hotends in the extruder picker, and the chart
sized correctly.

**Power under load:** `0x50000` — no new under-voltage through the Node install
and `npm install`.

---

## Still outstanding

- [ ] **Camera.** The phone answers pings at `192.168.2.143` but **no ports are
      open** — IP Webcam is installed but its server was never started. Needs
      **Start server** tapped.
- [ ] ⚠️ **DHCP reservation for the camera phone.** Its IP will change on its
      own eventually and the camera will die silently weeks later with no
      obvious cause. The most common long-term failure of this setup.
- [ ] **Tailscale Serve and Funnel** — awaiting the one-click enable.
- [ ] **Reboot test.** Not yet run end to end.
- [ ] **Dashboard password.** Currently 8 numeric digits on a public URL.
      Brute force is throttled to 8 attempts per 15 minutes per IP and the
      quick-tunnel hostname is unguessable, but it is thin if the link is ever
      shared.
- [ ] **Sovol BLTouch kit** — still the highest-value upgrade. See
      [07](07-decision-log-and-future-work.md).

---

Back to **[the index](README.md)**
