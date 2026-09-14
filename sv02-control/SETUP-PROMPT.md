# The prompt

Open Claude Code **in this folder**, on a laptop connected to the same WiFi as
the Pi. Then paste everything below the line.

Do the four physical steps in `START-HERE.md` first.

---

I have a Sovol SV02 3D printer and a Raspberry Pi 3 Model B. I want to set the
Pi up as an OctoPrint server for the printer, then install the dashboard app
that is in this folder onto it, so I can watch and control the printer from my
phone from anywhere.

Work through this with me start to finish. I am not experienced with Linux, so
explain what you are doing in plain language, and tell me clearly whenever you
need me to do something physical or something in a web browser.

## What I have already done myself

- Flashed the OctoPi image to an SD card using Raspberry Pi Imager, setting
  the WiFi name, WiFi password, WiFi country, hostname, SSH, and an SSH
  username and password in the Imager's gear menu before writing
- Inserted the card and powered the Pi on
- Connected the printer to the Pi with a USB data cable, printer switched on
- Started the "IP Webcam" app on my Android phone, pointed at the printer

## Facts that matter

- **Raspberry Pi 3 Model B**: its WiFi is 2.4 GHz only. If it never appears on
  the network, that is the first thing to suspect.
- **The OctoPi image is 32-bit (armv7l)** even though the Pi 3B chip is 64-bit
  capable. This breaks the usual Node install — see Step 4.
- **The printer is a dual extruder**, so OctoPrint should report `tool0`,
  `tool1` and `bed`. If only one hotend appears, something is wrong.
- The app in this folder is finished and tested (37 passing tests). You are
  deploying it, not writing it. Read its `README.md` and
  `docs/first-time-setup.md` for detail.

## Rules

- **Never run `dd`, never write to a disk or SD card, never format anything.**
  The card is already flashed. If you believe it needs redoing, tell me and I
  will do it myself with Raspberry Pi Imager.
- Show me any command that deletes, overwrites or reconfigures something, and
  wait for me to agree before running it.
- Never write my passwords or API key into any file except `.env`, which is
  git-ignored. Never commit them.
- If a step fails, stop and diagnose it. Do not continue to the next step
  hoping it will resolve — every step here depends on the one before it.
- Ask me for values you do not have. Do not invent an IP address, a password
  or an API key.

## Step 1 — Find the Pi and log in

Find it on my network: try `octopi.local` first, then scan the local subnet
for a host with port 22 or 80 open, then ask me to check my router's device
list. Ask me for the SSH username and password I set in the Imager.

Confirm you are on the Pi by showing me `uname -a` and `uname -m`.

## Step 2 — Confirm OctoPrint can talk to the printer

**This is the checkpoint that matters most. Everything else depends on it.**

Check the OctoPrint service is running and that the printer shows up as a
serial device (`/dev/ttyUSB0` or `/dev/ttyACM0`).

Then tell me to open `http://octopi.local` in my browser, and walk me through
the setup wizard. I will create an OctoPrint username and password, then press
**Connect** — tell me to set Baudrate to `115200` if `AUTO` fails.

**Do not continue until live temperatures appear in OctoPrint.** If they do
not, diagnose it: wrong serial port, wrong baud rate, printer off, or a
charge-only USB cable.

## Step 3 — Get an OctoPrint API key

Walk me through **Settings → Application Keys → Generate**, named
`sv02-control`. Ask me to paste the key to you.

## Step 4 — Install Node.js (this is where it usually breaks)

**Node 22 does not run on 32-bit ARM and this Pi image is 32-bit.** Installing
Node 22 here fails or half-installs. Use exactly this:

```bash
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

On this Pi that installs Node 20, which is fine — the app needs 18 or newer.
Confirm `node --version` actually prints a version before continuing.

## Step 5 — Copy this folder to the Pi

Copy the whole folder you are running in to the Pi at `~/sv02-control` (scp or
rsync). Exclude `node_modules` if it exists locally — dependencies must be
installed on the Pi itself, since some are architecture-specific.

Then on the Pi: `cd ~/sv02-control && npm install`

## Step 6 — Configure it

Copy `.env.example` to `.env` on the Pi and fill it in. Ask me for anything
you do not have:

| Setting | Value |
|---|---|
| `OCTOPRINT_URL` | `http://localhost:5000` |
| `OCTOPRINT_API_KEY` | the key from Step 3 |
| `APP_PASSWORD` | ask me — this is what I type to log into the dashboard |
| `PHONE_CAMERA_URL` | ask me for my phone's IP Webcam address |
| `NTFY_TOPIC_URL` | `https://ntfy.sh/` plus a random unguessable name you generate |
| `SESSION_SECRET` | generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Tell me the ntfy topic name you generated — I need to subscribe to it in the
ntfy app on my phone to get notifications.

## Step 7 — Verify before running

Run `npm run check` on the Pi and show me the output. It tests the OctoPrint
connection, the API key, whether the printer is actually connected, and the
camera stream.

Every line should be a tick, and the heater list should read `tool0, tool1,
bed`. If anything fails, fix it before continuing — the output names the cause
and the fix.

## Step 8 — Run it, then make it permanent

Start it with `npm start` and tell me which URL to open. Let me confirm I can
log in, see the camera, and see both nozzle temperatures.

Once I confirm, install the systemd service from `deploy/sv02-control.service`
so it starts on boot — correct `User=` and `WorkingDirectory=` for where we
actually put it. Then **reboot the Pi and verify the dashboard comes back on
its own**.

## Step 9 — Access from outside the house

Install Tailscale on the Pi, and tell me how to install it on my phone under
the same account. Verify I can reach the dashboard from my phone with WiFi
turned off.

Do not set up router port forwarding.

## Step 10 — Save it to my GitHub

Make this folder a git repository if it is not already, and push it to
`https://github.com/Bharadhwajreddy/SovolSmart` on branch `main`, including any
fixes we made. Make sure `.env` is not committed — check `.gitignore` covers
it before pushing.

## When you are done

Give me a summary with:

- The dashboard URL on my home WiFi
- The Tailscale URL for outside
- The ntfy topic name to subscribe to
- Anything still outstanding

And remind me to set a **DHCP reservation for my phone** in my router, so its
IP address stops changing and the camera keeps working.
