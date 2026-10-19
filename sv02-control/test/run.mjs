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
import * as ntfyMock from './mocks/ntfy.mjs';

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
const ntfyServer = await ntfyMock.start(5097);

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: '8099',
    OCTOPRINT_URL: 'http://localhost:5099',
    OCTOPRINT_API_KEY: 'test-api-key',
    APP_PASSWORD: PASSWORD,
    PHONE_CAMERA_URL: 'http://localhost:5098/video',
    NTFY_TOPIC_URL: 'http://localhost:5097/sv02-test',
    SESSION_SECRET: 'test-secret-not-for-real-use-0000',
    TRUST_PROXY_HTTPS: 'false',
    TEMP_DEVIATION_C: '15',
    TEMP_DEVIATION_SECONDS: '3',
    STALL_MINUTES: '0.05',
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
  ntfyServer.close();
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
    assert.equal(normaliseCameraUrl('http://192.168.1.50:8080'), 'http://192.168.1.50:8080/video');
    assert.equal(normaliseCameraUrl('http://192.168.1.50:8080/'), 'http://192.168.1.50:8080/video');
  });

  await test('an explicit camera path is left alone', async () => {
    const { normaliseCameraUrl } = await import('../server/config.js');
    assert.equal(normaliseCameraUrl('http://192.168.1.50:8080/video'), 'http://192.168.1.50:8080/video');
    assert.equal(normaliseCameraUrl('http://192.168.1.50:8080/videofeed'), 'http://192.168.1.50:8080/videofeed');
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

  console.log('\nLayer view');

  await test('the G-code is indexed into the right number of layers', async () => {
    const { status, body } = await call('/api/gcode/index');
    assert.equal(status, 200);
    assert.equal(body.layers, 4, 'the test file has four layers');
    assert.deepEqual(body.heights, [0.2, 0.4, 0.6, 0.8]);
  });

  await test('the print area is measured from the toolpaths', async () => {
    const { body } = await call('/api/gcode/index');
    // Every shape is centred on (100,100) with a radius of 20.
    assert.ok(body.bounds.minX >= 79 && body.bounds.minX <= 81, `minX ${body.bounds.minX}`);
    assert.ok(body.bounds.maxX >= 119 && body.bounds.maxX <= 121, `maxX ${body.bounds.maxX}`);
  });

  await test('layer 0 is the square, with four extruding sides', async () => {
    const { body } = await call('/api/gcode/layer?layer=0');
    const drawn = body.segments.filter((seg) => seg.e);
    assert.equal(drawn.length, 4, 'a square has four sides');
    const xs = new Set(drawn.flatMap((seg) => [seg.x1, seg.x2]));
    assert.equal(xs.size, 2, `expected 2 distinct x values, got ${[...xs]}`);
  });

  await test('layer 1 is the circle, with many short segments', async () => {
    const { body } = await call('/api/gcode/layer?layer=1');
    const drawn = body.segments.filter((seg) => seg.e);
    assert.equal(drawn.length, 32, 'the circle is drawn as 32 chords');
    assert.ok(new Set(drawn.map((seg) => seg.x2)).size > 10, 'a circle needs many distinct x values');
  });

  await test('travel moves are marked separately from extrusion', async () => {
    const { body } = await call('/api/gcode/layer?layer=2');
    assert.ok(body.segments.some((seg) => !seg.e), 'the move to the start is a travel');
    assert.ok(body.segments.some((seg) => seg.e), 'the triangle itself extrudes');
  });

  await test('each segment carries the byte offset that places the nozzle', async () => {
    const { body } = await call('/api/gcode/layer?layer=0');
    const offsets = body.segments.map((seg) => seg.o);
    assert.ok(offsets.every((o) => Number.isFinite(o) && o > 0));
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), 'offsets must increase');
  });

  await test('the layer is located from the byte offset when none is given', async () => {
    const { body } = await call('/api/gcode/layer');
    const pos = octoMock.getFilepos();
    assert.ok(body.start <= pos && pos < body.end,
      `filepos ${pos} should fall inside layer ${body.layer} [${body.start}, ${body.end})`);
  });

  await test('following the byte offset walks the layers in order', async () => {
    const seen = [];
    for (const fraction of [0.1, 0.5, 0.99]) {
      const target = Math.floor(octoMock.GCODE.length * fraction);
      octoMock.setFilepos(target);
      // The endpoint reads the server's cached snapshot, so wait for the poll
      // loop to pick the new offset up rather than asserting on stale data.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const { body } = await call('/api/status');
        if (body.job?.filepos === target) break;
        await sleep(300);
      }
      const { body } = await call('/api/gcode/layer');
      seen.push(body.layer);
    }
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `layers went backwards: ${seen}`);
    assert.ok(seen.at(-1) > seen[0], 'the layer should advance with the offset');
  });

  await test('a layer past the end of the file is refused', async () => {
    const { status } = await call('/api/gcode/layer?layer=999');
    assert.equal(status, 404);
  });

  console.log('\nLive G-code lines');

  await test('the executing line is located from the byte offset', async () => {
    const { status, body } = await call('/api/gcode/lines');
    assert.equal(status, 200);
    assert.ok(Number.isFinite(body.current), 'a current line should be identified');
    assert.ok(body.current > 0 && body.current <= body.totalLines,
      `line ${body.current} outside 1..${body.totalLines}`);
  });

  await test('the surrounding lines come back as context', async () => {
    const { body } = await call('/api/gcode/lines');
    assert.ok(body.lines.length > 3, 'expected a window of lines');
    const numbers = body.lines.map((l) => l.n);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'lines must be in order');
    assert.ok(numbers.includes(body.current), 'the window must contain the current line');
  });

  await test('the window shows what is coming, not just what has run', async () => {
    // Mid-file, so there is room on both sides.
    const { body } = await call(`/api/gcode/lines?filepos=${Math.floor(octoMock.GCODE.length * 0.5)}`);
    const ahead = body.lines.filter((l) => l.n > body.current).length;
    const behind = body.lines.filter((l) => l.n < body.current).length;
    assert.ok(ahead > 3, `expected upcoming lines, got ${ahead}`);
    assert.ok(behind > 3, `expected preceding lines, got ${behind}`);
  });

  await test('the line text is the actual G-code', async () => {
    const { body } = await call('/api/gcode/lines?filepos=0');
    const text = body.lines.map((l) => l.text).join('\n');
    assert.match(text, /G(0|1|21|28|90)/, `expected G-code, got: ${text.slice(0, 80)}`);
  });

  await test('the line advances as the byte offset does', async () => {
    const early = await call('/api/gcode/lines?filepos=40');
    const later = await call('/api/gcode/lines?filepos=' + Math.floor(octoMock.GCODE.length * 0.9));
    assert.ok(later.body.current > early.body.current,
      `line went ${early.body.current} -> ${later.body.current}`);
  });

  console.log('\nSending G-code');

  await test('an ordinary command is sent straight through', async () => {
    const { status, body } = await post('/api/gcode/send', { command: 'M106 S128' });
    assert.equal(status, 200);
    const last = octoMock.received.filter((r) => r.path === '/api/printer/command').at(-1);
    assert.deepEqual(last.body.commands, ['M106 S128']);
    assert.ok(body.note, 'the reply should explain that the printer does not answer back');
  });

  await test('a dangerous command is refused until confirmed', async () => {
    const { status, body } = await post('/api/gcode/send', { command: 'M112' });
    assert.equal(status, 409);
    assert.equal(body.needsConfirmation, true);
    assert.match(body.error, /Emergency stop/i);
  });

  await test('confirming lets the dangerous command through', async () => {
    const before = octoMock.received.filter((r) => r.path === '/api/printer/command').length;
    const { status } = await post('/api/gcode/send', { command: 'M112', confirmed: true });
    assert.equal(status, 200);
    const after = octoMock.received.filter((r) => r.path === '/api/printer/command');
    assert.equal(after.length, before + 1);
    assert.deepEqual(after.at(-1).body.commands, ['M112']);
  });

  await test('every sent command is written to the log', async () => {
    const { body } = await call('/api/events?limit=60');
    const sent = body.events.filter((e) => e.type === 'gcode_sent');
    assert.ok(sent.some((e) => e.message.includes('M106 S128')), 'the ordinary command was logged');
    const risky = sent.find((e) => e.message.includes('M112'));
    assert.ok(risky, 'the dangerous command was logged');
    assert.equal(risky.level, 'warn', 'a dangerous command should be logged as a warning');
  });

  await test('an empty or multi-line command is rejected', async () => {
    assert.equal((await post('/api/gcode/send', { command: '   ' })).status, 400);
    assert.equal((await post('/api/gcode/send', { command: 'G28\nM112' })).status, 400);
  });

  await test('an over-long command is rejected', async () => {
    const { status } = await post('/api/gcode/send', { command: 'M117 ' + 'x'.repeat(300) });
    assert.equal(status, 400);
  });

  console.log('\nStall detection');

  await test('a stalled print is reported on the status', async () => {
    octoMock.setMode('printing');
    await waitForState('printing');
    const deadline = Date.now() + 15000;
    let stalled = null;
    while (Date.now() < deadline) {
      const { body } = await call('/api/status');
      if (body.stallWatch?.stalledSince) { stalled = body.stallWatch; break; }
      await sleep(500);
    }
    assert.ok(stalled, 'expected stallWatch to report a stall');
  });

  await test('the stall is logged once, not every poll', async () => {
    const { body } = await call('/api/events?limit=60');
    const stalls = body.events.filter((e) => e.type === 'print_stalled');
    assert.equal(stalls.length, 1, `expected exactly one stall event, got ${stalls.length}`);
  });

  console.log('\nNotifications');

  await test('an alert carries a camera photo', async () => {
    const deadline = Date.now() + 8000;
    let shot = null;
    while (Date.now() < deadline) {
      shot = ntfyMock.received.find((n) => n.bodyIsJpeg);
      if (shot) break;
      await sleep(300);
    }
    assert.ok(shot, 'expected a notification with an image body');
    assert.equal(shot.method, 'PUT', 'an attachment must be sent as PUT');
    assert.match(shot.contentType, /image\/jpeg/);
    assert.ok(shot.filename, 'ntfy needs a Filename header to treat it as an attachment');
    assert.ok(shot.messageHeader, 'the text must move to the Message header');
    assert.ok(!/[\r\n]/.test(shot.messageHeader), 'newlines would break the header');
  });

  await test('alert text with typographic characters still sends', async () => {
    // Every message here contains an em dash and degree signs; if any had
    // reached a header raw, the request would have thrown instead of sending.
    const failures = await call('/api/events?limit=80');
    const notifyFailures = failures.body.events.filter((e) => e.type === 'notify_failed');
    assert.equal(notifyFailures.length, 0,
      `notifications failed: ${notifyFailures.map((e) => e.message).join('; ')}`);
  });

  console.log('\nDiagnosing an offline printer');

  await test('a visible port but a closed link is named as such', async () => {
    octoMock.setMode('disconnected');
    octoMock.setPorts(['/dev/ttyUSB0']);
    await waitForState('offline');
    const { body } = await call('/api/diagnostics');
    assert.equal(body.verdict, 'port-but-closed');
    assert.match(body.hint, /115200/, 'should suggest the baud rates to try');
    assert.deepEqual(body.ports, ['/dev/ttyUSB0']);
  });

  await test('no serial port at all points at the cable, not the baud rate', async () => {
    octoMock.setPorts([]);
    const { body } = await call('/api/diagnostics');
    assert.equal(body.verdict, 'no-port');
    assert.match(body.hint, /charge-only|data cable/i, 'should name the usual cause');
    assert.ok(!/115200/.test(body.hint), 'baud rate is irrelevant when no port exists');
  });

  await test('the reconnect accepts a chosen baud rate', async () => {
    const { status } = await post('/api/control/reconnect', { baudrate: 115200 });
    assert.equal(status, 200);
    const last = octoMock.received.filter((r) => r.path === '/api/connection').at(-1);
    assert.equal(last.body.command, 'connect');
    assert.equal(last.body.baudrate, 115200);
  });

  await test('the printer coming back is reflected', async () => {
    octoMock.setPorts(['/dev/ttyUSB0']);
    octoMock.setMode('printing');
    await waitForState('printing');
    const { body } = await call('/api/diagnostics');
    assert.equal(body.verdict, 'connected');
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
