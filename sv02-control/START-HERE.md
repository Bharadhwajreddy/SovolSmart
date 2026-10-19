# Start here

A dashboard for watching and controlling a Sovol SV02 from your phone.

## Already running it on a Pi?

Use **`UPDATE-PROMPT.md`** — it updates an existing install and keeps your
`.env` intact.

## Setting it up for the first time?

Use **`SETUP-PROMPT.md`**, and read `docs/first-time-setup.md`, which starts
from a bare printer.

## Just want to see it, with no hardware?

Runs against a simulated printer on your own laptop. You need
[Node.js 18+](https://nodejs.org). In this folder:

```bash
npm install
```

Create `.env` with:

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

Open **http://localhost:8088**, log in with `printer123`. The simulated print
has a different shape on each layer, so drag the layer slider to watch it
change.

---

## What it does

- **Live camera**, reconnecting by itself when the phone drops off WiFi
- **Live layer view** — the outline of the layer being printed, with the
  nozzle moving along it; scrub to any layer
- **Live G-code** — the file scrolling past, executing line marked
- **Send G-code** — type a command straight to the printer; risky ones ask
  first and everything is logged
- Both nozzle temperatures and the bed, each settable
- Progress, elapsed and remaining time
- Pause, resume, cancel, emergency stop
- Upload and print in one action; reprint without re-uploading
- Home, auto bed level, cool down — unsafe mid-print commands refused
- **Alerts with a photo attached** on start, completion, failure and faults
- **Failure detection**: a temperature off target, or a print that has stopped
  progressing while OctoPrint still says it is printing

## If something goes wrong

Work backwards and fix the earliest failure:

1. Does OctoPrint itself show live temperatures?
2. Does `npm run check` pass?
3. Does the dashboard load on your home WiFi?
4. Does it load from outside?

## What is in this folder

| Path | What it is |
|---|---|
| `START-HERE.md` | this file |
| `UPDATE-PROMPT.md` | prompt to update a Pi that already runs the app |
| `SETUP-PROMPT.md` | prompt for a first-time install |
| `README.md` | full documentation and configuration reference |
| `docs/` | setup guide, and the nozzle-as-probe research |
| `server/` | the backend, including `gcode.js` for the layer and line views |
| `public/` | the dashboard |
| `test/` | 61 end-to-end tests, plus mock printer, camera and ntfy |
| `scripts/check.mjs` | the `npm run check` connection checker |
| `deploy/` | the systemd service file |
| `.env.example` | every setting, explained |
