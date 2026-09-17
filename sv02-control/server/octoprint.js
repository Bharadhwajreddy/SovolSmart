import { config } from './config.js';

/**
 * Thrown for anything that stops us getting a useful answer from OctoPrint.
 * `offline` distinguishes "the box isn't answering" (show the offline state)
 * from "OctoPrint answered, but said no" (show the actual error).
 */
export class OctoPrintError extends Error {
  constructor(message, { status = 0, offline = false, body = null } = {}) {
    super(message);
    this.name = 'OctoPrintError';
    this.status = status;
    this.offline = offline;
    this.body = body;
  }
}

const TIMEOUT_MS = 8000;

function describeNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening at ${config.octoprintUrl}. Is OctoPrint running?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve the hostname in OCTOPRINT_URL (${config.octoprintUrl}).`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `No network route to ${config.octoprintUrl}.`;
    case 'ETIMEDOUT':
      return `OctoPrint at ${config.octoprintUrl} did not respond in time.`;
    default:
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return `OctoPrint at ${config.octoprintUrl} did not respond within ${TIMEOUT_MS / 1000}s.`;
      }
      return `Could not reach OctoPrint at ${config.octoprintUrl}: ${err.message}`;
  }
}

/**
 * Low-level OctoPrint request. The API key is attached here and nowhere else,
 * so it never has a path to the browser.
 *
 * @param {string} endpoint path beginning with `/api/...`
 */
export async function octoFetch(endpoint, { method = 'GET', body, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${config.octoprintUrl}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'X-Api-Key': config.octoprintApiKey,
        ...headers,
      },
      body,
    });
  } catch (err) {
    throw new OctoPrintError(describeNetworkError(err), { offline: true });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new OctoPrintError(
        'OctoPrint rejected the API key. Check OCTOPRINT_API_KEY in your .env.',
        { status: response.status, body: parsed },
      );
    }
    if (response.status === 409) {
      // OctoPrint's "printer is not operational" / "already printing" case.
      throw new OctoPrintError(
        parsed?.error || 'The printer is not in a state that allows that command right now.',
        { status: 409, body: parsed },
      );
    }
    throw new OctoPrintError(
      parsed?.error || `OctoPrint returned HTTP ${response.status}.`,
      { status: response.status, body: parsed },
    );
  }

  return parsed;
}

function postJson(endpoint, payload) {
  return octoFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * GET /api/printer.
 *
 * A 409 here is normal and expected: OctoPrint returns it when the printer is
 * disconnected from the serial port. That is "printer offline", not a failure
 * of this app, so it is translated rather than thrown.
 */
export async function getPrinter() {
  try {
    return await octoFetch('/api/printer?exclude=sd');
  } catch (err) {
    if (err instanceof OctoPrintError && err.status === 409) {
      return { __disconnected: true, reason: 'OctoPrint is running but the printer is not connected.' };
    }
    throw err;
  }
}

export const getJob = () => octoFetch('/api/job');
export const getConnection = () => octoFetch('/api/connection');
export const getVersion = () => octoFetch('/api/version');

/**
 * The active printer profile's toolhead: how many extruder drives, and whether
 * they share one nozzle. The SV02 is a 2-in-1-out machine -- two drives feeding
 * a single nozzle with a single heater -- which OctoPrint models as
 * extruder.count = 2 with sharedNozzle = true, and then reports that one heater
 * under both `tool0` and `tool1`.
 */
export async function getToolhead() {
  const data = await octoFetch('/api/printerprofiles');
  const profiles = Object.values(data?.profiles || {});
  const active = profiles.find((p) => p.current) || profiles.find((p) => p.default) || profiles[0];
  const count = Number(active?.extruder?.count);
  return {
    extruders: Number.isInteger(count) && count > 0 ? count : 1,
    sharedNozzle: Boolean(active?.extruder?.sharedNozzle),
  };
}

export const pausePrint = () => postJson('/api/job', { command: 'pause', action: 'pause' });
export const resumePrint = () => postJson('/api/job', { command: 'pause', action: 'resume' });
export const cancelPrint = () => postJson('/api/job', { command: 'cancel' });
export const startPrint = () => postJson('/api/job', { command: 'start' });

/** Send raw G-code, e.g. M112 for emergency stop. */
export const sendCommand = (commands) =>
  postJson('/api/printer/command', { commands: Array.isArray(commands) ? commands : [commands] });

/** Reconnect the serial link after an M112 latches the firmware into halt. */
export const connectPrinter = () => postJson('/api/connection', { command: 'connect' });

/** @param {string} tool OctoPrint tool key, e.g. 'tool0' or 'tool1'. */
export const setToolTemp = (celsius, tool = 'tool0') =>
  postJson('/api/printer/tool', { command: 'target', targets: { [tool]: celsius } });

export const setBedTemp = (celsius) =>
  postJson('/api/printer/bed', { command: 'target', target: celsius });

/**
 * List G-code already stored on OctoPrint, so a file can be reprinted without
 * uploading it again — the common case for an iteration you print repeatedly.
 */
export async function listFiles() {
  const data = await octoFetch('/api/files/local?recursive=true');
  const out = [];

  // The listing is a tree: folders contain `children`.
  const walk = (entries = []) => {
    for (const entry of entries) {
      if (entry.type === 'folder') walk(entry.children);
      else if (entry.type === 'machinecode') {
        out.push({
          name: entry.name,
          path: entry.path,
          size: entry.size ?? null,
          uploaded: entry.date ?? null,
          estimatedPrintTime: entry.gcodeAnalysis?.estimatedPrintTime ?? null,
        });
      }
    }
  };
  walk(data?.files);

  // Newest first: that is almost always the one you want.
  out.sort((a, b) => (b.uploaded ?? 0) - (a.uploaded ?? 0));
  return out;
}

/** Select an already-uploaded file and optionally start printing it. */
export const selectFile = (filePath, startNow) =>
  postJson(`/api/files/local/${filePath.split('/').map(encodeURIComponent).join('/')}`, {
    command: 'select',
    print: Boolean(startNow),
  });

export const deleteFile = (filePath) =>
  octoFetch(`/api/files/local/${filePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'DELETE',
  });

/**
 * Upload a G-code file to OctoPrint's local storage.
 *
 * @param {Buffer} buffer   file contents
 * @param {string} filename original name, already sanitised by the caller
 * @param {boolean} startNow whether to select and immediately print it
 */
export async function uploadFile(buffer, filename, startNow) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  form.append('select', startNow ? 'true' : 'false');
  form.append('print', startNow ? 'true' : 'false');

  // Uploads can be tens of megabytes over a slow tunnel; give them room.
  return octoFetch('/api/files/local', { method: 'POST', body: form, timeoutMs: 180000 });
}

/**
 * Fetch the raw G-code of a stored file, for the visualiser.
 *
 * Capped, because the whole file is held in memory while it is parsed and the
 * Pi has 1 GB. A file too big to visualise is not an error for the print — the
 * dashboard just says so and carries on.
 */
export async function downloadGcode(filePath, maxBytes = 25 * 1024 * 1024) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `${config.octoprintUrl}/downloads/files/local/${encoded}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(url, {
      headers: { 'X-Api-Key': config.octoprintApiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new OctoPrintError(`OctoPrint returned HTTP ${response.status} downloading ${filePath}.`, {
        status: response.status,
      });
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new OctoPrintError(`That file is ${(declared / 1e6).toFixed(0)} MB — too large to visualise.`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new OctoPrintError('That file is too large to visualise.');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collapse OctoPrint's several state sources into one label the UI can render.
 * @returns {'offline'|'error'|'printing'|'paused'|'idle'|'connecting'}
 */
export function deriveState(printer, job) {
  if (!printer || printer.__disconnected) return 'offline';

  const flags = printer.state?.flags || {};
  if (flags.closedOrError || flags.error) return 'error';
  if (flags.printing) return 'printing';
  if (flags.paused || flags.pausing) return 'paused';
  if (flags.cancelling) return 'printing';
  if (!flags.operational) return 'connecting';

  // Operational but idle. If a job is loaded but not running, still idle.
  if (job?.state && /error/i.test(job.state)) return 'error';
  return 'idle';
}
