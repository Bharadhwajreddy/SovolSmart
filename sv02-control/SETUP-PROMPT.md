# First-time setup prompt

Only for a Pi that does **not** already run this app. If yours does, use
`UPDATE-PROMPT.md` instead.

Do the four physical steps in `docs/first-time-setup.md` first (flash the SD
card with WiFi and SSH set in Raspberry Pi Imager's gear menu, boot the Pi,
connect the printer by USB, start IP Webcam on your phone).

Then open Claude Code in this folder and paste everything below the line.

---

I have a Sovol SV02 3D printer and a Raspberry Pi 3 Model B. Set the Pi up as
an OctoPrint server for the printer, then install the dashboard app in this
folder onto it. I am not experienced with Linux — explain in plain language
and tell me clearly when I need to do something physical or in a browser.

**Already done by me:** OctoPi flashed with WiFi, country, hostname and SSH
set in the Imager; card in; Pi powered; printer connected by USB and switched
on; IP Webcam running on my phone.

**Facts:** Pi 3B WiFi is 2.4 GHz only. The OctoPi image is 32-bit (armv7l)
even though the chip is 64-bit capable. The printer is dual extruder, so
OctoPrint should report `tool0`, `tool1` and `bed`. The app is finished and
tested — 61 tests, `npm test` — you are deploying it, not writing it.

**Rules:** never run `dd`, write to a disk, or format anything — the card is
already flashed. Show me destructive commands first. Keep secrets in `.env`
only, never committed. If a step fails, stop and diagnose; every step depends
on the one before. Ask me for values rather than inventing them.

1. **Find the Pi and log in.** Try `octopi.local`, then scan the subnet, then
   ask me to check my router. Ask me for the SSH username and password.

2. **Confirm OctoPrint talks to the printer.** Check the service is running
   and the printer appears as `/dev/ttyUSB0` or `/dev/ttyACM0`. Walk me
   through `http://octopi.local` and the wizard; I will press **Connect**,
   with Baudrate `115200` if `AUTO` fails. **Do not continue until live
   temperatures appear** — nothing downstream can work otherwise.

3. **Get an API key**: Settings → Application Keys → Generate, named
   `sv02-control`. Ask me to paste it.

4. **Install Node.** Node 22 does not run on 32-bit ARM, so use:

   ```bash
   if [ "$(uname -m)" = "aarch64" ]; then MAJOR=22; else MAJOR=20; fi
   curl -fsSL "https://deb.nodesource.com/setup_${MAJOR}.x" | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version
   ```

5. **Copy this folder** to `~/sv02-control` on the Pi, excluding
   `node_modules`, then `npm install` there.

6. **Configure.** Copy `.env.example` to `.env` and fill it in; the comments
   document every setting. Ask me for the dashboard password and camera
   address. Generate `SESSION_SECRET` and an unguessable `NTFY_TOPIC_URL`, and
   tell me the topic name so I can subscribe in the ntfy app.

7. **Check before running**: `npm run check`. All ticks, heaters reading
   `tool0, tool1, bed`. Ask whether the test notification reached my phone.

8. **Run and make permanent.** `npm start`, let me confirm the dashboard.
   Then install `deploy/sv02-control.service` with the right `User=` and
   `WorkingDirectory=`, enable it, **reboot, and verify it comes back alone**.

9. **Remote access.** Install Tailscale on the Pi and tell me how to install
   it on my phone. Verify I can reach the dashboard with phone WiFi off. Do
   not set up port forwarding.

10. **Push to my GitHub** at `https://github.com/Bharadhwajreddy/Printer`,
    branch `main`. Confirm `.env` is not in the commit.

Finish with: the dashboard URL on WiFi, the Tailscale URL, the ntfy topic, and
anything outstanding. Remind me to set a DHCP reservation for my phone so its
address stops changing.
