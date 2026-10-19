import { Readable } from 'node:stream';
import { config } from './config.js';
import { logEvent } from './log.js';

/**
 * The phone's IP Webcam server lives on your LAN. When you open this app from
 * outside the house through the tunnel, the browser has no route to that
 * phone — so the stream has to be relayed by this server, which does sit on
 * the same LAN. That also keeps the phone's address and any camera
 * credentials out of the browser entirely.
 */

function upstreamHeaders() {
  const headers = {};
  if (config.cameraUsername || config.cameraPassword) {
    const raw = `${config.cameraUsername}:${config.cameraPassword}`;
    headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
  }
  return headers;
}

/**
 * Relay the continuous MJPEG stream.
 *
 * No response timeout is set: an MJPEG stream is an HTTP response that never
 * ends by design, so aborting on inactivity would kill a healthy feed. The
 * connect phase is bounded instead.
 */
export async function proxyStream(req, res) {
  if (!config.cameraUrl) {
    return res.status(503).json({ error: 'PHONE_CAMERA_URL is not configured.' });
  }

  const controller = new AbortController();
  // Only the initial connection is time-limited.
  const connectTimer = setTimeout(() => controller.abort(), 10000);

  // If the browser navigates away or the tab closes, stop pulling frames from
  // the phone — otherwise the phone keeps encoding video for nobody.
  const onClose = () => controller.abort();
  req.on('close', onClose);

  let upstream;
  try {
    upstream = await fetch(config.cameraUrl, {
      headers: upstreamHeaders(),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(connectTimer);
    req.off('close', onClose);
    if (controller.signal.aborted && !res.writableEnded) {
      // Client hung up during connect; nothing to report.
      return res.end();
    }
    logEvent('warn', 'camera_unreachable', `Camera stream failed: ${err.message}`);
    if (!res.headersSent) {
      return res.status(502).json({ error: `Cannot reach the camera: ${err.message}` });
    }
    return res.end();
  }

  clearTimeout(connectTimer);

  if (!upstream.ok || !upstream.body) {
    req.off('close', onClose);
    logEvent('warn', 'camera_bad_response', `Camera returned HTTP ${upstream.status}`);
    return res.status(502).json({ error: `Camera returned HTTP ${upstream.status}.` });
  }

  res.setHeader(
    'Content-Type',
    upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=--BoundaryString',
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Connection', 'close');

  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => {
    // Phone rebooted, WiFi dropped, app killed. The browser sees the stream
    // end and the frontend's retry loop reconnects.
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => {
    stream.destroy();
    req.off('close', onClose);
  });

  stream.pipe(res);
}

/**
 * Relay a single still frame. Used as a fallback when the continuous stream
 * will not hold, and for the reachability check on the dashboard.
 */
/**
 * Grab one still frame as raw bytes.
 *
 * Shared by the snapshot route and by notifications, which attach a photo so
 * an alert on your phone shows what the printer actually looks like.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string}|null>} null if the
 *   camera is unset or unreachable — callers decide whether that is fatal.
 */
export async function fetchSnapshot(timeoutMs = 8000) {
  const url = config.cameraSnapshotUrl || config.cameraUrl;
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(url, { headers: upstreamHeaders(), signal: controller.signal });
    if (!upstream.ok) return null;

    const buffer = Buffer.from(await upstream.arrayBuffer());
    // A stream URL used as a snapshot returns multipart data, not an image.
    // Better no photo than a corrupt one attached to an alert.
    if (buffer.length < 100 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    return { buffer, contentType: upstream.headers.get('content-type') || 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function proxySnapshot(_req, res) {
  if (!(config.cameraSnapshotUrl || config.cameraUrl)) {
    return res.status(503).json({ error: 'PHONE_CAMERA_URL is not configured.' });
  }
  const shot = await fetchSnapshot();
  if (!shot) return res.status(502).json({ error: 'Cannot reach the camera.' });

  res.setHeader('Content-Type', shot.contentType);
  res.setHeader('Cache-Control', 'no-store');
  return res.end(shot.buffer);
}
