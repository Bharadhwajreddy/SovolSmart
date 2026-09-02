import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Minimal .env loader. Node 20.6+ has --env-file, but the Pi may be on an
// older runtime and this keeps `npm start` working with no extra flags.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const str = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const num = (key, fallback) => {
  const n = Number(str(key));
  return Number.isFinite(n) && str(key) !== '' ? n : fallback;
};
const bool = (key, fallback = false) => {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
};

// If the user only gave us /video, derive the snapshot endpoint. The Android
// "IP Webcam" app serves both from the same host.
function deriveSnapshot(streamUrl) {
  if (!streamUrl) return '';
  try {
    const u = new URL(streamUrl);
    u.pathname = '/shot.jpg';
    u.search = '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * Accept what the IP Webcam app actually shows you.
 *
 * The app displays a bare `http://192.168.1.50:8080` on its screen, so that
 * is what people paste — but the MJPEG stream lives at `/video`. Rather than
 * fail with an unhelpful error, treat a bare host as meaning the stream.
 * An explicit path is always left alone.
 */
export function normaliseCameraUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.pathname === '' || u.pathname === '/') u.pathname = '/video';
    return u.toString();
  } catch {
    // Not parseable as a URL; hand it back untouched so the error surfaces
    // against the value the user actually set.
    return raw;
  }
}

const cameraUrl = normaliseCameraUrl(str('PHONE_CAMERA_URL'));

export const config = {
  port: num('PORT', 8088),

  octoprintUrl: str('OCTOPRINT_URL', 'http://localhost:5000').replace(/\/+$/, ''),
  octoprintApiKey: str('OCTOPRINT_API_KEY'),

  appPassword: str('APP_PASSWORD'),
  sessionSecret: str('SESSION_SECRET') || crypto.randomBytes(32).toString('hex'),
  sessionHours: num('SESSION_HOURS', 720),
  trustProxyHttps: bool('TRUST_PROXY_HTTPS', true),

  cameraUrl,
  cameraSnapshotUrl: str('PHONE_SNAPSHOT_URL') || deriveSnapshot(cameraUrl),
  cameraUsername: str('CAMERA_USERNAME'),
  cameraPassword: str('CAMERA_PASSWORD'),

  ntfyTopicUrl: str('NTFY_TOPIC_URL'),
  ntfyToken: str('NTFY_TOKEN'),

  tempDeviationC: num('TEMP_DEVIATION_C', 15),
  tempDeviationSeconds: num('TEMP_DEVIATION_SECONDS', 30),
  autoPauseOnAnomaly: bool('AUTO_PAUSE_ON_ANOMALY', false),

  logFile: path.resolve(ROOT, str('LOG_FILE', './data/events.log')),
  uploadDir: path.resolve(ROOT, 'data/uploads'),

  // Server-side poll interval feeding the monitor + the /api/status cache.
  pollIntervalMs: 2500,
};

/**
 * Fatal misconfiguration checks. Better to refuse to boot than to serve a
 * dashboard that silently can't talk to the printer or has no password.
 */
export function validateConfig() {
  const problems = [];
  if (!config.octoprintApiKey || config.octoprintApiKey === 'changeme') {
    problems.push('OCTOPRINT_API_KEY is not set (see .env.example)');
  }
  if (!config.appPassword || config.appPassword === 'changeme') {
    problems.push('APP_PASSWORD is not set, or is still the placeholder');
  } else if (config.appPassword.length < 8) {
    problems.push('APP_PASSWORD must be at least 8 characters');
  }
  if (!config.octoprintUrl) {
    problems.push('OCTOPRINT_URL is not set');
  }
  return problems;
}

export const warnings = () => {
  const list = [];
  if (!config.cameraUrl) list.push('PHONE_CAMERA_URL is not set — the camera panel will show as unavailable.');
  if (!config.ntfyTopicUrl) list.push('NTFY_TOPIC_URL is not set — push notifications are disabled, in-app banners still work.');
  if (!process.env.SESSION_SECRET) list.push('SESSION_SECRET is not set — a random one was generated, so restarting logs you out.');
  return list;
};
