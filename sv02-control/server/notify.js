import { config } from './config.js';
import { logEvent } from './log.js';

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
export async function push({ title, message, priority = 3, tags = [] }) {
  if (!config.ntfyTopicUrl) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: title,
      Priority: String(priority),
    };
    if (tags.length) headers.Tags = tags.join(',');
    if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

    const res = await fetch(config.ntfyTopicUrl, {
      method: 'POST',
      headers,
      body: message,
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
  });

export const notifyPrintFailed = (file, reason) =>
  push({
    title: 'Print failed',
    message: `${file || 'Print'} stopped: ${reason}`,
    priority: 5,
    tags: ['x'],
  });

export const notifyAnomaly = (message, paused) =>
  push({
    title: paused ? 'Print auto-paused' : 'Temperature anomaly',
    message,
    priority: 5,
    tags: ['warning', 'fire'],
  });

export const notifyPrinterOffline = () =>
  push({
    title: 'Printer unreachable',
    message: 'Lost contact with OctoPrint while a print was running.',
    priority: 5,
    tags: ['warning'],
  });
