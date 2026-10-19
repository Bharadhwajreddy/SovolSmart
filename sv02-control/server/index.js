import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import multer from 'multer';

import { config, validateConfig, warnings, ROOT } from './config.js';
import { logEvent, recentEvents, readEventsFromDisk } from './log.js';
import { handleLogin, handleLogout, requireAuth, isAuthenticated } from './auth.js';
import { startMonitor, getSnapshot } from './monitor.js';
import { proxyStream, proxySnapshot } from './camera.js';
import * as octo from './octoprint.js';
import * as gcode from './gcode.js';
import { OctoPrintError } from './octoprint.js';

// --- Boot checks -----------------------------------------------------------

const problems = validateConfig();
if (problems.length) {
  console.error('\nRefusing to start — configuration is incomplete:\n');
  for (const p of problems) console.error(`  * ${p}`);
  console.error('\nCopy .env.example to .env and fill it in. See README.md.\n');
  process.exit(1);
}
for (const w of warnings()) console.warn(`[warn] ${w}`);

fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();
// Behind OctoEverywhere / Cloudflare Tunnel / nginx, so X-Forwarded-* is
// what tells us the real client IP for login throttling.
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// --- Upload handling -------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (/\.(gcode|gco|g)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .gcode, .gco and .g files can be uploaded.'));
  },
});

/** Strip anything path-like or exotic before handing the name to OctoPrint. */
function safeFilename(original) {
  const base = path.basename(original || 'upload.gcode');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length ? cleaned.slice(-100) : 'upload.gcode';
}

// --- Helpers ---------------------------------------------------------------

/**
 * Wrap an async route so a rejected promise becomes a clean JSON error rather
 * than an unhandled rejection.
 */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// --- Public routes ---------------------------------------------------------

app.post('/api/login', handleLogin);
app.post('/api/logout', handleLogout);

app.get('/api/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.get('/api/health', (_req, res) => {
  const snap = getSnapshot();
  res.json({ ok: true, printerState: snap.state, updatedAt: snap.updatedAt });
});

// --- Everything below requires a login ------------------------------------

app.use('/api', requireAuth);

app.get('/api/status', (_req, res) => {
  res.json(getSnapshot());
});

app.get('/api/config', (_req, res) => {
  // Deliberately narrow: the frontend learns whether features exist, never
  // the API key, camera address or any credential.
  res.json({
    cameraConfigured: Boolean(config.cameraUrl),
    notificationsConfigured: Boolean(config.ntfyTopicUrl),
    autoPause: config.autoPauseOnAnomaly,
    thresholdC: config.tempDeviationC,
    holdSeconds: config.tempDeviationSeconds,
    pollIntervalMs: config.pollIntervalMs,
  });
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const events = recentEvents(limit);
  // After a restart the in-memory ring is empty; fall back to the file.
  res.json({ events: events.length ? events : readEventsFromDisk(limit) });
});

// --- Camera ----------------------------------------------------------------

app.get('/api/camera/stream', route(proxyStream));
app.get('/api/camera/snapshot', route(proxySnapshot));

// --- Print controls --------------------------------------------------------

app.post('/api/control/pause', route(async (req, res) => {
  const action = req.body?.action === 'resume' ? 'resume' : 'pause';
  if (action === 'resume') await octo.resumePrint();
  else await octo.pausePrint();
  logEvent('info', `print_${action}_requested`, `User requested ${action}.`);
  res.json({ ok: true, action });
}));

app.post('/api/control/cancel', route(async (_req, res) => {
  await octo.cancelPrint();
  logEvent('warn', 'print_cancel_requested', 'User cancelled the print.');
  res.json({ ok: true });
}));

app.post('/api/control/emergency-stop', route(async (_req, res) => {
  // M112 halts the firmware immediately. The board stays halted until it is
  // reset, so the serial link must be re-established afterwards — that is
  // expected, not an error, and is surfaced to the UI as `reconnect`.
  await octo.sendCommand('M112');
  logEvent('error', 'emergency_stop', 'EMERGENCY STOP (M112) sent by user.');
  res.json({
    ok: true,
    reconnect: true,
    message: 'M112 sent. The printer firmware is halted and must be power-cycled or reconnected.',
  });
}));

app.post('/api/control/reconnect', route(async (req, res) => {
  const { port, baudrate } = req.body || {};
  await octo.connectPrinter(port, baudrate);
  logEvent('info', 'reconnect',
    `Reconnect requested${port ? ` on ${port}` : ''}${baudrate ? ` at ${baudrate}` : ''}.`);
  res.json({ ok: true });
}));

/**
 * Why the printer is offline, in terms that point at a fix.
 *
 * "Offline" covers two very different faults — the machine cannot see the
 * printer, or it can see it but nothing has opened the link — and they need
 * opposite responses. Guessing between them is most of the frustration of
 * setting this up.
 */
app.get('/api/diagnostics', route(async (_req, res) => {
  const snap = getSnapshot();
  try {
    const serial = await octo.serialDiagnostics();
    return res.json({ state: snap.state, octoprint: 'reachable', ...serial });
  } catch (err) {
    // Could not even ask OctoPrint — so the fault is before the serial layer.
    return res.json({
      state: snap.state,
      octoprint: 'unreachable',
      verdict: 'no-octoprint',
      hint: `${err.message} The dashboard is running, but it cannot reach OctoPrint itself. `
        + 'Check OCTOPRINT_URL and that the OctoPrint service is running.',
      ports: [],
      baudrates: [],
    });
  }
}));

app.post('/api/control/temperature', route(async (req, res) => {
  const { target, value } = req.body || {};
  const celsius = Number(value);

  if (!Number.isFinite(celsius) || celsius < 0) {
    return res.status(400).json({ error: 'Temperature must be a number of degrees.' });
  }

  if (target === 'bed') {
    if (celsius > 120) return res.status(400).json({ error: 'Bed temperature must be 120 °C or less.' });
    await octo.setBedTemp(celsius);
  } else if (/^tool\d+$/.test(String(target))) {
    if (celsius > 260) return res.status(400).json({ error: 'Nozzle temperature must be 260 °C or less.' });
    await octo.setToolTemp(celsius, target);
  } else {
    return res.status(400).json({ error: 'target must be "bed" or a tool such as "tool0".' });
  }

  logEvent('info', 'temp_set', `Set ${target} target to ${celsius}°C.`);
  return res.json({ ok: true });
}));

// Maintenance G-code. Deliberately a fixed allowlist rather than a
// pass-through: this app is reachable from the internet, and arbitrary
// G-code from a browser is a much bigger blast radius than these five.
const MAINTENANCE_COMMANDS = {
  home: { gcode: ['G28'], label: 'Home all axes', blockedWhilePrinting: true },
  level: { gcode: ['G28', 'G29'], label: 'Auto bed level (needs a probe fitted)', blockedWhilePrinting: true },
  save: { gcode: ['M500'], label: 'Save settings to EEPROM', blockedWhilePrinting: true },
  motorsOff: { gcode: ['M18'], label: 'Release the motors', blockedWhilePrinting: true },
  cooldown: { gcode: ['M104 S0', 'M140 S0'], label: 'Turn off all heaters', blockedWhilePrinting: false },
};

app.get('/api/control/commands', (_req, res) => {
  res.json({
    commands: Object.entries(MAINTENANCE_COMMANDS).map(([id, def]) => ({
      id,
      label: def.label,
      gcode: def.gcode,
      blockedWhilePrinting: def.blockedWhilePrinting,
    })),
  });
});

app.post('/api/control/command', route(async (req, res) => {
  const command = MAINTENANCE_COMMANDS[req.body?.id];
  if (!command) {
    return res.status(400).json({ error: 'Unknown command.' });
  }

  const snap = getSnapshot();
  if (command.blockedWhilePrinting && (snap.state === 'printing' || snap.state === 'paused')) {
    return res.status(409).json({ error: `"${command.label}" is not safe to run during a print.` });
  }
  if (snap.state === 'offline') {
    return res.status(503).json({ error: 'The printer is offline.' });
  }

  await octo.sendCommand(command.gcode);
  logEvent('info', 'maintenance', `${command.label} (${command.gcode.join(', ')})`);
  return res.json({ ok: true, ran: command.gcode });
}));

// --- Layer view ------------------------------------------------------------
//
// Indexing walks the whole file, so it can take a few seconds on a Pi for a
// large print. It happens once per file and is then cached.

app.get('/api/gcode/index', route(async (req, res) => {
  const filePath = typeof req.query.file === 'string' ? req.query.file : getSnapshot().job?.path;
  if (!filePath) return res.status(400).json({ error: 'No file is selected.' });

  const index = await gcode.ensureIndexed(filePath);
  return res.json({ file: filePath, ...gcode.summary(index) });
}));

app.get('/api/gcode/layer', route(async (req, res) => {
  const snap = getSnapshot();
  const filePath = typeof req.query.file === 'string' ? req.query.file : snap.job?.path;
  if (!filePath) return res.status(400).json({ error: 'No file is selected.' });

  // Without an explicit layer, follow the print: locate it from the byte
  // offset OctoPrint has reached.
  const requested = Number(req.query.layer);
  const layerIndex = Number.isFinite(requested)
    ? requested
    : await gcode.layerAtFilepos(filePath, snap.job?.filepos);

  const layer = await gcode.getLayer(filePath, layerIndex);
  if (!layer) return res.status(404).json({ error: 'That layer does not exist.' });

  return res.json({ file: filePath, ...layer });
}));

app.get('/api/gcode/lines', route(async (req, res) => {
  const snap = getSnapshot();
  const filePath = typeof req.query.file === 'string' ? req.query.file : snap.job?.path;
  if (!filePath) return res.status(400).json({ error: 'No file is selected.' });

  const at = Number.isFinite(Number(req.query.filepos))
    ? Number(req.query.filepos)
    : snap.job?.filepos;

  return res.json({ file: filePath, ...(await gcode.linesAround(filePath, at)) });
}));

// --- Direct G-code ---------------------------------------------------------
//
// Unlike the maintenance buttons, which run a fixed allowlist, this sends
// whatever is typed. That is the point of it — but it means anyone past the
// login can drive the printer directly, so every command is logged, and the
// genuinely dangerous ones have to be confirmed explicitly rather than
// arriving by a stray keypress.

/** Commands that can damage the machine, lose a print, or rewrite firmware. */
const DANGEROUS = [
  { re: /^M112\b/i, why: 'Emergency stop — halts the firmware until it is reset.' },
  { re: /^M502\b/i, why: 'Resets all settings to factory defaults.' },
  { re: /^M303\b/i, why: 'PID autotune — heats the nozzle hard for several minutes.' },
  { re: /^M997\b/i, why: 'Starts a firmware update.' },
  { re: /^M999\b/i, why: 'Restarts the firmware after a halt.' },
  { re: /^G29\b/i, why: 'Bed levelling probe — moves the head across the bed.' },
  { re: /^G28\b/i, why: 'Homes the axes, which moves the head to the limits.' },
  { re: /^M140\s*S([2-9]\d\d|1[3-9]\d)/i, why: 'A bed temperature above 120 °C.' },
  { re: /^M104\s*S([3-9]\d\d|2[7-9]\d)/i, why: 'A nozzle temperature above 260 °C.' },
  { re: /^M109\s*S([3-9]\d\d|2[7-9]\d)/i, why: 'A nozzle temperature above 260 °C.' },
];

function riskOf(command) {
  return DANGEROUS.find((d) => d.re.test(command.trim())) || null;
}

app.post('/api/gcode/send', route(async (req, res) => {
  const raw = typeof req.body?.command === 'string' ? req.body.command.trim() : '';

  if (!raw) return res.status(400).json({ error: 'Type a command first.' });
  if (raw.length > 200) return res.status(400).json({ error: 'That command is too long.' });
  if (/[\r\n]/.test(raw)) {
    return res.status(400).json({ error: 'Send one command at a time.' });
  }

  const snap = getSnapshot();
  if (snap.state === 'offline') {
    return res.status(503).json({ error: 'The printer is offline.' });
  }

  const risk = riskOf(raw);
  if (risk && req.body?.confirmed !== true) {
    // The UI asks, then resends with confirmed: true.
    return res.status(409).json({ error: risk.why, needsConfirmation: true, command: raw });
  }

  await octo.sendCommand(raw);
  logEvent(risk ? 'warn' : 'info', 'gcode_sent', `Sent: ${raw}`, { risky: Boolean(risk) });

  return res.json({
    ok: true,
    sent: raw,
    // OctoPrint's REST API accepts commands but does not return what the
    // printer says back; that only comes over its push socket. Say so rather
    // than leave an empty reply looking like a failure.
    note: 'Sent. The printer does not reply over this API — watch the temperatures or the log for the effect.',
  });
}));

// --- Stored files ----------------------------------------------------------

app.get('/api/files', route(async (_req, res) => {
  res.json({ files: await octo.listFiles() });
}));

app.post('/api/files/print', route(async (req, res) => {
  const filePath = req.body?.path;
  if (typeof filePath !== 'string' || !filePath.length) {
    return res.status(400).json({ error: 'A file path is required.' });
  }

  const snap = getSnapshot();
  if (snap.state === 'printing' || snap.state === 'paused') {
    return res.status(409).json({ error: 'A print is already running. Cancel it first.' });
  }

  await octo.selectFile(filePath, true);
  logEvent('info', 'print_from_library', `Started ${filePath} from stored files.`);
  return res.json({ ok: true });
}));

app.delete('/api/files', route(async (req, res) => {
  const filePath = req.body?.path;
  if (typeof filePath !== 'string' || !filePath.length) {
    return res.status(400).json({ error: 'A file path is required.' });
  }

  const snap = getSnapshot();
  if (snap.job?.file && (snap.state === 'printing' || snap.state === 'paused')) {
    return res.status(409).json({ error: 'Cannot delete files while a print is running.' });
  }

  await octo.deleteFile(filePath);
  logEvent('info', 'file_deleted', `Deleted ${filePath}.`);
  return res.json({ ok: true });
}));

// --- Upload ----------------------------------------------------------------

app.post('/api/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than the 250 MB limit.'
          : err.message || 'Upload failed.';
      return res.status(400).json({ error: message });
    }
    next();
  });
}, route(async (req, res) => {
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: 'No file was received.' });
  }

  const startNow = req.body?.print === 'true' || req.body?.print === true;
  const filename = safeFilename(req.file.originalname);

  // Refuse to start a second print on top of a running one; OctoPrint would
  // reject it anyway, but this gives a clearer message sooner.
  const snap = getSnapshot();
  if (startNow && (snap.state === 'printing' || snap.state === 'paused')) {
    return res.status(409).json({
      error: 'A print is already running. Cancel it first, or upload without starting.',
    });
  }

  const result = await octo.uploadFile(req.file.buffer, filename, startNow);
  logEvent('info', 'file_uploaded', `Uploaded ${filename}${startNow ? ' and started printing' : ''}.`, {
    bytes: req.file.buffer.length,
  });

  return res.json({
    ok: true,
    filename,
    started: startNow,
    octoprint: result?.files?.local?.name ? { name: result.files.local.name } : null,
  });
}));

// --- Static frontend -------------------------------------------------------

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// SPA fallback: any non-API path serves the shell, which decides between the
// login screen and the dashboard based on GET /api/session.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// --- Error handling --------------------------------------------------------

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown endpoint.' });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  if (err instanceof OctoPrintError) {
    logEvent('warn', 'octoprint_error', err.message);
    return res.status(err.offline ? 503 : err.status || 502).json({
      error: err.message,
      printerOffline: err.offline,
    });
  }

  logEvent('error', 'unhandled', err?.message || String(err));
  return res.status(500).json({ error: 'Something went wrong on the server.' });
});

// --- Start -----------------------------------------------------------------

const server = app.listen(config.port, () => {
  logEvent('info', 'startup', `Listening on port ${config.port}, OctoPrint at ${config.octoprintUrl}`);
  startMonitor();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logEvent('info', 'shutdown', `Received ${signal}, shutting down.`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck MJPEG connection.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  logEvent('error', 'unhandled_rejection', reason?.message || String(reason));
});
