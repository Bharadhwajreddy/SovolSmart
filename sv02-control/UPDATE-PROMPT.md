# Updating the Pi to this version

Your Pi is already running an earlier build. This replaces it, keeping your
`.env` — so your API key, password and camera address are untouched.

Open Claude Code **in this folder** and paste everything below the line.

---

My Raspberry Pi is already running the SV02 Control app and I can reach it. I
have a newer version of the app in this folder and I want to update the Pi to
it, without losing my settings.

Work through this with me and explain what you are doing in plain language.

## What is already true

- The Pi runs OctoPrint and the app, and I reach the dashboard at
  a Tailscale address (tell Claude Code the URL when it asks — it is not
  written down here, because this repository is public)
- The app is installed on the Pi and runs under systemd
- There is a working `.env` on the Pi with my OctoPrint API key, my dashboard
  password, my camera address and my ntfy topic

## Rules

- **Do not overwrite or delete the `.env` on the Pi.** It holds settings I
  cannot easily recreate. Back it up before anything else and restore it if
  anything goes wrong.
- Never run `dd`, never write to a disk, never reflash anything.
- Show me any destructive command before running it.
- If a step fails, stop and tell me. Do not continue.

## Steps

1. **Find and log into the Pi** over SSH. Ask me for the username and password
   if you do not have them.

2. **Back up what is there.** Copy the existing app directory aside (for
   example to `~/sv02-control.backup-<date>`), and copy the `.env` somewhere
   safe on its own. Confirm the backup exists before continuing.

3. **Check what is running now** — `sudo systemctl status sv02-control` — and
   note the service's `WorkingDirectory`, so the new version goes to the same
   place.

4. **Stop the service** so files are not replaced underneath a running
   process: `sudo systemctl stop sv02-control`.

5. **Copy this folder to the Pi**, over the existing install directory but
   **excluding `.env`, `node_modules` and `data/`**. With rsync that is
   something like:

   ```bash
   rsync -av --exclude .env --exclude node_modules --exclude data \
     ./ pi@octopi.local:~/sv02-control/
   ```

   Adjust the username and path to match what step 3 found.

6. **Install dependencies on the Pi**, not locally — some are
   architecture-specific: `cd ~/sv02-control && npm install`.

7. **Add the new settings** to the existing `.env`, without touching what is
   already in it. Compare against `.env.example` and append anything missing.
   The new ones are `ATTACH_PHOTOS` and `STALL_MINUTES`; the defaults are
   fine, so adding them is optional.

8. **Check it before starting**: `npm run check`. Show me the output. Every
   line should be a tick and the heaters should read `tool0, tool1, bed`.

9. **Start it again**: `sudo systemctl start sv02-control`, then
   `sudo systemctl status sv02-control`. Tell me the URL to open and let me
   confirm the dashboard loads and I can log in.

10. **Verify the new features are live.** With a print running I should see:
    - a **This layer** panel drawing the shape of the current layer with a red
      nozzle marker on it
    - a **G-code** panel showing the executing line highlighted
    - a **Send G-code** box

    If no print is running, those panels stay hidden by design — tell me so
    rather than treating it as a fault.

11. **If anything is broken**, restore the backup from step 2 and restart the
    service, then tell me what failed.

## When you are done

Tell me what changed, confirm my `.env` was preserved, and say where the
backup is in case I want to roll back.
