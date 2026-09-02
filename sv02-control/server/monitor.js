import { config } from './config.js';
import { logEvent } from './log.js';
import * as octo from './octoprint.js';
import * as notify from './notify.js';

/**
 * Single background poller. Every browser tab reads this one cached snapshot
 * instead of triggering its own OctoPrint request, so ten open tabs still
 * mean one request every 2.5s rather than ten.
 */

/** @type {{state: string, printer: object|null, job: object|null, error: string|null, updatedAt: string|null}} */
let snapshot = {
  state: 'connecting',
  printer: null,
  job: null,
  error: null,
  updatedAt: null,
};

/**
 * Anomaly tracking, keyed by OctoPrint's own sensor name ('tool0', 'tool1',
 * 'bed'). Discovered from the reported temperatures rather than hardcoded:
 * the SV02 is a dual-extruder machine, so how many hotends exist depends on
 * the printer and its firmware, not on an assumption made here.
 *
 * @type {Map<string, number>} sensor key -> epoch ms it first went out of range
 */
const deviationSince = new Map();

/** @type {Set<string>} sensors already alerted on, so one fault doesn't spam. */
const alertedSensors = new Set();

/** Non-sensor alert latches. */
const alerted = { offline: false };

let previousState = null;
let previousFile = null;
let running = false;
let timer = null;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Discover which heaters this printer actually has, from what OctoPrint
 * reports rather than from an assumption. The SV02 is dual-extruder, so
 * `tool1` is expected — but a single-hotend conversion or a firmware that
 * only reports one tool works with the same code.
 *
 * Sorted so tools come before the bed, and tool0 before tool1.
 *
 * @returns {{key: string, label: string, kind: 'tool'|'bed', reading: object}[]}
 */
function listSensors(printer) {
  const temps = printer?.temperature || {};

  return Object.keys(temps)
    .filter((key) => /^(tool\d+|bed)$/.test(key) && temps[key] && typeof temps[key] === 'object')
    .sort((a, b) => {
      if (a === 'bed') return 1;
      if (b === 'bed') return -1;
      return a.localeCompare(b, undefined, { numeric: true });
    })
    .map((key) => ({
      key,
      kind: key === 'bed' ? 'bed' : 'tool',
      label: sensorLabel(key, temps),
      reading: temps[key],
    }));
}

/** Human label: a lone hotend is just "Nozzle"; two become "Nozzle 1"/"Nozzle 2". */
function sensorLabel(key, temps) {
  if (key === 'bed') return 'Bed';
  const toolCount = Object.keys(temps).filter((k) => /^tool\d+$/.test(k)).length;
  if (toolCount <= 1) return 'Nozzle';
  return `Nozzle ${Number(key.replace('tool', '')) + 1}`;
}

/**
 * Check one sensor for a sustained deviation from its target.
 *
 * A target of 0 means "heater off" — deviation is meaningless there (a hot
 * nozzle cooling down after a print would otherwise fire constantly), so
 * those are skipped.
 */
function checkSensor(key, label, reading, now) {
  const actual = reading?.actual;
  const target = reading?.target;

  if (!Number.isFinite(actual) || !Number.isFinite(target) || target <= 0) {
    deviationSince.delete(key);
    alertedSensors.delete(key);
    return null;
  }

  const delta = Math.abs(actual - target);

  if (delta <= config.tempDeviationC) {
    // Recovered. Reset so a future fault can alert again.
    if (deviationSince.has(key) && alertedSensors.has(key)) {
      logEvent('info', 'temp_recovered', `${label} temperature returned to normal (${actual.toFixed(1)}°C, target ${target}°C)`);
    }
    deviationSince.delete(key);
    alertedSensors.delete(key);
    return null;
  }

  if (!deviationSince.has(key)) {
    deviationSince.set(key, now);
    return null;
  }

  const heldSeconds = (now - deviationSince.get(key)) / 1000;
  if (heldSeconds < config.tempDeviationSeconds || alertedSensors.has(key)) return null;

  alertedSensors.add(key);
  return {
    key,
    label,
    actual,
    target,
    delta,
    heldSeconds: Math.round(heldSeconds),
    message: `${label} is ${actual.toFixed(1)}°C but should be ${target}°C — off by ${delta.toFixed(1)}°C for ${Math.round(heldSeconds)}s.`,
  };
}

async function handleAnomaly(anomaly) {
  let paused = false;

  if (config.autoPauseOnAnomaly) {
    try {
      await octo.pausePrint();
      paused = true;
      logEvent('warn', 'auto_paused', `Auto-paused the print: ${anomaly.message}`, { anomaly });
    } catch (err) {
      logEvent('error', 'auto_pause_failed', `Could not auto-pause: ${err.message}`, { anomaly });
    }
  }

  logEvent('warn', 'temp_anomaly', anomaly.message, {
    sensor: anomaly.key,
    actual: anomaly.actual,
    target: anomaly.target,
    deltaC: Number(anomaly.delta.toFixed(1)),
    heldSeconds: anomaly.heldSeconds,
    autoPaused: paused,
  });

  await notify.notifyAnomaly(
    paused ? `${anomaly.message} The print has been paused.` : anomaly.message,
    paused,
  );
}

/** Fire start/complete/fail notifications on state transitions. */
async function handleStateChange(state, job) {
  if (state === previousState) return;

  const file = job?.job?.file?.name || previousFile;
  const from = previousState;
  previousState = state;

  // First poll after boot: record the state, don't announce it.
  if (from === null) return;

  // 'connecting' is a transient step OctoPrint passes through, not an outcome.
  // Announcing it would report a healthy print as having stopped.
  if (state === 'connecting') return;

  if (state === 'printing') {
    // paused -> printing is a resume, not a new print, and above all it is
    // not the end of a print: it must not fall through to the stopped branch.
    if (from === 'paused') {
      logEvent('info', 'print_resumed', `Print resumed: ${file || 'unknown file'}`);
    } else {
      logEvent('info', 'print_started', `Print started: ${file || 'unknown file'}`);
      await notify.notifyPrintStarted(file);
    }
  } else if (state === 'paused') {
    logEvent('info', 'print_paused', `Print paused: ${file || 'unknown file'}`);
  } else if (state === 'error') {
    logEvent('error', 'printer_error', `Printer reported an error while on ${file || 'unknown file'}`);
    await notify.notifyPrintFailed(file, 'the printer reported an error');
  } else if (from === 'printing' || from === 'paused') {
    // Left an active print. OctoPrint reports completion via job.progress.
    const completed = job?.progress?.completion;
    const elapsed = formatDuration(job?.progress?.printTime);

    if (state === 'offline') {
      logEvent('error', 'print_interrupted', `Lost contact with the printer during ${file || 'a print'}`);
      await notify.notifyPrinterOffline();
    } else if (Number.isFinite(completed) && completed >= 99.5) {
      logEvent('info', 'print_done', `Print complete: ${file || 'unknown file'}${elapsed ? ` (${elapsed})` : ''}`);
      await notify.notifyPrintDone(file, elapsed);
    } else {
      logEvent('warn', 'print_stopped', `Print stopped early: ${file || 'unknown file'} at ${Number.isFinite(completed) ? completed.toFixed(1) : '?'}%`);
      await notify.notifyPrintFailed(file, `it stopped at ${Number.isFinite(completed) ? completed.toFixed(1) : '?'}%`);
    }
  }
}

async function poll() {
  const now = Date.now();

  try {
    // Fetch together; a failure in either is handled by the shared catch.
    const [printer, job] = await Promise.all([octo.getPrinter(), octo.getJob()]);
    const state = octo.deriveState(printer, job);

    snapshot = { state, printer, job, error: null, updatedAt: new Date().toISOString() };

    if (alerted.offline) {
      alerted.offline = false;
      logEvent('info', 'octoprint_back', 'Reconnected to OctoPrint.');
    }

    await handleStateChange(state, job);
    if (job?.job?.file?.name) previousFile = job.job.file.name;

    // Anomaly detection only matters mid-print; a cold printer isn't a fault.
    if (state === 'printing') {
      for (const sensor of listSensors(printer)) {
        const anomaly = checkSensor(sensor.key, sensor.label, sensor.reading, now);
        if (anomaly) await handleAnomaly(anomaly);
      }
    } else {
      deviationSince.clear();
      alertedSensors.clear();
    }
  } catch (err) {
    const wasPrinting = snapshot.state === 'printing' || snapshot.state === 'paused';

    snapshot = {
      state: 'offline',
      printer: null,
      job: null,
      error: err.message,
      updatedAt: new Date().toISOString(),
    };

    if (!alerted.offline) {
      alerted.offline = true;
      logEvent('error', 'octoprint_unreachable', err.message);
      if (wasPrinting) await notify.notifyPrinterOffline();
    }

    previousState = 'offline';
  }
}

export function startMonitor() {
  if (running) return;
  running = true;

  const tick = async () => {
    try {
      await poll();
    } catch (err) {
      // poll() handles its own errors; this is the belt-and-braces guard that
      // keeps an unexpected throw from killing the interval permanently.
      logEvent('error', 'monitor_crash', `Poll loop error: ${err.message}`);
    }
    timer = setTimeout(tick, config.pollIntervalMs);
  };

  tick();
}

export function stopMonitor() {
  running = false;
  if (timer) clearTimeout(timer);
}

/** Latest cached snapshot, shaped for the frontend. */
export function getSnapshot() {
  const { state, printer, job, error, updatedAt } = snapshot;

  return {
    state,
    error,
    updatedAt,
    offlineReason: printer?.__disconnected ? printer.reason : error,

    // One entry per heater the printer actually reports, so the dashboard
    // renders two nozzles on a dual-extruder SV02 and one on a single.
    sensors: listSensors(printer).map((sensor) => ({
      key: sensor.key,
      label: sensor.label,
      kind: sensor.kind,
      actual: sensor.reading?.actual ?? null,
      target: sensor.reading?.target ?? null,
      max: sensor.kind === 'bed' ? 120 : 260,
      deviatingSince: deviationSince.has(sensor.key)
        ? new Date(deviationSince.get(sensor.key)).toISOString()
        : null,
      alerting: alertedSensors.has(sensor.key),
    })),
    job: {
      file: job?.job?.file?.name ?? null,
      completion: job?.progress?.completion ?? null,
      printTime: job?.progress?.printTime ?? null,
      printTimeLeft: job?.progress?.printTimeLeft ?? null,
      printTimeText: formatDuration(job?.progress?.printTime),
      printTimeLeftText: formatDuration(job?.progress?.printTimeLeft),
      estimatedTotal: job?.job?.estimatedPrintTime ?? null,
    },
    anomalyWatch: {
      thresholdC: config.tempDeviationC,
      holdSeconds: config.tempDeviationSeconds,
      autoPause: config.autoPauseOnAnomaly,
    },
  };
}
