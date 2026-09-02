/**
 * Connection check. Run this on the machine that will host the app:
 *
 *   npm run check
 *
 * It answers the two questions that account for almost every setup problem:
 * can this machine reach OctoPrint, and can it reach the phone camera?
 * Both are checked from here rather than from your browser, because here is
 * where it matters — the server is what talks to them.
 */
import { config, validateConfig } from '../server/config.js';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

let failures = 0;

async function probe(url, { headers = {}, timeoutMs = 8000, wantBytes = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    let bytes = 0;
    if (wantBytes && res.body) {
      // Read a little of the stream, then stop: an MJPEG response never ends.
      const reader = res.body.getReader();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && bytes < 4096) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      await reader.cancel().catch(() => {});
    }
    return { res, ms, bytes };
  } catch (err) {
    return { err, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function explain(err) {
  const code = err?.cause?.code || err?.code || '';
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return 'Timed out. Usually means a firewall is dropping it, or the address is wrong and nothing answered.';
  }
  switch (code) {
    case 'ECONNREFUSED': return 'Connection refused — the address is right but nothing is listening on that port.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':   return 'Hostname could not be resolved. Try the numeric IP instead of a .local name.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'No route to that address. Is this machine on the same network?';
    default: return err?.message || 'Unknown error.';
  }
}

console.log('\nConfiguration');
const problems = validateConfig();
if (problems.length) {
  for (const p of problems) bad(p);
  failures += problems.length;
} else {
  ok('Required settings are present.');
}

// --- OctoPrint -------------------------------------------------------------

console.log(`\nOctoPrint  (${config.octoprintUrl})`);
{
  const { res, err, ms } = await probe(`${config.octoprintUrl}/api/version`, {
    headers: { 'X-Api-Key': config.octoprintApiKey },
  });

  if (err) {
    bad(`Cannot reach OctoPrint. ${explain(err)}`);
    info('Check OCTOPRINT_URL, and that OctoPrint is running (sudo systemctl status octoprint).');
    failures += 1;
  } else if (res.status === 401 || res.status === 403) {
    bad('Reached OctoPrint, but it rejected the API key.');
    info('Regenerate it under Settings -> Application Keys and update OCTOPRINT_API_KEY.');
    failures += 1;
  } else if (!res.ok) {
    bad(`OctoPrint answered with HTTP ${res.status}.`);
    failures += 1;
  } else {
    const body = await res.json().catch(() => ({}));
    ok(`Connected in ${ms}ms — OctoPrint ${body.server || '(version unknown)'}`);

    // Is the printer itself plugged in and talking?
    const printer = await probe(`${config.octoprintUrl}/api/printer`, {
      headers: { 'X-Api-Key': config.octoprintApiKey },
    });
    if (printer.res?.status === 409) {
      bad('OctoPrint is running, but the printer is not connected to it.');
      info('Turn the SV02 on, check the USB cable, then hit Connect in OctoPrint.');
      failures += 1;
    } else if (printer.res?.ok) {
      const data = await printer.res.json().catch(() => ({}));
      const heaters = Object.keys(data.temperature || {}).filter((k) => /^(tool\d+|bed)$/.test(k));
      ok(`Printer connected. Heaters reported: ${heaters.join(', ') || 'none'}`);
      if (!heaters.includes('tool1')) {
        info('Only one hotend is reported. That is fine — the dashboard adapts.');
      }
    }
  }
}

// --- Camera ----------------------------------------------------------------

console.log(`\nCamera  (${config.cameraUrl || 'not configured'})`);
if (!config.cameraUrl) {
  bad('PHONE_CAMERA_URL is not set.');
  info('Open the IP Webcam app, tap "Start server", and use the address it shows.');
  failures += 1;
} else {
  const headers = {};
  if (config.cameraUsername || config.cameraPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${config.cameraUsername}:${config.cameraPassword}`).toString('base64')}`;
  }

  const stream = await probe(config.cameraUrl, { headers, wantBytes: true });
  if (stream.err) {
    bad(`Cannot reach the camera. ${explain(stream.err)}`);
    info('Is the phone awake, on the same WiFi, and is IP Webcam still running?');
    info('Phones change IP address — give it a static IP or a DHCP reservation.');
    failures += 1;
  } else if (!stream.res.ok) {
    bad(`Camera answered with HTTP ${stream.res.status}.`);
    if (stream.res.status === 401) info('It wants a login — set CAMERA_USERNAME and CAMERA_PASSWORD.');
    failures += 1;
  } else {
    const type = stream.res.headers.get('content-type') || '';
    ok(`Connected in ${stream.ms}ms — ${type.split(';')[0] || 'unknown type'}`);
    if (/multipart/.test(type)) ok(`Video is streaming (${stream.bytes} bytes sampled).`);
    else if (/image/.test(type)) info('That is a single image, not a stream. The app will still work, using still frames.');
    else info(`Unexpected content type: ${type}. Expected multipart/x-mixed-replace.`);
  }

  const snap = await probe(config.cameraSnapshotUrl, { headers });
  if (snap.res?.ok) ok(`Snapshot fallback works (${config.cameraSnapshotUrl}).`);
  else info(`Snapshot fallback unavailable at ${config.cameraSnapshotUrl} — not fatal.`);
}

// --- Notifications ---------------------------------------------------------

console.log(`\nNotifications  (${config.ntfyTopicUrl || 'disabled'})`);
if (!config.ntfyTopicUrl) {
  info('NTFY_TOPIC_URL is not set, so nothing will reach your phone. In-app alerts still work.');
} else {
  const headers = { Title: 'SV02 Control', Priority: '3', 'Content-Type': 'text/plain' };
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

  const { res, err } = await probe(config.ntfyTopicUrl, { headers });
  if (err || !res?.ok) bad(`Could not send a test notification. ${err ? explain(err) : `HTTP ${res.status}`}`);
  else ok('Test notification sent — check your phone.');
}

console.log(
  failures
    ? `\n\x1b[31m${failures} problem(s) found.\x1b[0m Fix the above, then run this again.\n`
    : '\n\x1b[32mAll checks passed.\x1b[0m Start the app with: npm start\n',
);
process.exit(failures ? 1 : 0);
