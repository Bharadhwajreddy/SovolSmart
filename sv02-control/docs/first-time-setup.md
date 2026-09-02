# Getting from a bare SV02 to controlling it from your phone

This starts from nothing and assumes no prior setup. Follow it in order.

There are three separate pieces, and it helps to know what each one does:

```
  SV02 printer
      │ USB cable
  A computer that stays on          ← a Raspberry Pi, or a laptop
      ├── OctoPrint                 ← talks to the printer over USB
      └── SV02 Control (this app)   ← talks to OctoPrint, serves the dashboard
      
  Your phone, running IP Webcam     ← the camera, on the same WiFi
```

**This app does not talk to the printer directly.** It talks to OctoPrint, and
OctoPrint talks to the printer. So OctoPrint has to be working first. If you
skip that, nothing else will work.

---

## Try it right now, with no hardware at all

Before buying anything, you can run the whole dashboard on your own computer
against a **simulated printer**. Nothing is connected; nothing can be damaged.
It is the real app, not a mock-up — the same code that will run on the Pi.

You need Node.js 18+ ([nodejs.org](https://nodejs.org)) and Git. Then:

```bash
cd sv02-control
npm install
```

Create a `.env` file with these six lines:

```
OCTOPRINT_URL=http://localhost:5099
OCTOPRINT_API_KEY=demo-key
APP_PASSWORD=printer123
PHONE_CAMERA_URL=http://localhost:5098
SESSION_SECRET=demo-secret-abcdef0123456789abcdef01
TRUST_PROXY_HTTPS=false
```

Then start the fake printer and fake camera, and run the app:

```bash
node test/mocks/octoprint.mjs &
node test/mocks/camera.mjs &
npm start
```

Open **http://localhost:8088** and log in with `printer123`. You will see a
dual-extruder printer mid-print, and every button works. Stop it all with
`ctrl+c` and by closing the terminal.

This is worth doing first. It tells you whether you like the interface before
you spend anything, and it means that when you do set up real hardware, you
already know what "working" looks like.

---

## Step 0 — Decide which computer

Something has to stay powered on next to the printer, connected by USB.

**A Raspberry Pi is the better choice**, and it is what I would use. It costs
little, draws almost no power, boots straight into a purpose-built OctoPrint
image, and you can leave it running permanently. A Pi 3B, 3B+, 4B or Zero 2 W
all work. You also need a microSD card (16 GB or larger) and a proper power
supply.

**A laptop works** but is a worse fit: it has to stay on and awake with the lid
open or sleep disabled, and installing OctoPrint on it is more work than
flashing a card. Use one if it is what you have, or to try things out before
buying a Pi.

**An old Android phone also works**, via an app called
[Octo4a](https://github.com/feelfreelinux/octo4a). It runs a real OctoPrint on
the phone, connected to the printer with a USB OTG adapter, without rooting it.
If you have a spare phone in a drawer this costs almost nothing. Two caveats:
some phones cannot charge and use USB OTG at the same time, which matters for
something meant to run for days, and it is a smaller community than OctoPi, so
there is less help when something breaks.

### What if you want no extra computer at all?

Your SV02's mainboard is an MKS Robin Nano, which accepts an
[MKS WiFi module](https://github.com/makerbase-mks/MKS-WIFI) — a small ESP8266
board, around the price of a coffee, that plugs onto the board's WiFi header
and lets you send files over WiFi from a browser or phone app.

Be clear about what that does and does not get you. It gives you wireless file
transfer and basic control. It does **not** run OctoPrint, so it does not give
you the camera, the temperature alerts, the auto-pause, the notifications, or
this app — all of which need a real computer running real software. There is
no version of "smart printer with a camera and failure detection" that does not
involve some small computer next to the printer. The WiFi module replaces the
SD card; it does not replace the Pi.

Pick one and follow the matching section in Step 2.

---

## Step 1 — Connect the printer

1. Turn the SV02 off.
2. Plug the USB cable from the printer into the Pi or laptop. Use the cable
   that came with the printer if you still have it.
3. Turn the SV02 on.

One thing worth knowing: some printers feed 5 V back down the USB cable, which
can confuse a Pi about whether it is properly powered. If your Pi behaves
strangely — random reboots, or a lightning-bolt icon — that is the likely
cause. The fix is a USB cable with the power line disconnected, or a small
piece of tape over the 5 V pin. Try it normally first; most setups are fine.

---

## Step 2a — Install OctoPrint on a Raspberry Pi

This is the easy path. You are flashing a ready-made image, not installing
software.

1. On your normal computer, install
   [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Put the microSD card in.
3. In Imager, click **Choose OS** → **Other specific-purpose OS** →
   **3D printing** → **OctoPi** → **stable**.
4. Click **Choose Storage** and pick your SD card.
5. **Before writing, click the gear icon** (or press `ctrl+shift+x`) and set:
   - your **WiFi name, password and country** — miss this and the Pi will
     never come online
   - a **hostname**, e.g. `octopi`
   - **enable SSH**, and set a username and password you will remember
6. Click **Write** and wait.
7. Put the card in the Pi, connect power, and wait 2–3 minutes.
8. On your computer, open **http://octopi.local** in a browser. If that does
   not resolve, find the Pi's IP address in your router's device list and use
   that instead.
9. Work through OctoPrint's setup wizard. Set an OctoPrint username and
   password when it asks.

When the wizard finishes, in the top-left of OctoPrint set **Baudrate** to
`115200` if `AUTO` does not connect, then press **Connect**. The printer's
temperatures should start appearing. **If they do not, stop here and fix it** —
nothing further will work until OctoPrint itself can talk to the printer.

## Step 2b — Install OctoPrint on a laptop

Use this only if you are not using a Pi.

The official instructions differ per operating system and change over time, so
follow [OctoPrint's own download page](https://octoprint.org/download/) rather
than a copy of it here. In short: on Linux you install it into a Python virtual
environment; on Windows there is a guided installer; on either, Docker is an
option.

Whichever route, the finishing line is the same as above: OctoPrint open in a
browser, **Connect** pressed, and live temperatures showing.

Two laptop-specific things:

- Stop it sleeping when the lid closes, or prints will be cut off mid-way.
- Note the address OctoPrint is served on. It is usually
  `http://localhost:5000`.

---

## Step 3 — Get an OctoPrint API key

This app needs a key to be allowed to talk to OctoPrint.

In OctoPrint: **Settings → Application Keys → Generate**, name it
`sv02-control`, and copy the key somewhere safe.

(**Settings → API → Global API Key** also works, but an application key is
better — you can revoke just this one later without breaking anything else.)

---

## Step 4 — Set up the phone camera

1. Install **IP Webcam** from the Play Store.
2. Open it, scroll to the bottom, tap **Start server**.
3. Note the address it shows, e.g. `http://192.168.2.141:8080`.
4. Prop the phone where it can see the print bed, and **keep it on a charger**.

Two settings worth changing inside IP Webcam, or the stream will keep dropping:

- Turn on **Keep screen awake** (or use its background mode).
- Lower the **video resolution** to something like 640×480. A 1080p stream
  over a phone connection is slower and gains you nothing here.

**Then give the phone a fixed address.** It currently has whatever your router
handed out, and that will change — on reboot, or when the lease expires — and
the camera will silently stop working. Set a DHCP reservation in your router
for the phone, or a static IP on the phone itself. This is the single most
common cause of "the camera stopped working" later.

---

## Step 5 — Install Node.js

On the Pi (over SSH: `ssh pi@octopi.local` with the username you set):

```bash
node --version
```

If that errors, or shows anything below v18:

```bash
# The standard OctoPi image is 32-bit (armv7l), and Node 22 dropped 32-bit ARM.
# This picks the newest Node that actually runs on your Pi:
if [ "$(uname -m)" = "aarch64" ]; then MAJOR=22; else MAJOR=20; fi
curl -fsSL "https://deb.nodesource.com/setup_${MAJOR}.x" | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

**Why the version check:** OctoPi ships as a 32-bit system even on a 64-bit
capable Pi, and Node 22 dropped support for 32-bit ARM. Installing Node 22
there fails, or worse, half-installs. Node 20 is the newest that runs on it,
and this app needs 18 or above, so 20 is fine. If `node --version` prints
nothing afterwards, that is the thing that went wrong.

---

## Step 6 — Get this app onto the machine

```bash
# copy the sv02-control folder to the Pi, then:
cd ~/sv02-control
npm install
```

---

## Step 7 — Configure it

```bash
cp .env.example .env
nano .env
```

Fill in five things:

| Setting | What to put |
|---|---|
| `OCTOPRINT_URL` | `http://localhost:5000` if OctoPrint is on this same machine |
| `OCTOPRINT_API_KEY` | the key from Step 3 |
| `APP_PASSWORD` | a password you invent, for logging into this app. Make it long |
| `PHONE_CAMERA_URL` | the address from Step 4, e.g. `http://192.168.2.141:8080` |
| `NTFY_TOPIC_URL` | `https://ntfy.sh/` plus an unguessable name, e.g. `https://ntfy.sh/sv02-k7d2m9x4` |

Also generate a session secret and paste it into `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save with `ctrl+o`, `enter`, then exit with `ctrl+x`.

For the notifications: install the **ntfy** app on your phone and subscribe to
the same topic name you invented. There is no account to make. Anyone who
knows the topic name can read your notifications, so do not call it `sv02`.

---

## Step 8 — Check it before running it

```bash
npm run check
```

This tests everything and tells you exactly what is wrong if something is.
You want to see:

```
OctoPrint  (http://localhost:5000)
  ✓ Connected in 141ms — OctoPrint 1.10.0
  ✓ Printer connected. Heaters reported: tool0, tool1, bed

Camera  (http://192.168.2.141:8080/video)
  ✓ Connected in 109ms — multipart/x-mixed-replace
  ✓ Video is streaming
```

Do not continue until this passes. Every failure it reports names the cause
and the fix.

---

## Step 9 — Run it

```bash
npm start
```

Open `http://octopi.local:8088` (or `http://<the machine's IP>:8088`) from any
device on your WiFi, and log in with `APP_PASSWORD`.

At this point you have a working printer dashboard **on your home network**.

---

## Step 10 — Make it start automatically

Right now it stops when you close the terminal. To make it permanent:

```bash
sudo cp deploy/sv02-control.service /etc/systemd/system/
sudo nano /etc/systemd/system/sv02-control.service
```

Change `User=` and `WorkingDirectory=` to match reality — if you followed
Step 6 exactly on a Pi with the username `pi`, that is:

```
User=pi
WorkingDirectory=/home/pi/sv02-control
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sv02-control
sudo systemctl status sv02-control
```

It now survives reboots. To watch what it is doing: `journalctl -u sv02-control -f`

---

## Step 11 — Reach it from outside the house

Everything so far only works on your own WiFi. For access from anywhere:

**Tailscale is the safest and the easiest.** Install it on the Pi and on your
phone, both signed into the same account, and you reach the app at the Pi's
Tailscale address from anywhere. Nothing is ever exposed to the internet, so
nobody can even attempt to log in.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**Cloudflare Tunnel** if you need a real public URL you can share:

```bash
cloudflared tunnel --url http://localhost:8088
```

**Do not just forward port 8088 on your router.** That puts a login form
directly on the public internet, protected by one password.

---

## What you can do once it is running

- Watch the print live from anywhere, with the camera as the main view
- See both nozzle temperatures and the bed, current against target
- Watch progress, elapsed time and time remaining
- Pause, resume and cancel
- Emergency stop (`M112`) if something is going wrong
- Upload a `.gcode` file and start it printing in one action
- Reprint anything already on the printer without uploading it again
- Home the axes, run auto bed levelling, cool everything down
- Get a phone notification when a print starts, finishes, or fails
- Get alerted, and optionally auto-paused, if a temperature drifts more than
  15 °C from target for over 30 seconds mid-print

---

## If something does not work

**Work backwards through the chain.** The order matters, because each piece
depends on the one before it:

1. Does OctoPrint itself show live temperatures? If not, the problem is the
   USB connection or the baud rate, and nothing else can work yet.
2. Does `npm run check` pass? It will name the failing piece.
3. Does the dashboard load on your home WiFi?
4. Does it load through the tunnel?

Fix the earliest failing step. Fixing a later one first never works.

`npm run check` is the fastest way to find out where you are — run it any time
something seems wrong.
