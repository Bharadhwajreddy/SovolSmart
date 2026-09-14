/**
 * End-to-end tests against the real server, with OctoPrint and the phone
 * camera faked. No printer required.
 *
 *   npm test
 *
 * Exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import * as octoMock from './mocks/octoprint.mjs';
import * as camMock from './mocks/camera.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:8099';
const PASSWORD = 'test-password-123';

let passed = 0;
let failed = 0;
let cookie = '';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}\n      ${err.message}`);
    failed += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

const post = (pathname, payload) =>
  call(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** Poll until the server's cached snapshot reflects a change, or time out. */
async function waitForState(expected, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await call('/api/status');
    if (body.state === expected) return body;
    await sleep(400);
  }
  throw new Error(`state never became "${expected}"`);
}

// --- Boot ------------------------------------------------------------------

console.log('Starting mocks and server…');

const octoServer = await octoMock.start(5099);
const camServer = await camMock.start(5098);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: '8099',
    OCTOPRINT_URL: 'http://localhost:5099',
    OCTOPRINT_API_KEY: 'test-api-key',
    APP_PASSWORD: PASSWORD,
    PHONE_CAMERA_URL: 'http://localhost:5098/video',
    NTFY_TOPIC_URL: '',
    SESSION_SECRET: 'test-secret-not-for-real-use-0000',
    TRUST_PROXY_HTTPS: 'false',
    TEMP_DEVIATION_C: '15',
    TEMP_DEVIATION_SECONDS: '3',
    LOG_FILE: './data/test-events.log',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));

// Wait for it to accept connections.
for (let i = 0; i < 40; i += 1) {
  try {
    await fetch(`${BASE}/api/health`);
    break;
  } catch {
    await sleep(250);
  }
}

function shutdown(code) {
  server.kill('SIGTERM');
  octoServer.close();
  camServer.close();
  setTimeout(() => process.exit(code), 300);
}

// --- Tests -----------------------------------------------------------------

try {
  console.log('\nAuthentication');

  await test('protected routes reject anonymous callers', async () => {
    const { status } = await call('/api/status');
    assert.equal(status, 401);
  });

  await test('a wrong password is rejected', async () => {
    const { status, body } = await post('/api/login', { password: 'wrong' });
    assert.equal(status, 401);
    assert.match(body.error, /Incorrect password/);
  });

  await test('the right password signs in', async () => {
    const { status } = await post('/api/login', { password: PASSWORD });
    assert.equal(status, 200);
    assert.ok(cookie.startsWith('sv02_session='), 'expected a session cookie');
  });

  console.log('\nCamera address handling');

  await test('a bare host is treated as the video stream', async () => {
    const { normaliseCameraUrl } = await import('../server/config.js');
    // What the IP Webcam app displays is a bare host; people paste that.
    assert.equal(normaliseCameraUrl('http://192.168.2.141:8080'), 'http://192.168.2.141:8080/video');
    assert.equal(normaliseCameraUrl('http://192.168.2.141:8080/'), 'http://192.168.2.141:8080/video');
  });

  await test('an explicit camera path is left alone', async () => {
    const { normaliseCameraUrl } = await import('../server/config.js');
    assert.equal(normaliseCameraUrl('http://192.168.2.141:8080/video'), 'http://192.168.2.141:8080/video');
    assert.equal(normaliseCameraUrl('http://192.168.2.141:8080/videofeed'), 'http://192.168.2.141:8080/videofeed');
  });

  await test('an unset or unparseable camera address does not throw', async () => {
    const { normaliseCameraUrl } = await import('../server/config.js');
    assert.equal(normaliseCameraUrl(''), '');
    assert.equal(normaliseCameraUrl('not a url'), 'not a url');
  });

  console.log('\nStatus and sensors');

  await test('every heater the printer reports appears', async () => {
    const { body } = await call('/api/status');
    const keys = body.sensors.map((s) => s.key);
    assert.deepEqual(keys, ['tool0', 'tool1', 'bed'], 'dual extruder plus bed');
  });

  await test('two hotends are labelled distinctly', async () => {
    const { body } = await call('/api/status');
    const labels = body.sensors.map((s) => s.label);
    assert.deepEqual(labels, ['Nozzle 1', 'Nozzle 2', 'Bed']);
  });

  await test('job progress is reported with readable durations', async () => {
    const { body } = await call('/api/status');
    assert.equal(body.job.file, 'benchy_v3.gcode');
    assert.equal(body.job.printTimeText, '38m 30s');
    assert.equal(body.job.printTimeLeftText, '51m 30s');
  });

  await test('the API key is never exposed to the client', async () => {
    const status = JSON.stringify((await call('/api/status')).body);
    const conf = JSON.stringify((await call('/api/config')).body);
    assert.ok(!status.includes('test-api-key'), 'status leaked the key');
    assert.ok(!conf.includes('test-api-key'), 'config leaked the key');
    assert.ok(!conf.includes('5098'), 'config leaked the camera address');
  });

  console.log('\nPrint controls');

  await test('pause pauses the print', async () => {
    await post('/api/control/pause', { action: 'pause' });
    const snap = await waitForState('paused');
    assert.equal(snap.state, 'paused');
  });

  await test('resume is sent as a resume, not a new print', async () => {
    await post('/api/control/pause', { action: 'resume' });
    await waitForState('printing');
    const last = octoMock.received.filter((r) => r.path === '/api/job').at(-1);
    assert.deepEqual(last.body, { command: 'pause', action: 'resume' });
  });

  await test('resuming does not log the print as stopped', async () => {
    const { body } = await call('/api/events?limit=20');
    const types = body.events.map((e) => e.type);
    assert.ok(types.includes('print_resumed'), 'expected a print_resumed event');
    assert.ok(!types.includes('print_stopped'), 'a resume was mistaken for a stop');
  });

  await test('cancel sends the cancel command', async () => {
    await post('/api/control/cancel', {});
    await waitForState('idle');
    const last = octoMock.received.filter((r) => r.path === '/api/job').at(-1);
    assert.deepEqual(last.body, { command: 'cancel' });
  });

  await test('emergency stop sends M112', async () => {
    const { status, body } = await post('/api/control/emergency-stop', {});
    assert.equal(status, 200);
    assert.equal(body.reconnect, true);
    const last = octoMock.received.filter((r) => r.path === '/api/printer/command').at(-1);
    assert.deepEqual(last.body.commands, ['M112']);
  });

  console.log('\nTemperature control');

  await test('each hotend can be targeted individually', async () => {
    await post('/api/control/temperature', { target: 'tool1', value: 205 });
    const last = octoMock.received.filter((r) => r.path === '/api/printer/tool').at(-1);
    assert.deepEqual(last.body.targets, { tool1: 205 });
  });

  await test('an unsafe nozzle temperature is refused', async () => {
    const { status } = await post('/api/control/temperature', { target: 'tool0', value: 300 });
    assert.equal(status, 400);
  });

  await test('an unsafe bed temperature is refused', async () => {
    const { status } = await post('/api/control/temperature', { target: 'bed', value: 200 });
    assert.equal(status, 400);
  });

  await test('an unknown heater is refused', async () => {
    const { status } = await post('/api/control/temperature', { target: 'chamber', value: 50 });
    assert.equal(status, 400);
  });

  console.log('\nMaintenance commands');

  await test('the allowlist runs only its own G-code', async () => {
    const { body } = await post('/api/control/command', { id: 'home', gcode: ['M112', 'M303'] });
    assert.deepEqual(body.ran, ['G28']);
    const last = octoMock.received.filter((r) => r.path === '/api/printer/command').at(-1);
    assert.deepEqual(last.body.commands, ['G28'], 'caller-supplied G-code must be ignored');
  });

  await test('an unknown command id is refused', async () => {
    const { status } = await post('/api/control/command', { id: 'nope' });
    assert.equal(status, 400);
  });

  await test('homing is refused during a print', async () => {
    octoMock.setMode('printing');
    await waitForState('printing');
    const { status, body } = await post('/api/control/command', { id: 'home' });
    assert.equal(status, 409);
    assert.match(body.error, /not safe/);
  });

  console.log('\nMotion and tuning');

  /** Last G-code batch the server actually sent to the printer. */
  const lastGcode = () =>
    octoMock.received.filter((r) => r.path === '/api/printer/command').at(-1).body.commands;

  await test('jogging wraps the move in relative mode and returns to absolute', async () => {
    octoMock.setMode('idle');
    await waitForState('idle');
    const { status } = await post('/api/control/jog', { axis: 'x', distance: 10 });
    assert.equal(status, 200);
    // Leaving the firmware in G91 would silently corrupt the next print.
    assert.deepEqual(lastGcode(), ['G91', 'G0 X10 F3000', 'G90']);
  });

  await test('a jog distance beyond the limit is clamped, not sent raw', async () => {
    await post('/api/control/jog', { axis: 'z', distance: 99999 });
    assert.deepEqual(lastGcode(), ['G91', 'G0 Z100 F600', 'G90']);
  });

  await test('an unknown jog axis is refused', async () => {
    const { status } = await post('/api/control/jog', { axis: 'a', distance: 1 });
    assert.equal(status, 400);
  });

  await test('homing named axes sends only those axes', async () => {
    await post('/api/control/home', { axes: ['x', 'y'] });
    assert.deepEqual(lastGcode(), ['G28 X Y']);
  });

  await test('homing with no axes homes everything', async () => {
    await post('/api/control/home', { axes: [] });
    assert.deepEqual(lastGcode(), ['G28']);
  });

  await test('extruding is refused while the nozzle is cold', async () => {
    // tool1 sits at room temperature in the mock.
    const { status, body } = await post('/api/control/extrude', { tool: 'tool1', amount: 10 });
    assert.equal(status, 409);
    assert.match(body.error, /170/);
  });

  await test('extruding on a hot nozzle selects the tool first', async () => {
    const { status } = await post('/api/control/extrude', { tool: 'tool0', amount: 5 });
    assert.equal(status, 200);
    assert.deepEqual(lastGcode(), ['T0', 'G91', 'G1 E5 F300', 'G90']);
  });

  await test('the fan converts percent to PWM, and zero turns it off', async () => {
    await post('/api/control/fan', { percent: 100 });
    assert.deepEqual(lastGcode(), ['M106 S255']);
    await post('/api/control/fan', { percent: 0 });
    assert.deepEqual(lastGcode(), ['M107']);
  });

  await test('feedrate and flow are clamped to safe ranges', async () => {
    await post('/api/control/feedrate', { percent: 9999 });
    assert.deepEqual(lastGcode(), ['M220 S300']);
    await post('/api/control/flow', { percent: 0 });
    assert.deepEqual(lastGcode(), ['M221 S50']);
  });

  await test('a babystep larger than half a millimetre is clamped', async () => {
    await post('/api/control/babystep', { delta: 5 });
    assert.deepEqual(lastGcode(), ['M290 Z0.5']);
  });

  await test('temperature history is recorded for the chart', async () => {
    const { status, body } = await call('/api/history?limit=10');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.samples) && body.samples.length > 0, 'expected samples');
    assert.ok(Number.isFinite(body.samples.at(-1).t), 'each sample needs a timestamp');
    assert.ok(body.samples.at(-1).tool0, 'expected a tool0 series');
  });

  await test('motion is refused while a print is running', async () => {
    octoMock.setMode('printing');
    await waitForState('printing');
    for (const [path, payload] of [
      ['/api/control/jog', { axis: 'x', distance: 1 }],
      ['/api/control/home', { axes: ['z'] }],
      ['/api/control/extrude', { tool: 'tool0', amount: 1 }],
    ]) {
      const { status } = await post(path, payload);
      assert.equal(status, 409, `${path} must be refused mid-print`);
    }
  });

  await test('tuning IS allowed while printing', async () => {
    // Adjusting speed, flow and fan mid-print is the whole point of having them.
    for (const [path, payload] of [
      ['/api/control/fan', { percent: 50 }],
      ['/api/control/feedrate', { percent: 120 }],
      ['/api/control/flow', { percent: 95 }],
      ['/api/control/babystep', { delta: -0.05 }],
    ]) {
      const { status } = await post(path, payload);
      assert.equal(status, 200, `${path} must work mid-print`);
    }
  });

  console.log('\nStored files');

  await test('files are listed, including inside folders', async () => {
    const { body } = await call('/api/files');
    const paths = body.files.map((f) => f.path);
    assert.ok(paths.includes('brackets/bracket_v2.gcode'), 'folders must be walked');
    assert.equal(body.files.length, 3);
  });

  await test('the newest file is listed first', async () => {
    const { body } = await call('/api/files');
    assert.equal(body.files[0].path, 'brackets/bracket_v2.gcode');
  });

  await test('printing a stored file is refused while already printing', async () => {
    const { status } = await post('/api/files/print', { path: 'benchy_v3.gcode' });
    assert.equal(status, 409);
  });

  console.log('\nUpload');

  await test('a non-gcode upload is rejected', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'notes.txt');
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(res.status, 400);
  });

  await test('a gcode upload reaches OctoPrint', async () => {
    const form = new FormData();
    form.append('file', new Blob(['G28\nG1 X0\n']), 'part.gcode');
    form.append('print', 'false');
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(res.status, 200);
    assert.ok(octoMock.received.some((r) => r.path === '/api/files/local'));
  });

  await test('starting a second print is refused', async () => {
    const form = new FormData();
    form.append('file', new Blob(['G28\n']), 'part.gcode');
    form.append('print', 'true');
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(res.status, 409);
  });

  console.log('\nCamera relay');

  await test('a still frame is relayed as a real JPEG', async () => {
    const res = await fetch(`${BASE}/api/camera/snapshot`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(buf[0], 0xff, 'expected JPEG magic bytes');
    assert.equal(buf[1], 0xd8);
  });

  await test('the MJPEG stream relays multiple frames', async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/camera/stream`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    assert.match(res.headers.get('content-type'), /multipart\/x-mixed-replace/);

    let bytes = 0;
    const reader = res.body.getReader();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 500) break;
    }
    controller.abort();
    assert.ok(bytes > 300, `expected frames to flow, got ${bytes} bytes`);
  });

  await test('the camera requires authentication', async () => {
    const res = await fetch(`${BASE}/api/camera/snapshot`);
    assert.equal(res.status, 401);
  });

  console.log('\nFailure detection');

  await test('a sustained temperature deviation raises an anomaly', async () => {
    octoMock.setMode('anomaly');
    await sleep(9000); // 3s hold plus poll intervals
    const { body } = await call('/api/events?limit=30');
    const anomaly = body.events.find((e) => e.type === 'temp_anomaly');
    assert.ok(anomaly, 'no temp_anomaly was logged');
    assert.match(anomaly.message, /Nozzle 1/);
    assert.equal(anomaly.sensor, 'tool0');
  });

  await test('the anomaly is surfaced on the sensor itself', async () => {
    const { body } = await call('/api/status');
    const tool0 = body.sensors.find((s) => s.key === 'tool0');
    assert.ok(tool0.alerting, 'tool0 should be flagged as alerting');
  });

  await test('recovery clears the alert', async () => {
    octoMock.setMode('printing');
    await sleep(6000);
    const { body } = await call('/api/status');
    const tool0 = body.sensors.find((s) => s.key === 'tool0');
    assert.equal(tool0.alerting, false);
    assert.equal(tool0.deviatingSince, null);
  });

  console.log('\nOctoPrint downtime');

  await test('losing OctoPrint yields a clear offline state, not a crash', async () => {
    octoServer.close();
    await sleep(500);
    const snap = await waitForState('offline');
    assert.match(snap.offlineReason, /Nothing is listening|did not respond/);
  });

  await test('control actions fail cleanly while offline', async () => {
    const { status, body } = await post('/api/control/cancel', {});
    assert.equal(status, 503);
    assert.equal(body.printerOffline, true);
  });

  await test('the server is still serving', async () => {
    const { status } = await call('/api/session');
    assert.equal(status, 200);
  });
} catch (err) {
  console.error('\nFatal error while testing:', err);
  console.error(serverLog.join(''));
  failed += 1;
}

// --- Result ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.error('\nServer output:\n' + serverLog.join(''));
shutdown(failed ? 1 : 0);
