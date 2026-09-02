import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MB, keep one previous file
const MEMORY_LIMIT = 200;

/** Most recent events, newest first. Served to the UI without touching disk. */
const recent = [];

function ensureDir() {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
}

function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(config.logFile);
    if (size > MAX_BYTES) fs.renameSync(config.logFile, `${config.logFile}.1`);
  } catch {
    // File does not exist yet — nothing to rotate.
  }
}

/**
 * Append a structured event. Logging must never take the server down, so all
 * disk errors are swallowed after being surfaced on stderr once.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} type   short machine-readable kind, e.g. 'temp_anomaly'
 * @param {string} message human-readable summary
 * @param {object} [data] extra structured detail
 */
export function logEvent(level, type, message, data = {}) {
  const entry = { ts: new Date().toISOString(), level, type, message, ...data };

  recent.unshift(entry);
  if (recent.length > MEMORY_LIMIT) recent.length = MEMORY_LIMIT;

  const line = `[${entry.ts}] ${level.toUpperCase()} ${type}: ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(config.logFile, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`[log] could not write ${config.logFile}: ${err.message}`);
  }
}

/** Newest-first slice of the in-memory ring, for GET /api/events. */
export function recentEvents(limit = 50) {
  return recent.slice(0, Math.max(1, Math.min(limit, MEMORY_LIMIT)));
}

/**
 * Read events back off disk so history survives a restart. Corrupt lines are
 * skipped rather than failing the whole read.
 */
export function readEventsFromDisk(limit = 200) {
  try {
    const lines = fs.readFileSync(config.logFile, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}
