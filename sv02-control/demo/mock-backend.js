/**
 * Demo backend, running entirely in the browser.
 *
 * This exists so the interface can be shown without a printer. It intercepts
 * the same HTTP calls the real server answers and makes up plausible data.
 * `app.js` is byte-for-byte the file that runs against the real backend — it
 * has no idea this is here, which is the point: what you see in the demo is
 * genuinely the app, not a mock-up of it.
 *
 * Nothing here ships to the Pi. The real deployment serves public/ only.
 */
(() => {
  'use strict';

  // --- Simulated printer state ---------------------------------------------

  const printer = {
    state: 'printing',
    file: 'benchy_v3.gcode',
    completion: 42.7,
    printTime: 2310,
    printTimeLeft: 3090,
    targets: { tool0: 210, tool1: 0, bed: 60 },
    actuals: { tool0: 209.8, tool1: 24.3, bed: 59.7 },
    anomaly: false,
  };

  const events = [
    { ts: Date.now() - 1000 * 60 * 38, level: 'info', type: 'print_started', message: 'Print started: benchy_v3.gcode' },
    { ts: Date.now() - 1000 * 60 * 39, level: 'info', type: 'file_uploaded', message: 'Uploaded benchy_v3.gcode and started printing.' },
    { ts: Date.now() - 1000 * 60 * 40, level: 'info', type: 'login_ok', message: 'Login from 192.168.1.22' },
  ];

  const files = [
    { name: 'benchy_v3.gcode', path: 'benchy_v3.gcode', size: 4823901 },
    { name: 'bracket_v2.gcode', path: 'brackets/bracket_v2.gcode', size: 1200000 },
    { name: 'phone_stand.gcode', path: 'phone_stand.gcode', size: 2410000 },
    { name: 'calibration_cube.gcode', path: 'calibration_cube.gcode', size: 184000 },
  ];

  const log = (level, type, message) => {
    events.unshift({ ts: Date.now(), level, type, message });
    if (events.length > 60) events.length = 60;
  };

  // Advance the simulation once a second so the dashboard is visibly alive.
  setInterval(() => {
    const wobble = (v, amount) => v + (Math.random() - 0.5) * amount;

    for (const key of ['tool0', 'tool1', 'bed']) {
      const target = printer.targets[key];
      if (target > 0) {
        const drift = printer.anomaly && key === 'tool0' ? -60 : 0;
        printer.actuals[key] = wobble(target + drift, 0.6);
      } else {
        printer.actuals[key] = wobble(24, 0.3);
      }
    }

    if (printer.state === 'printing') {
      printer.completion = Math.min(100, printer.completion + 0.05);
      printer.printTime += 1;
      printer.printTimeLeft = Math.max(0, printer.printTimeLeft - 1);
    }
  }, 1000);

  // --- Simulated camera -----------------------------------------------------
  //
  // The real app points an <img> at /api/camera/stream. Rather than special-
  // case that in app.js, the element's `src` setter is patched here so any
  // camera URL resolves to a frame drawn on a canvas. app.js stays untouched
  // and its normal `load` handling runs exactly as it would with a real feed.

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  let frame = 0;

  function drawFrame() {
    frame += 1;

    ctx.fillStyle = '#15171c';
    ctx.fillRect(0, 0, 640, 360);

    // Bed
    ctx.fillStyle = '#23262e';
    ctx.beginPath();
    ctx.moveTo(120, 300); ctx.lineTo(520, 300); ctx.lineTo(470, 250); ctx.lineTo(170, 250);
    ctx.closePath();
    ctx.fill();

    // The part, growing with print progress
    const layers = Math.max(1, Math.round((printer.completion / 100) * 26));
    for (let i = 0; i < layers; i += 1) {
      const y = 250 - i * 3.4;
      const inset = 8 + Math.sin(i / 3) * 5;
      ctx.fillStyle = i === layers - 1 ? '#5b9bff' : '#3d6fc4';
      ctx.fillRect(285 + inset / 2, y, 70 - inset, 3.2);
    }

    // Nozzle, tracking across the layer
    const nozzleX = 300 + Math.sin(frame / 6) * 32;
    const nozzleY = 250 - layers * 3.4 - 12;
    ctx.fillStyle = '#8b8f99';
    ctx.fillRect(nozzleX - 13, nozzleY - 34, 26, 30);
    ctx.fillStyle = '#c9ccd2';
    ctx.beginPath();
    ctx.moveTo(nozzleX - 5, nozzleY - 4); ctx.lineTo(nozzleX + 5, nozzleY - 4); ctx.lineTo(nozzleX, nozzleY + 5);
    ctx.closePath();
    ctx.fill();

    // Hot-end glow, stronger the hotter it is
    const heat = Math.max(0, Math.min(1, printer.actuals.tool0 / 210));
    ctx.fillStyle = `rgba(255,120,40,${0.28 * heat})`;
    ctx.beginPath();
    ctx.arc(nozzleX, nozzleY, 17, 0, Math.PI * 2);
    ctx.fill();

    // Timestamp, so it is obvious the feed is live rather than a still
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = '13px monospace';
    ctx.fillText(new Date().toLocaleTimeString(), 16, 340);

    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '12px sans-serif';
    ctx.fillText('SIMULATED FEED — no camera attached', 16, 28);
  }

  const cameraImg = document.getElementById('camera');
  if (cameraImg) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

    Object.defineProperty(cameraImg, 'src', {
      configurable: true,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        if (typeof value === 'string' && value.includes('/api/camera')) {
          drawFrame();
          descriptor.set.call(this, canvas.toDataURL('image/jpeg', 0.7));
        } else {
          descriptor.set.call(this, value);
        }
      },
    });

    // Keep pushing frames so it animates like a real MJPEG stream.
    setInterval(() => {
      if (!cameraImg.src.startsWith('data:')) return;
      drawFrame();
      descriptor.set.call(cameraImg, canvas.toDataURL('image/jpeg', 0.7));
    }, 500);
  }

  // --- Request interception -------------------------------------------------

  const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  function sensors() {
    const build = (key, label, kind, max) => ({
      key,
      label,
      kind,
      max,
      actual: printer.actuals[key],
      target: printer.targets[key],
      deviatingSince: printer.anomaly && key === 'tool0' ? new Date().toISOString() : null,
      alerting: printer.anomaly && key === 'tool0',
    });
    return [
      build('tool0', 'Nozzle 1', 'tool', 260),
      build('tool1', 'Nozzle 2', 'tool', 260),
      build('bed', 'Bed', 'bed', 120),
    ];
  }

  const routes = {
    'GET /api/session': () => ({ authenticated: false }),

    'POST /api/login': (body) => {
      // Any password is accepted here; the hint is on the login screen.
      if (!body?.password) return { __status: 401, error: 'Incorrect password.' };
      log('info', 'login_ok', 'Login from 192.168.1.22');
      return { ok: true };
    },

    'POST /api/logout': () => ({ ok: true }),

    'GET /api/config': () => ({
      cameraConfigured: true,
      notificationsConfigured: true,
      autoPause: false,
      thresholdC: 15,
      holdSeconds: 30,
      pollIntervalMs: 2000,
    }),

    'GET /api/status': () => ({
      state: printer.state,
      error: null,
      updatedAt: new Date().toISOString(),
      offlineReason: null,
      sensors: sensors(),
      job: {
        file: printer.state === 'idle' ? null : printer.file,
        completion: printer.state === 'idle' ? null : printer.completion,
        printTime: printer.printTime,
        printTimeLeft: printer.printTimeLeft,
        printTimeText: formatDuration(printer.printTime),
        printTimeLeftText: formatDuration(printer.printTimeLeft),
      },
      anomalyWatch: { thresholdC: 15, holdSeconds: 30, autoPause: false },
    }),

    'GET /api/events': () => ({
      events: events.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })),
    }),

    'GET /api/files': () => ({ files }),

    'GET /api/control/commands': () => ({
      commands: [
        { id: 'home', label: 'Home all axes', gcode: ['G28'], blockedWhilePrinting: true },
        { id: 'level', label: 'Auto bed level (needs a probe fitted)', gcode: ['G28', 'G29'], blockedWhilePrinting: true },
        { id: 'save', label: 'Save settings to EEPROM', gcode: ['M500'], blockedWhilePrinting: true },
        { id: 'motorsOff', label: 'Release the motors', gcode: ['M18'], blockedWhilePrinting: true },
        { id: 'cooldown', label: 'Turn off all heaters', gcode: ['M104 S0', 'M140 S0'], blockedWhilePrinting: false },
      ],
    }),

    'POST /api/control/pause': (body) => {
      if (body.action === 'resume') {
        printer.state = 'printing';
        log('info', 'print_resumed', `Print resumed: ${printer.file}`);
      } else {
        printer.state = 'paused';
        log('info', 'print_paused', `Print paused: ${printer.file}`);
      }
      return { ok: true, action: body.action };
    },

    'POST /api/control/cancel': () => {
      printer.state = 'idle';
      printer.anomaly = false;
      log('warn', 'print_cancel_requested', 'User cancelled the print.');
      return { ok: true };
    },

    'POST /api/control/emergency-stop': () => {
      printer.state = 'error';
      printer.targets.tool0 = 0;
      printer.targets.bed = 0;
      log('error', 'emergency_stop', 'EMERGENCY STOP (M112) sent by user.');
      return {
        ok: true,
        reconnect: true,
        message: 'M112 sent. The printer firmware is halted and must be power-cycled or reconnected.',
      };
    },

    'POST /api/control/reconnect': () => {
      printer.state = 'idle';
      log('info', 'reconnect', 'Reconnect requested.');
      return { ok: true };
    },

    'POST /api/control/temperature': (body) => {
      if (!(body.target in printer.targets)) {
        return { __status: 400, error: 'target must be "bed" or a tool such as "tool0".' };
      }
      const max = body.target === 'bed' ? 120 : 260;
      if (body.value > max) {
        return { __status: 400, error: `That target is above the ${max} °C limit.` };
      }
      printer.targets[body.target] = body.value;
      log('info', 'temp_set', `Set ${body.target} target to ${body.value}°C.`);
      return { ok: true };
    },

    'POST /api/control/command': (body) => {
      const command = routes['GET /api/control/commands']().commands.find((c) => c.id === body.id);
      if (!command) return { __status: 400, error: 'Unknown command.' };
      if (command.blockedWhilePrinting && (printer.state === 'printing' || printer.state === 'paused')) {
        return { __status: 409, error: `"${command.label}" is not safe to run during a print.` };
      }
      log('info', 'maintenance', `${command.label} (${command.gcode.join(', ')})`);
      return { ok: true, ran: command.gcode };
    },

    'POST /api/files/print': (body) => {
      if (printer.state === 'printing' || printer.state === 'paused') {
        return { __status: 409, error: 'A print is already running. Cancel it first.' };
      }
      const file = files.find((f) => f.path === body.path);
      printer.file = file?.name || body.path;
      printer.state = 'printing';
      printer.completion = 0;
      printer.printTime = 0;
      printer.printTimeLeft = 3600;
      printer.targets.tool0 = 210;
      printer.targets.bed = 60;
      log('info', 'print_from_library', `Started ${body.path} from stored files.`);
      return { ok: true };
    },
  };

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    if (!path.startsWith('/api/')) return nativeFetch(input, options);

    const key = `${(options.method || 'GET').toUpperCase()} ${path}`;
    const handler = routes[key];

    // Latency, so loading states are visible rather than instant.
    await new Promise((r) => setTimeout(r, 90 + Math.random() * 120));

    if (!handler) {
      return new Response(JSON.stringify({ error: 'Unknown endpoint.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body = null;
    try {
      body = options.body ? JSON.parse(options.body) : null;
    } catch {
      body = null;
    }

    const result = handler(body) || {};
    const status = result.__status || 200;
    delete result.__status;

    return new Response(JSON.stringify(result), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Uploads go through XMLHttpRequest for real progress events, so that path
  // needs its own stub.
  const NativeXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = function DemoXHR() {
    const xhr = new NativeXHR();
    const listeners = { load: [], error: [], abort: [], timeout: [] };
    const uploadListeners = { progress: [] };
    let isUpload = false;

    return {
      upload: {
        addEventListener: (type, fn) => uploadListeners[type]?.push(fn),
      },
      addEventListener: (type, fn) => listeners[type]?.push(fn),
      open(method, url) {
        isUpload = url.includes('/api/upload');
        if (!isUpload) xhr.open(method, url);
      },
      set withCredentials(v) { if (!isUpload) xhr.withCredentials = v; },
      status: 200,
      responseText: '',
      send(form) {
        if (!isUpload) return xhr.send(form);

        const file = form.get('file');
        const startNow = form.get('print') === 'true';
        const name = file?.name || 'upload.gcode';
        let percent = 0;

        const timer = setInterval(() => {
          percent += 6 + Math.random() * 9;
          const done = percent >= 100;

          for (const fn of uploadListeners.progress) {
            fn({ lengthComputable: true, loaded: Math.min(percent, 100), total: 100 });
          }

          if (!done) return;
          clearInterval(timer);

          files.unshift({ name, path: name, size: file?.size ?? 0 });
          log('info', 'file_uploaded', `Uploaded ${name}${startNow ? ' and started printing' : ''}.`);

          if (startNow) {
            printer.file = name;
            printer.state = 'printing';
            printer.completion = 0;
            printer.printTime = 0;
            printer.printTimeLeft = 3600;
          }

          this.status = 200;
          this.responseText = JSON.stringify({ ok: true, filename: name, started: startNow });
          setTimeout(() => { for (const fn of listeners.load) fn(); }, 250);
        }, 260);

        return undefined;
      },
    };
  };

  // --- Demo affordances -----------------------------------------------------

  window.addEventListener('DOMContentLoaded', () => {
    const password = document.getElementById('password');
    if (password) {
      password.value = 'demo';
      password.placeholder = 'Any password works in the demo';
    }

    const hint = document.createElement('p');
    hint.className = 'muted small';
    hint.style.textAlign = 'center';
    hint.textContent = 'Demo — simulated printer, no hardware attached. Any password works.';
    document.querySelector('.login-card')?.appendChild(hint);
  });

  // A button to trigger the failure detection, since a demo that never faults
  // cannot show the feature that matters most.
  window.addEventListener('DOMContentLoaded', () => {
    const attach = setInterval(() => {
      const controls = document.querySelector('.controls');
      if (!controls || document.getElementById('demo-fault')) return;
      clearInterval(attach);

      const button = document.createElement('button');
      button.id = 'demo-fault';
      button.className = 'ghost';
      button.style.gridColumn = '1 / -1';
      button.textContent = 'Simulate a thermal fault (demo only)';

      button.addEventListener('click', () => {
        printer.anomaly = !printer.anomaly;
        if (printer.anomaly) {
          log('warn', 'temp_anomaly', 'Nozzle 1 is 150.1°C but should be 210°C — off by 59.9°C for 30s.');
        } else {
          log('info', 'temp_recovered', 'Nozzle 1 temperature returned to normal.');
        }
        button.textContent = printer.anomaly
          ? 'Clear the simulated fault'
          : 'Simulate a thermal fault (demo only)';
      });

      controls.appendChild(button);
    }, 300);
  });
})();
