import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import readline from 'node:readline';

import { config } from './config.js';
import { logEvent } from './log.js';

/**
 * Turns a G-code file into per-layer 2D toolpaths, so the dashboard can draw
 * the shape of the layer being printed and show the nozzle moving along it.
 *
 * How the nozzle position is known without asking the printer:
 * OctoPrint reports `filepos`, the byte offset it has streamed to. Ask the
 * printer directly (M114) and you inject commands into a live print queue,
 * which can stutter it. Byte offset costs nothing and is already in /api/job.
 *
 * Memory matters here — a Pi 3B has 1 GB shared with OctoPrint, and G-code
 * files run to tens of megabytes. So the index holds only a byte range and
 * entry state per layer; the geometry for one layer is parsed on demand by
 * re-reading that slice. A 400-layer index is a few tens of kilobytes.
 */

const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** @type {Map<string, object>} cache key -> index */
const indexes = new Map();
const MAX_CACHED_INDEXES = 3;

const cacheDir = () => path.join(path.dirname(config.logFile), 'gcode-cache');

function localCopyPath(filePath) {
  // Flatten so a nested G-code path cannot escape the cache directory.
  const safe = filePath.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
  return path.join(cacheDir(), safe);
}

/**
 * Download the G-code from OctoPrint to local disk, streaming so a large file
 * never sits in memory. Returns the local path.
 */
async function ensureLocalCopy(filePath) {
  const target = localCopyPath(filePath);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

  fs.mkdirSync(cacheDir(), { recursive: true });

  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `${config.octoprintUrl}/downloads/files/local/${encoded}`;

  const res = await fetch(url, { headers: { 'X-Api-Key': config.octoprintApiKey } });
  if (!res.ok) throw new Error(`Could not download the G-code from OctoPrint (HTTP ${res.status}).`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    throw new Error('That G-code file is too large to preview.');
  }

  const tmp = `${target}.partial`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));

  if (fs.statSync(tmp).size > MAX_FILE_BYTES) {
    fs.unlinkSync(tmp);
    throw new Error('That G-code file is too large to preview.');
  }

  fs.renameSync(tmp, target);
  return target;
}

/** Parse the numeric value of a parameter letter out of one G-code line. */
function param(line, letter) {
  const i = line.indexOf(letter);
  if (i === -1) return null;
  const value = parseFloat(line.slice(i + 1));
  return Number.isFinite(value) ? value : null;
}

/**
 * Walk the whole file once, recording where each layer starts and ends and
 * what the machine state was on entry. Only bookkeeping is kept — not the
 * geometry, which would be far too large to hold for a whole print.
 */
/**
 * How often a line-number checkpoint is recorded while indexing. Mapping a
 * byte offset to a line number otherwise means counting from the start of the
 * file on every poll; with checkpoints it means counting from at most this
 * many lines back. 2000 lines of bookkeeping costs a few KB for a whole print.
 */
const CHECKPOINT_EVERY = 2000;

async function buildIndex(localPath) {
  const layers = [];
  /** @type {{line: number, byte: number}[]} sparse line-number milestones */
  const checkpoints = [{ line: 0, byte: 0 }];
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

  let x = 0;
  let y = 0;
  let z = 0;
  let absolute = true;
  let offset = 0;
  let current = null;
  let sawMove = false;

  const stream = fs.createReadStream(localPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const openLayer = (atZ, startByte) => {
    current = { z: atZ, start: startByte, end: startByte, x0: x, y0: y, absolute };
    layers.push(current);
  };

  let lineNumber = 0;

  for await (const raw of rl) {
    const lineBytes = Buffer.byteLength(raw, 'utf8') + 1; // +1 for the newline
    const lineStart = offset;
    offset += lineBytes;
    lineNumber += 1;
    if (lineNumber % CHECKPOINT_EVERY === 0) checkpoints.push({ line: lineNumber, byte: offset });

    const semi = raw.indexOf(';');
    const line = (semi === -1 ? raw : raw.slice(0, semi)).trim().toUpperCase();
    if (!line) continue;

    if (line.startsWith('G90')) { absolute = true; continue; }
    if (line.startsWith('G91')) { absolute = false; continue; }

    // G92 redefines the current position without moving.
    if (line.startsWith('G92')) {
      const nx = param(line, 'X'); const ny = param(line, 'Y'); const nz = param(line, 'Z');
      if (nx !== null) x = nx;
      if (ny !== null) y = ny;
      if (nz !== null) z = nz;
      continue;
    }

    const isMove = /^G[01](\s|$)/.test(line) || /^G0*[01]\s/.test(line);
    if (!isMove) continue;

    const px = param(line, 'X');
    const py = param(line, 'Y');
    const pz = param(line, 'Z');

    const nextZ = pz === null ? z : (absolute ? pz : z + pz);

    // A Z rise starts a new layer. Falls are ignored: a Z-hop travel move
    // comes straight back down and must not split the layer in two.
    if (nextZ > z + 0.0001) {
      z = nextZ;
      if (sawMove) openLayer(z, lineStart);
    } else if (pz !== null) {
      z = nextZ;
    }

    if (px !== null) x = absolute ? px : x + px;
    if (py !== null) y = absolute ? py : y + py;

    if (px !== null || py !== null) {
      sawMove = true;
      if (!current) openLayer(z, lineStart);
      if (x < bounds.minX) bounds.minX = x;
      if (x > bounds.maxX) bounds.maxX = x;
      if (y < bounds.minY) bounds.minY = y;
      if (y > bounds.maxY) bounds.maxY = y;
    }

    if (current) current.end = offset;
  }

  rl.close();

  if (!layers.length) throw new Error('No printable moves were found in that file.');
  // The last layer runs to the end of the file.
  layers[layers.length - 1].end = offset;

  return { layers, bounds, bytes: offset, checkpoints, lines: lineNumber };
}

/**
 * The G-code around wherever the printer currently is, with the line it is
 * executing marked — a live view of the file as it is consumed.
 *
 * Found by walking forward from the nearest checkpoint rather than from the
 * start of the file, so the cost does not grow with how far into a long print
 * you are.
 */
export async function linesAround(filePath, filepos, before = 14, after = 14) {
  const index = await ensureIndexed(filePath);
  const target = Number.isFinite(filepos) ? filepos : 0;

  // Nearest checkpoint at or before the target.
  let cp = index.checkpoints[0];
  for (const candidate of index.checkpoints) {
    if (candidate.byte <= target) cp = candidate;
    else break;
  }

  const window = [];
  let lineNumber = cp.line;
  let offset = cp.byte;
  let currentLine = null;

  const stream = fs.createReadStream(index.localPath, { encoding: 'utf8', start: cp.byte });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    const start = offset;
    offset += Buffer.byteLength(raw, 'utf8') + 1;
    lineNumber += 1;

    window.push({ n: lineNumber, text: raw.length > 120 ? `${raw.slice(0, 120)}…` : raw, start });
    if (window.length > before + after + 1) window.shift();

    // The printer is inside the line whose byte range contains the offset.
    if (currentLine === null && offset > target) {
      currentLine = lineNumber;
    } else if (currentLine !== null && lineNumber >= currentLine + after) {
      // Stop only once enough of what is coming next has been collected —
      // breaking as soon as the current line was found left it pinned to the
      // bottom of the panel with no upcoming lines visible.
      break;
    }
  }

  rl.close();

  return {
    current: currentLine,
    totalLines: index.lines,
    filepos: target,
    lines: window,
  };
}

/** Index a file, reusing the cached index when the same file comes back. */
export async function ensureIndexed(filePath) {
  const cached = indexes.get(filePath);
  if (cached) return cached;

  const localPath = await ensureLocalCopy(filePath);
  const started = Date.now();
  const index = await buildIndex(localPath);
  index.localPath = localPath;
  index.filePath = filePath;

  logEvent('info', 'gcode_indexed',
    `Indexed ${filePath}: ${index.layers.length} layers in ${Date.now() - started}ms.`);

  // Keep only a few, so a Pi does not accumulate indexes for old prints.
  if (indexes.size >= MAX_CACHED_INDEXES) {
    indexes.delete(indexes.keys().next().value);
  }
  indexes.set(filePath, index);
  return index;
}

/**
 * Parse one layer's geometry by re-reading only its slice of the file.
 *
 * Each segment carries the byte offset it ends at, which is what lets the
 * frontend decide how much of the layer has already been printed.
 */
export async function getLayer(filePath, layerIndex) {
  const index = await ensureIndexed(filePath);
  const layer = index.layers[layerIndex];
  if (!layer) return null;

  const segments = [];
  let x = layer.x0;
  let y = layer.y0;
  let absolute = layer.absolute;
  let offset = layer.start;

  const stream = fs.createReadStream(layer.localPath ?? index.localPath, {
    encoding: 'utf8',
    start: layer.start,
    end: Math.max(layer.start, layer.end - 1),
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    offset += Buffer.byteLength(raw, 'utf8') + 1;

    const semi = raw.indexOf(';');
    const line = (semi === -1 ? raw : raw.slice(0, semi)).trim().toUpperCase();
    if (!line) continue;

    if (line.startsWith('G90')) { absolute = true; continue; }
    if (line.startsWith('G91')) { absolute = false; continue; }
    if (line.startsWith('G92')) {
      const nx = param(line, 'X'); const ny = param(line, 'Y');
      if (nx !== null) x = nx;
      if (ny !== null) y = ny;
      continue;
    }
    if (!/^G0*[01](\s|$)/.test(line)) continue;

    const px = param(line, 'X');
    const py = param(line, 'Y');
    if (px === null && py === null) continue;

    const nx = px === null ? x : (absolute ? px : x + px);
    const ny = py === null ? y : (absolute ? py : y + py);

    // E present and positive means plastic is being laid down; without it the
    // move is a travel, which is drawn differently (or not at all).
    const e = param(line, 'E');
    const extruding = e !== null && (absolute ? true : e > 0);

    segments.push({
      x1: round(x), y1: round(y), x2: round(nx), y2: round(ny),
      e: extruding ? 1 : 0,
      o: offset,
    });

    x = nx;
    y = ny;
  }

  rl.close();

  return {
    layer: layerIndex,
    z: layer.z,
    total: index.layers.length,
    start: layer.start,
    end: layer.end,
    bounds: index.bounds,
    segments,
  };
}

const round = (n) => Math.round(n * 100) / 100;

/** Which layer contains a given byte offset. */
export async function layerAtFilepos(filePath, filepos) {
  const index = await ensureIndexed(filePath);
  if (!Number.isFinite(filepos)) return 0;

  // Binary search — a 1000-layer print would otherwise be scanned every poll.
  let lo = 0;
  let hi = index.layers.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (index.layers[mid].start <= filepos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function summary(index) {
  return {
    layers: index.layers.length,
    bounds: index.bounds,
    bytes: index.bytes,
    heights: index.layers.map((l) => round(l.z)),
  };
}

/** Drop cached files and indexes — used when a print ends. */
export function clearCache() {
  indexes.clear();
  try {
    fs.rmSync(cacheDir(), { recursive: true, force: true });
  } catch {
    // A cache we cannot clear is not worth failing over.
  }
}
