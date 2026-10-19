import { config } from './config.js';
import { logEvent } from './log.js';
import { fetchSnapshot } from './camera.js';

/**
 * HTTP headers can only carry Latin-1, but these messages contain typographic
 * characters — em dashes and degree signs — which throw when assigned to a
 * header. That only bites when a photo is attached, since that is the case
 * where the text moves out of the body and into a header, so it would have
 * silently killed exactly the alerts that matter most.
 */
function asciiHeader(text) {
  return text
    .replace(/[\u2012-\u2015]/g, '-')   // dashes
    .replace(/[\u2018\u2019]/g, "'")     // quotes
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00b0/g, '')             // 209.8°C -> 209.8C, still clear
    .replace(/[^\x20-\x7E]/g, '')       // anything else a header cannot hold
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Push a notification to ntfy. Deliberately fire-and-forget: a notification
 * failing must never break a print control action or stall the poll loop.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {1|2|3|4|5} [opts.priority] ntfy priority, 5 = max
 * @param {string[]} [opts.tags] ntfy emoji tags, e.g. ['warning']
 */
export async function push({ title, message, priority = 3, tags = [], photo = false }) {
  if (!config.ntfyTopicUrl) return false;

  // Fetched before the send timeout starts, so a slow camera eats into its
  // own budget rather than the notification's.
  const shot = photo && config.attachPhotos ? await fetchSnapshot(5000) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const headers = { Title: asciiHeader(title), Priority: String(priority) };
    if (tags.length) headers.Tags = tags.join(',');
    if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

    // With a photo the body is the image itself, so the text moves into the
    // Message header — that is how ntfy takes an attachment inline.
    if (shot) {
      headers['Content-Type'] = shot.contentType;
      headers.Filename = `printer-${Date.now()}.jpg`;
      headers.Message = asciiHeader(message);
    } else {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }

    const res = await fetch(config.ntfyTopicUrl, {
      method: shot ? 'PUT' : 'POST',
      headers,
      body: shot ? shot.buffer : message,
      signal: controller.signal,
    });

    if (!res.ok) {
      logEvent('warn', 'notify_failed', `ntfy returned HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    logEvent('warn', 'notify_failed', `Could not reach ntfy: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const notifyPrintStarted = (file) =>
  push({ title: 'Print started', message: file || 'A print has started.', tags: ['printer'] });

export const notifyPrintDone = (file, elapsed) =>
  push({
    title: 'Print complete',
    message: `${file || 'Print'} finished${elapsed ? ` in ${elapsed}` : ''}.`,
    priority: 4,
    tags: ['white_check_mark'],
    photo: true,
  });

export const notifyPrintFailed = (file, reason) =>
  push({
    title: 'Print failed',
    message: `${file || 'Print'} stopped: ${reason}`,
    priority: 5,
    tags: ['x'],
    photo: true,
  });

export const notifyAnomaly = (message, paused) =>
  push({
    title: paused ? 'Print auto-paused' : 'Temperature anomaly',
    message,
    priority: 5,
    tags: ['warning', 'fire'],
    photo: true,
  });

export const notifyStalled = (message) =>
  push({
    title: 'Print may have stalled',
    message,
    priority: 5,
    tags: ['warning'],
    photo: true,
  });

export const notifyPrinterOffline = () =>
  push({
    title: 'Printer unreachable',
    message: 'Lost contact with OctoPrint while a print was running.',
    priority: 5,
    tags: ['warning'],
  });
