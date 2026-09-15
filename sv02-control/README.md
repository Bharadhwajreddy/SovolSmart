# SV02 Control

A small web app to watch and control a **Sovol SV02** from your phone, anywhere.
It sits in front of OctoPrint and gives you one screen with the camera, the
temperatures, the progress bar, and the buttons that matter.

- **Live camera** from the IP Webcam app on your phone, front and centre, with
  automatic reconnection when the phone drops off WiFi.
- **Live temperatures** for every heater the printer has. The SV02's two
  extruder drives share one nozzle, so you get a nozzle card and a bed card,
  each settable; a printer with independent hotends gets a card per hotend.
  Nothing is hardcoded — the layout comes from OctoPrint's printer profile.
- **Progress** — filename, percentage, elapsed and remaining time.
- **Controls** — pause, resume, cancel (with a confirmation), and an emergency
  stop that sends `M112`.
- **Upload and print** — drop a `.gcode` file in and it uploads and starts.
- **Reprint without re-uploading** — everything already on the printer is
  listed, newest first, with a Print button.
- **Maintenance** — home, auto bed level (`G28` + `G29`), save to EEPROM,
  release motors, cool down. Anything unsafe mid-print is refused.
- **Failure detection** — if a temperature drifts more than 15 °C from target
  for more than 30 seconds mid-print, you get a phone notification, an in-app
  banner, and a line in the log. It can auto-pause too, if you turn that on.
- **Notifications** on print start, completion, failure, and anomalies, via
  [ntfy.sh](https://ntfy.sh) — free, no account needed.
- **Password protected**, because this gets exposed to the internet.

Your OctoPrint API key stays on the server. The browser never sees it, and it
never sees your phone's camera address either — the server relays the video.

---

> **Starting from scratch?** If you do not have OctoPrint running yet, follow
> **[docs/first-time-setup.md](docs/first-time-setup.md)** instead — it starts
> from a bare printer and covers OctoPrint, the Pi, the camera and this app in
> order. The README below assumes OctoPrint is already working.

## What you need

1. A **Sovol SV02** connected to a machine running **OctoPrint** (a Raspberry
   Pi, or a laptop — anything that stays on).
2. The **IP Webcam** app on an Android phone, pointed at the printer.
3. **Node.js 18 or newer** on the same machine as OctoPrint.

Check Node with:

```bash
node --version
```

If that errors or shows something below v18, install it:

```bash
# Raspberry Pi OS / Debian / Ubuntu
# The standard OctoPi image is 32-bit (armv7l), and Node 22 dropped 32-bit ARM.
# This picks the newest Node that actually runs on your Pi:
# NodeSource no longer publishes 32-bit ARM (armhf) packages at all -- its
# setup script exits with "Unsupported architecture: armhf". The standard
# OctoPi image IS armhf, so use Node's own official tarball instead.
# Node 20 is the last major line with official linux-armv7l builds.
if [ "$(uname -m)" = "aarch64" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
else
  V=v20.20.2
  curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-armv7l.tar.xz"
  sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1     --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
  rm /tmp/node.tar.xz
fi
node --version
npm --version
```

---

## Setup

### 1. Get the code onto the machine running OctoPrint

```bash
cd sv02-control
npm install
```

### 2. Get your OctoPrint API key

In OctoPrint's web page: **Settings → Application Keys → Generate**, name it
`sv02-control`, and copy the key. (**Settings → API → Global API Key** also
works, but an application key is safer — you can revoke it on its own.)

### 3. Find your phone's camera address

Open **IP Webcam**, scroll to the bottom, tap **Start server**. The screen
shows an address like `http://192.168.2.141:8080`. Paste that straight into
`PHONE_CAMERA_URL` — if you leave the path off, `/video` is filled in for
you, so both of these are fine:

```
http://192.168.2.141:8080
http://192.168.2.141:8080/video
```

Two things worth doing on the phone, or the stream will keep dropping:

- Give the phone a **static IP** (or a DHCP reservation on your router),
  otherwise the address changes and the app can't find it.
- In IP Webcam's settings turn on **"Keep screen awake"** or use its
  background mode, and keep the phone on a charger.

### 4. Create your configuration

```bash
cp .env.example .env
nano .env
```

Fill in at minimum:

| Variable | What it is |
|---|---|
| `OCTOPRINT_URL` | Where OctoPrint is, e.g. `http://localhost:5000` |
| `OCTOPRINT_API_KEY` | The key from step 2 |
| `APP_PASSWORD` | The password *you* will type to log in. Make it long. |
| `PHONE_CAMERA_URL` | The `/video` URL from step 3 |
| `NTFY_TOPIC_URL` | `https://ntfy.sh/` plus an unguessable name |
| `SESSION_SECRET` | Run the command below and paste the result |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**About the ntfy topic:** anyone who knows the topic name can read your
notifications, so don't use `sv02` — use something like
`sv02-k7d2m9x4-printer`. Then install the **ntfy** app on your phone and
subscribe to that same topic. That's the whole setup; there is no account.

To disable notifications entirely, leave `NTFY_TOPIC_URL` blank.

### 5. Run it

First, confirm this machine can actually reach the printer and the camera:

```bash
npm run check
```

That checks OctoPrint, the API key, whether the printer is connected, the
camera stream, and notifications — and tells you exactly what to fix if
something is wrong. It has to run on the machine that will host the app,
because that is the machine doing the talking. Then:

```bash
npm start
```

Open `http://<the machine's IP>:8088` and log in with `APP_PASSWORD`.

If something is missing from `.env`, the app tells you exactly what and exits
rather than starting up half-broken.

---

## Keeping it running

### systemd (recommended on a Pi)

This starts the app on boot and restarts it if it ever crashes.

```bash
sudo cp deploy/sv02-control.service /etc/systemd/system/
sudo nano /etc/systemd/system/sv02-control.service
```

Change `User=` and `WorkingDirectory=` to match your setup — if you cloned to
`/home/pi/Printer` and your user is `pi`, the defaults are already right. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sv02-control
```

Useful commands afterwards:

```bash
sudo systemctl status sv02-control    # is it running?
journalctl -u sv02-control -f         # watch the logs live
sudo systemctl restart sv02-control   # after editing .env
```

### pm2 (alternative)

```bash
sudo npm install -g pm2
pm2 start server/index.js --name sv02-control
pm2 save
pm2 startup        # run the command it prints
```

### Docker (alternative)

```bash
docker compose up -d
docker compose logs -f
```

`network_mode: host` is set deliberately — the container needs to reach both
OctoPrint and your phone on the LAN.

---

## Getting to it from outside your house

**Do not forward port 8088 on your router.** Use a tunnel instead.

### OctoEverywhere

If you already use OctoEverywhere for OctoPrint, it tunnels OctoPrint
specifically, not arbitrary apps. The simplest arrangement is to reach this
app through a general-purpose tunnel of its own.

### Cloudflare Tunnel (free, and what I'd suggest)

```bash
# arm64 on a 64-bit system, arm on the 32-bit OctoPi image
ARCH=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo arm)
curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" -o cloudflared
sudo mv cloudflared /usr/local/bin/ && sudo chmod +x /usr/local/bin/cloudflared
cloudflared tunnel --url http://localhost:8088
```

That prints a public `https://something.trycloudflare.com` URL. For a
permanent address, make a free Cloudflare account and set up a named tunnel.

### Tailscale (easiest, private)

Install Tailscale on the Pi and on your phone, and reach the app at the Pi's
Tailscale IP. Nothing is ever public, so nobody can even attempt to log in.
This is the safest option if you don't need to share access.

Whichever you pick, keep `TRUST_PROXY_HTTPS=true` so the login cookie is only
sent over HTTPS.

---

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `OCTOPRINT_URL` | `http://localhost:5000` | OctoPrint base URL |
| `OCTOPRINT_API_KEY` | — | **Required.** OctoPrint API key |
| `APP_PASSWORD` | — | **Required.** Login password, 8+ characters |
| `PHONE_CAMERA_URL` | — | MJPEG stream, e.g. `http://192.168.1.50:8080/video` |
| `PHONE_SNAPSHOT_URL` | derived | Still-frame URL; defaults to `/shot.jpg` on the same host |
| `CAMERA_USERNAME` / `CAMERA_PASSWORD` | — | If IP Webcam has a login set |
| `NTFY_TOPIC_URL` | — | ntfy topic; blank disables push |
| `NTFY_TOKEN` | — | Only for private/self-hosted ntfy |
| `TEMP_DEVIATION_C` | `15` | Degrees off target that counts as an anomaly |
| `TEMP_DEVIATION_SECONDS` | `30` | How long it must persist before alerting |
| `AUTO_PAUSE_ON_ANOMALY` | `false` | Pause the print automatically on an anomaly |
| `PORT` | `8088` | Port to listen on |
| `SESSION_SECRET` | random | Signs login cookies; set it or restarts log you out |
| `SESSION_HOURS` | `720` | How long a login lasts (30 days) |
| `TRUST_PROXY_HTTPS` | `true` | Mark the cookie HTTPS-only; keep true behind a tunnel |
| `LOG_FILE` | `./data/events.log` | Where anomalies and events are logged |

---

## How the pieces fit together

```
   Your phone  ──HTTPS──▶  tunnel  ──▶  SV02 Control  ──X-Api-Key──▶  OctoPrint  ──USB──▶  SV02
   (browser)                              (this app)  ──────────────▶  IP Webcam on phone
```

Everything goes through this app. That matters for the camera: your phone's
`192.168.x.x` address is meaningless from outside your house, so the browser
could never load it directly. The server sits on your LAN, so it fetches the
video and relays it down the same connection you're already using.

Some deliberate choices:

- **No frontend build step.** Plain HTML/CSS/JS, served as-is. Nothing to
  compile on a Pi, nothing to break on a Node upgrade, and you can edit the
  UI over SSH and just reload.
- **One poll loop, not one per tab.** The server polls OctoPrint every 2.5s
  and every browser reads that cached snapshot, so five open tabs is still
  one request. It also means anomaly detection runs whether or not a browser
  is open.
- **A log file, not SQLite.** `better-sqlite3` compiles native code, which on
  a Pi is slow to install and a recurring source of breakage. Events are
  newline-delimited JSON in `data/events.log`, rotated at 2 MB, readable with
  `cat` and parseable with `jq`.
- **G-code is an allowlist, not a pass-through.** The maintenance buttons map
  to a fixed set of commands defined in `server/index.js`. This app is
  reachable from the internet behind one password; letting a browser post
  arbitrary G-code to the printer would be a much larger blast radius than
  five known-safe commands.

---

## Tests

There is a full end-to-end suite that fakes OctoPrint and the phone camera, so
it runs anywhere with no printer attached:

```bash
npm test
```

It covers authentication, multi-heater and shared-nozzle sensor handling, pause/resume/
cancel round-trips, `M112`, the G-code allowlist, upload rejection paths, the
camera relay (both still frames and MJPEG), temperature-anomaly detection and
recovery, and OctoPrint going offline mid-print.

The mocks live in `test/mocks/` and can be run on their own if you want to
click around the UI without a printer:

```bash
node test/mocks/octoprint.mjs   # fake printer on :5099
node test/mocks/camera.mjs      # fake phone camera on :5098
```

Point your `.env` at `http://localhost:5099` and `http://localhost:5098/video`,
then `npm start`.

---

## The demo build

`demo/` produces a static, self-contained version of the dashboard that runs
with no server and no printer — useful for showing someone what this does.

```bash
node demo/build.mjs
```

That writes `demo/dist/`:

- `index.html` + assets — for any static host
- `single-file.html` — everything inlined, for hosts that serve one file

`app.js` and `styles.css` are copied verbatim from `public/`, so the demo is
the real interface rather than a mock-up of it; only `index.html` is modified,
to load `demo/mock-backend.js` first. That file stubs `fetch` and
`XMLHttpRequest` and draws a simulated camera frame on a canvas, so every
control behaves as it does against a real printer. It also adds one button
that does not exist in the real app — "Simulate a thermal fault" — since the
failure detection is otherwise invisible without an actual fault.

`demo/dist/` is generated and git-ignored. Nothing in `demo/` is served by the
real app; the Pi serves `public/` only.

**A demo is all a cloud host can be.** Vercel, Netlify and friends run in a
datacentre and cannot reach OctoPrint on `localhost` or your phone on
`192.168.x.x` — both are inside your house. The working app has to run on the
machine next to the printer and be reached through a tunnel, as described
above.

---

## When something goes wrong

**"Printer offline" on the dashboard**
The app is fine; it can't reach OctoPrint. Check `sudo systemctl status
octoprint`, and confirm `OCTOPRINT_URL` is right. The banner shows the actual
reason — connection refused, hostname not found, timeout.

**Camera shows "Camera unreachable"**
The phone is asleep, off WiFi, or IP Webcam isn't running. Also check its IP
hasn't changed. Test from the Pi:

```bash
curl -I http://192.168.1.50:8080/shot.jpg
```

The app retries by itself (2s, 4s, 8s, 16s, then every 20s) and falls back to
still frames if the continuous stream won't hold, so it recovers on its own
once the phone is back.

**"OctoPrint rejected the API key"**
The key is wrong or was revoked. Generate a new one and update `.env`, then
`sudo systemctl restart sv02-control`.

**Login says "Too many failed attempts"**
Eight wrong passwords from one address locks it for 15 minutes. Wait, or
restart the service.

**Upload fails on a big file**
The limit is 250 MB. Over a slow tunnel a large upload can take a while — the
progress bar reflects real progress, so let it finish.

---

## Auto bed levelling and "nozzle as probe"

You asked whether the SV02 can use its nozzle as the probe, the way Prusa
does. Short answer: **not without replacing the toolhead** — but there is a
much easier upgrade that solves the actual problem. The full write-up, with
what Prusa really does and three concrete options ranked by effort, is in
**[docs/nozzle-probe-research.md](docs/nozzle-probe-research.md)**.

---

## Safety

`M112` cuts the heaters and motors instantly and halts the firmware; the
printer then needs a reconnect or a power cycle. That's what the emergency
stop button does, and why it asks first.

More importantly: this app watches temperatures, but **it is not a fire
safety device**. It cannot detect a thermal runaway that the printer's own
firmware misses, and it can't do anything at all if the WiFi is down. Don't
run prints unattended in a house you're not in without a smoke alarm in the
room.

## Licence

MIT.
