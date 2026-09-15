# Start here

## What this is

A dashboard for watching and controlling a Sovol SV02 3D printer from your
phone — live camera, temperatures, progress, pause/cancel, upload-and-print,
and an alert if a temperature drifts dangerously mid-print.

## How the pieces fit

```
  SV02 printer
      │  USB cable
  Raspberry Pi
      ├── OctoPrint      talks to the printer over USB
      └── this app       talks to OctoPrint, serves your dashboard

  Your phone (IP Webcam)   the camera, on the same WiFi
```

**This app never talks to the printer directly.** It talks to OctoPrint, and
OctoPrint talks to the printer. So OctoPrint has to work first.

---

## Option A — Try it right now, no hardware needed

See the app working against a simulated printer, on your own laptop, before
touching the Pi. Nothing is connected, nothing can be damaged. This is the
real app, not a mock-up.

You need [Node.js 18+](https://nodejs.org). In this folder:

```bash
npm install
```

Create a file called `.env` containing:

```
OCTOPRINT_URL=http://localhost:5099
OCTOPRINT_API_KEY=demo-key
APP_PASSWORD=printer123
PHONE_CAMERA_URL=http://localhost:5098
SESSION_SECRET=demo-secret-abcdef0123456789abcdef01
TRUST_PROXY_HTTPS=false
```

Then:

```bash
node test/mocks/octoprint.mjs &
node test/mocks/camera.mjs &
npm start
```

Open **http://localhost:8088** and log in with `printer123`.

Try the *Simulate a thermal fault* button under Controls — that shows the
failure detection, which you would otherwise never see without a real fault.

Stop everything with `ctrl+c` and closing the terminal.

---

## Option B — Set it up for real on the Pi

### Do these four things yourself first

Claude Code cannot do them — they are physical, or they involve writing to a
disk where a mistake would wipe the wrong drive.

**1. Flash the SD card.** Install
[Raspberry Pi Imager](https://www.raspberrypi.com/software/) →
**Choose OS** → *Other specific-purpose OS* → *3D printing* → **OctoPi** →
stable. Choose your SD card.

**Before clicking Write, open the gear icon** (`ctrl+shift+x`) and set:
- WiFi name, WiFi password, **and WiFi country**
- Hostname: `octopi`
- **Enable SSH**, with a username and password you will remember

> A Pi 3 Model B has **2.4 GHz WiFi only**. If your router broadcasts 2.4 and
> 5 GHz under one name, the Pi may fail to join it.

**2. Put the card in the Pi and power it on.** Wait 2–3 minutes.

**3. Connect the printer to the Pi with a USB cable**, printer switched on.
It must be a *data* cable — charge-only cables are a common silent failure.

**4. Start IP Webcam on your phone** and note the address it shows.

### Then

Open Claude Code in this folder and paste the prompt from
**`SETUP-PROMPT.md`**. It will do everything else.

---

## If something goes wrong

Work **backwards** through the chain and fix the earliest failure. Fixing a
later step first never works.

1. Does OctoPrint itself show live temperatures? If not, it is the USB cable
   or the baud rate, and nothing else can work yet.
2. Does `npm run check` pass? It names the failing piece and the fix.
3. Does the dashboard load on your home WiFi?
4. Does it load from outside?

`npm run check` is the fastest way to find where you actually are.

---

## What is in this folder

| Path | What it is |
|---|---|
| `START-HERE.md` | this file |
| `SETUP-PROMPT.md` | the prompt to paste into Claude Code |
| `README.md` | full documentation and configuration reference |
| `docs/first-time-setup.md` | the long-form setup guide |
| `docs/nozzle-probe-research.md` | auto bed levelling and nozzle-as-probe options |
| `server/` | the backend |
| `public/` | the dashboard interface |
| `test/` | 56 end-to-end tests, plus the mock printer and camera |
| `scripts/check.mjs` | the `npm run check` connection checker |
| `demo/` | builds a static demo with a simulated printer |
| `deploy/` | the systemd service file |
| `.env.example` | every setting, explained |
