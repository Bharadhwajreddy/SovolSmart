/* SV02 Control — single-page frontend, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    loginScreen: $('login-screen'),
    loginForm: $('login-form'),
    loginButton: $('login-button'),
    password: $('password'),
    loginError: $('login-error'),

    dashboard: $('dashboard'),
    logout: $('logout'),
    banners: $('banners'),
    clock: $('clock'),

    stateDot: $('state-dot'),
    stateLabel: $('state-label'),

    camera: $('camera'),
    cameraOverlay: $('camera-overlay'),
    cameraMessage: $('camera-message'),
    cameraRetry: $('camera-retry'),
    cameraExpand: $('camera-expand'),
    cameraBadge: document.querySelector('.camera-badge'),
    cameraSpinner: document.querySelector('.camera-overlay .spinner'),
    cameraFrame: document.querySelector('.camera-frame'),

    jobFile: $('job-file'),
    jobPercent: $('job-percent'),
    progressFill: $('progress-fill'),
    jobElapsed: $('job-elapsed'),
    jobRemaining: $('job-remaining'),

    temps: $('temps'),
    chart: $('temp-chart'),
    chartLegend: $('chart-legend'),
    chartNote: $('chart-note'),

    maintenance: $('maintenance'),
    fileList: $('file-list'),
    refreshFiles: $('refresh-files'),

    btnPause: $('btn-pause'),
    btnCancel: $('btn-cancel'),
    btnEstop: $('btn-estop'),
    btnReconnect: $('btn-reconnect'),

    jogSteps: $('jog-steps'),
    homeAll: $('home-all'),
    motorsOff: $('motors-off'),
    extrudeTool: $('extrude-tool'),
    extrudeAmount: $('extrude-amount'),
    btnExtrude: $('btn-extrude'),
    btnRetract: $('btn-retract'),

    fanSlider: $('fan-slider'),
    fanValue: $('fan-value'),
    feedSlider: $('feed-slider'),
    feedValue: $('feed-value'),
    flowSlider: $('flow-slider'),
    flowValue: $('flow-value'),

    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    fileChosen: $('file-chosen'),
    fileName: $('file-name'),
    fileClear: $('file-clear'),
    startNow: $('start-now'),
    btnUpload: $('btn-upload'),
    uploadProgress: $('upload-progress'),
    uploadFill: $('upload-fill'),
    uploadStatus: $('upload-status'),

    eventList: $('event-list'),
    refreshEvents: $('refresh-events'),
    footerInfo: $('footer-info'),

    confirmDialog: $('confirm-dialog'),
    confirmTitle: $('confirm-title'),
    confirmBody: $('confirm-body'),
    confirmYes: $('confirm-yes'),
    confirmNo: $('confirm-no'),

    toast: $('toast'),
  };

  const state = {
    authenticated: false,
    snapshot: null,
    serverConfig: null,
    pendingFile: null,
    pollTimer: null,
    consecutiveFailures: 0,
    dismissedBanners: new Set(),
    jogStep: 1,
    history: [],
    activeTab: 'temps',
  };

  // --- Small helpers -------------------------------------------------------

  let toastTimer = null;
  function toast(message, kind = '') {
    el.toast.textContent = message;
    el.toast.className = `toast ${kind}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4500);
  }

  /**
   * All API traffic goes through here so a 401 anywhere bounces straight back
   * to the login screen instead of surfacing as a confusing error.
   */
  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { credentials: 'same-origin', ...options });
    } catch {
      throw new Error('Cannot reach the server. Check your connection or the tunnel.');
    }

    let data = null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      data = await response.json().catch(() => null);
    }

    // A 401 anywhere except the login endpoint itself means the session went
    // away, so bounce to the login screen. On /api/login a 401 is simply a
    // wrong password, and must keep its own message.
    if (response.status === 401 && !path.startsWith('/api/login')) {
      showLogin();
      throw new Error(data?.error || 'Your session expired. Sign in again.');
    }

    if (!response.ok) {
      const err = new Error(data?.error || `Request failed (HTTP ${response.status}).`);
      err.printerOffline = Boolean(data?.printerOffline);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  /** POST JSON, the shape almost every control uses. */
  const post = (path, body) =>
    api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  function banner(id, kind, message) {
    if (state.dismissedBanners.has(id)) return;
    if (el.banners.querySelector(`[data-id="${id}"]`)) return;

    const node = document.createElement('div');
    node.className = `banner ${kind}`;
    node.dataset.id = id;
    node.innerHTML = '<span></span><button aria-label="Dismiss">&times;</button>';
    node.querySelector('span').textContent = message;
    node.querySelector('button').addEventListener('click', () => {
      state.dismissedBanners.add(id);
      node.remove();
    });
    el.banners.appendChild(node);
  }

  const clearBanner = (id) => el.banners.querySelector(`[data-id="${id}"]`)?.remove();

  function confirmAction({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
    return new Promise((resolve) => {
      el.confirmTitle.textContent = title;
      el.confirmBody.textContent = body;
      el.confirmYes.textContent = confirmLabel;
      el.confirmNo.textContent = cancelLabel;

      const finish = (result) => {
        el.confirmYes.removeEventListener('click', onYes);
        el.confirmNo.removeEventListener('click', onNo);
        el.confirmDialog.removeEventListener('cancel', onNo);
        el.confirmDialog.close();
        resolve(result);
      };
      const onYes = () => finish(true);
      const onNo = (event) => { event?.preventDefault?.(); finish(false); };

      el.confirmYes.addEventListener('click', onYes);
      el.confirmNo.addEventListener('click', onNo);
      el.confirmDialog.addEventListener('cancel', onNo);
      el.confirmDialog.showModal();
    });
  }

  async function withBusy(button, label, fn) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      await fn();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.textContent = original;
      button.disabled = false;
      poll();
    }
  }

  // --- Tabs ----------------------------------------------------------------

  function wireTabs() {
    for (const tab of $$('.tab')) {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.tab;
        for (const t of $$('.tab')) t.classList.toggle('active', t === tab);
        for (const p of $$('.panel')) p.classList.toggle('active', p.dataset.panel === state.activeTab);
        // The canvas has no size while its panel is display:none, so it must be
        // redrawn once the panel is actually visible.
        if (state.activeTab === 'temps') drawChart();
        if (state.activeTab === 'files') loadFiles();
        if (state.activeTab === 'log') loadEvents();
      });
    }
  }

  // --- Camera --------------------------------------------------------------
  //
  // The stream can die for reasons entirely outside this app: the phone
  // reboots, WiFi drops, Android kills the IP Webcam app. So the camera never
  // assumes it is healthy — it retries the live stream with backoff, and if
  // the stream will not hold at all it degrades to polling single frames,
  // which survives conditions that break a long-lived connection.

  const camera = {
    mode: 'stream',        // 'stream' | 'snapshot'
    attempts: 0,
    retryTimer: null,
    watchdog: null,
    snapshotTimer: null,
    live: false,
  };

  function cameraOverlay(message, { spinner = true, retry = false } = {}) {
    el.cameraMessage.textContent = message;
    el.cameraSpinner.hidden = !spinner;
    el.cameraRetry.hidden = !retry;
    el.cameraOverlay.hidden = false;
    el.cameraBadge.hidden = true;
    camera.live = false;
  }

  function cameraHealthy() {
    el.cameraOverlay.hidden = true;
    el.cameraBadge.hidden = false;
    camera.attempts = 0;
    camera.live = true;
  }

  function stopCameraTimers() {
    clearTimeout(camera.retryTimer);
    clearTimeout(camera.watchdog);
    clearInterval(camera.snapshotTimer);
    camera.snapshotTimer = null;
  }

  function startStream() {
    stopCameraTimers();
    camera.mode = 'stream';

    if (camera.attempts === 0) cameraOverlay('Connecting to camera…');
    else cameraOverlay(`Camera dropped — reconnecting (attempt ${camera.attempts + 1})…`);

    // Cache-buster: without it the browser may reuse the dead connection.
    el.camera.src = `/api/camera/stream?t=${Date.now()}`;

    // If the first frame never arrives, the stream is not viable here — fall
    // back to snapshot polling rather than retrying a connection that hangs.
    camera.watchdog = setTimeout(() => {
      if (!camera.live) startSnapshotMode();
    }, 12000);
  }

  function scheduleStreamRetry() {
    stopCameraTimers();
    camera.attempts += 1;

    // 2s, 4s, 8s, 16s, then hold at 20s so a phone that is off overnight
    // doesn't hammer the network.
    const delay = Math.min(2000 * 2 ** (camera.attempts - 1), 20000);
    cameraOverlay(`Camera offline — retrying in ${Math.round(delay / 1000)}s…`, {
      spinner: false,
      retry: true,
    });

    camera.retryTimer = setTimeout(() => {
      if (camera.attempts > 4) startSnapshotMode();
      else startStream();
    }, delay);
  }

  function startSnapshotMode() {
    stopCameraTimers();
    camera.mode = 'snapshot';
    cameraOverlay('Live stream unavailable — showing still frames…');

    let failures = 0;
    const tick = () => {
      const probe = new Image();
      probe.onload = () => {
        failures = 0;
        el.camera.src = probe.src;
        cameraHealthy();
      };
      probe.onerror = () => {
        failures += 1;
        if (failures >= 3) {
          cameraOverlay('Camera unreachable. Is the phone awake and the IP Webcam app running?', {
            spinner: false,
            retry: true,
          });
        }
      };
      probe.src = `/api/camera/snapshot?t=${Date.now()}`;
    };

    tick();
    camera.snapshotTimer = setInterval(tick, 1000);

    // Periodically see whether the full stream has come back.
    setTimeout(() => {
      if (camera.mode === 'snapshot') {
        camera.attempts = 0;
        startStream();
      }
    }, 60000);
  }

  function initCamera() {
    if (!state.serverConfig?.cameraConfigured) {
      stopCameraTimers();
      cameraOverlay('No camera configured. Set PHONE_CAMERA_URL in your .env file.', { spinner: false });
      return;
    }

    el.camera.addEventListener('load', () => {
      if (camera.mode === 'stream') cameraHealthy();
    });
    el.camera.addEventListener('error', () => {
      if (camera.mode === 'stream') scheduleStreamRetry();
    });
    el.cameraRetry.addEventListener('click', () => {
      camera.attempts = 0;
      startStream();
    });
    el.cameraExpand.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.cameraFrame.requestFullscreen?.();
    });

    // A backgrounded tab has its stream torn down by the browser; pick it back
    // up on return instead of showing a frozen frame.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.authenticated && !camera.live) {
        camera.attempts = 0;
        startStream();
      }
    });

    startStream();
  }

  // --- Rendering -----------------------------------------------------------

  const STATE_LABELS = {
    idle: 'Idle',
    printing: 'Printing',
    paused: 'Paused',
    error: 'Error',
    offline: 'Offline',
    connecting: 'Connecting…',
  };

  const fmtTemp = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

  function render(snap) {
    state.snapshot = snap;

    el.stateDot.className = `dot ${snap.state}`;
    el.stateLabel.textContent = STATE_LABELS[snap.state] || snap.state;

    if (snap.state === 'offline') {
      banner('offline', 'danger', snap.offlineReason || 'The printer is not reachable.');
    } else {
      clearBanner('offline');
      state.dismissedBanners.delete('offline');
    }

    const job = snap.job || {};
    el.jobFile.textContent = job.file || 'No job loaded';
    el.jobFile.title = job.file || '';

    const pct = Number.isFinite(job.completion) ? job.completion : null;
    el.jobPercent.textContent = pct === null ? '—' : `${pct.toFixed(1)}%`;
    el.progressFill.style.width = `${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%`;
    el.jobElapsed.textContent = job.printTimeText ? `${job.printTimeText} elapsed` : '—';
    el.jobRemaining.textContent = job.printTimeLeftText ? `${job.printTimeLeftText} left` : '—';

    renderSensors(snap.sensors || []);
    syncExtruderOptions(snap.sensors || []);

    const printing = snap.state === 'printing';
    const paused = snap.state === 'paused';
    const active = printing || paused;

    el.btnPause.disabled = !active;
    el.btnPause.textContent = paused ? 'Resume' : 'Pause';
    el.btnCancel.disabled = !active;
    el.btnReconnect.hidden = !(snap.state === 'offline' || snap.state === 'error');

    el.btnUpload.disabled = !state.pendingFile;

    const stamp = snap.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : '—';
    el.footerInfo.textContent = `Last update ${stamp}`;
    el.clock.textContent = stamp;
  }

  /**
   * Build one card per heater the printer reports. Cards are created only when
   * the set of sensors changes, so the number input keeps focus and any
   * half-typed value survives the 2.5s poll.
   */
  function renderSensors(sensors) {
    const signature = sensors.map((s) => s.key).join(',');

    if (signature !== renderSensors.signature) {
      renderSensors.signature = signature;
      el.temps.innerHTML = '';

      if (!sensors.length) {
        el.temps.innerHTML = '<div class="card"><p class="muted small">No temperature data — the printer is offline.</p></div>';
        return;
      }

      for (const sensor of sensors) {
        const card = document.createElement('div');
        card.className = 'card temp-card';
        card.dataset.sensor = sensor.key;
        card.innerHTML = `
          <div class="row between">
            <h3></h3>
            <span class="temp-target">off</span>
          </div>
          <div class="temp-value"><span class="temp-actual">—</span><small>°C</small></div>
          <div class="temp-bar"><div class="temp-bar-fill"></div></div>
          <div class="temp-set">
            <input type="number" min="0" max="${sensor.max}" step="5" placeholder="target °C" inputmode="numeric">
            <button class="ghost small set-temp" type="button">Set</button>
            <button class="ghost small set-temp" data-value="0" type="button">Off</button>
          </div>`;
        card.querySelector('h3').textContent = sensor.label;

        for (const button of card.querySelectorAll('.set-temp')) {
          button.addEventListener('click', () => {
            const input = card.querySelector('input');
            const value = button.dataset.value !== undefined ? Number(button.dataset.value) : Number(input.value);
            if (!Number.isFinite(value) || (input.value === '' && button.dataset.value === undefined)) {
              toast('Enter a temperature first.', 'error');
              return;
            }
            withBusy(button, '…', async () => {
              await post('/api/control/temperature', { target: sensor.key, value });
              toast(`${sensor.label} set to ${value}°C.`, 'ok');
              input.value = '';
            });
          });
        }
        el.temps.appendChild(card);
      }
    }

    // Update values in place on every poll.
    for (const sensor of sensors) {
      const card = el.temps.querySelector(`[data-sensor="${sensor.key}"]`);
      if (!card) continue;

      card.querySelector('.temp-actual').textContent = fmtTemp(sensor.actual);
      card.querySelector('.temp-target').textContent =
        Number.isFinite(sensor.target) && sensor.target > 0 ? `target ${sensor.target.toFixed(0)}°C` : 'off';
      card.querySelector('.temp-bar-fill').style.width =
        `${Number.isFinite(sensor.actual) ? Math.max(0, Math.min(100, (sensor.actual / sensor.max) * 100)) : 0}%`;

      // Highlighted while a deviation is being timed, red once it has fired.
      card.classList.toggle('anomaly', Boolean(sensor.deviatingSince) && !sensor.alerting);
      card.classList.toggle('alerting', Boolean(sensor.alerting));
    }
  }

  /** Keep the extruder picker in step with whatever hotends actually exist. */
  function syncExtruderOptions(sensors) {
    const tools = sensors.filter((s) => s.kind === 'tool');
    const signature = tools.map((t) => t.key).join(',');
    if (signature === syncExtruderOptions.signature) return;
    syncExtruderOptions.signature = signature;

    el.extrudeTool.innerHTML = '';
    for (const tool of tools) {
      const option = document.createElement('option');
      option.value = tool.key;
      option.textContent = tool.label;
      el.extrudeTool.appendChild(option);
    }
  }

  // --- Temperature chart ---------------------------------------------------
  //
  // Hand-drawn on a canvas rather than pulling in a charting library: it is
  // about eighty lines, and a Pi serving a phone over a tunnel does not need
  // to ship 200 KB of JavaScript to draw three lines.

  const SERIES_COLOURS = ['#ff6b4a', '#ffc14a', '#4a9eff', '#3ecf8e', '#b47aff'];

  function seriesColour(key, index) {
    if (key === 'bed') return '#4a9eff';
    return SERIES_COLOURS[index % SERIES_COLOURS.length];
  }

  async function loadHistory() {
    try {
      const { samples } = await api('/api/history?limit=720');
      state.history = samples || [];
      drawChart();
    } catch {
      /* the chart is not important enough to surface an error for */
    }
  }

  function drawChart() {
    const canvas = el.chart;
    if (!canvas || canvas.offsetParent === null) return;   // panel is hidden

    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = 180;

    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const samples = state.history;
    if (samples.length < 2) {
      el.chartNote.textContent = 'Collecting data…';
      el.chartNote.hidden = false;
      return;
    }
    el.chartNote.hidden = true;

    const keys = [...new Set(samples.flatMap((s) => Object.keys(s).filter((k) => k !== 't')))].sort((a, b) => {
      if (a === 'bed') return 1;
      if (b === 'bed') return -1;
      return a.localeCompare(b, undefined, { numeric: true });
    });

    // Y range from the data, padded, with a sane floor so a cold printer does
    // not render as a jagged line across a 2-degree window.
    let max = 0;
    for (const s of samples) {
      for (const k of keys) {
        const v = s[k];
        if (v) {
          if (Number.isFinite(v.a)) max = Math.max(max, v.a);
          if (Number.isFinite(v.g)) max = Math.max(max, v.g);
        }
      }
    }
    const yMax = Math.max(60, Math.ceil((max * 1.15) / 20) * 20);
    const pad = { l: 34, r: 8, t: 8, b: 18 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;

    const x = (i) => pad.l + (i / (samples.length - 1)) * plotW;
    const y = (v) => pad.t + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

    // Grid + axis labels
    ctx.strokeStyle = '#262d39';
    ctx.fillStyle = '#8b94a7';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const value = (yMax / 4) * i;
      const yy = Math.round(y(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(width - pad.r, yy);
      ctx.stroke();
      ctx.fillText(String(Math.round(value)), pad.l - 6, yy);
    }

    // Time span label
    const spanMin = Math.round((samples[samples.length - 1].t - samples[0].t) / 60000);
    ctx.textAlign = 'left';
    ctx.fillText(`${spanMin} min`, pad.l, height - 8);

    keys.forEach((key, index) => {
      const colour = seriesColour(key, index);

      // Target, as a faint dashed line.
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = colour + '66';
      ctx.lineWidth = 1;
      let started = false;
      samples.forEach((s, i) => {
        const v = s[key];
        if (!v || !Number.isFinite(v.g) || v.g <= 0) { started = false; return; }
        if (!started) { ctx.moveTo(x(i), y(v.g)); started = true; }
        else ctx.lineTo(x(i), y(v.g));
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Actual, solid.
      ctx.beginPath();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      started = false;
      samples.forEach((s, i) => {
        const v = s[key];
        if (!v || !Number.isFinite(v.a)) { started = false; return; }
        if (!started) { ctx.moveTo(x(i), y(v.a)); started = true; }
        else ctx.lineTo(x(i), y(v.a));
      });
      ctx.stroke();
    });

    // Legend, rebuilt only when the set of series changes.
    const legendSig = keys.join(',');
    if (legendSig !== drawChart.legendSig) {
      drawChart.legendSig = legendSig;
      el.chartLegend.innerHTML = '';
      const labels = Object.fromEntries((state.snapshot?.sensors || []).map((s) => [s.key, s.label]));
      keys.forEach((key, index) => {
        const item = document.createElement('span');
        item.className = 'legend-item';
        item.innerHTML = '<span class="legend-swatch"></span><span></span>';
        item.querySelector('.legend-swatch').style.background = seriesColour(key, index);
        item.querySelector('span:last-child').textContent = labels[key] || key;
        el.chartLegend.appendChild(item);
      });
    }
  }

  // --- Polling -------------------------------------------------------------

  async function poll() {
    try {
      const snap = await api('/api/status');
      state.consecutiveFailures = 0;
      clearBanner('server-lost');
      render(snap);

      // Append to the local history so the chart moves between full reloads.
      const sample = { t: Date.now() };
      for (const sensor of snap.sensors || []) {
        sample[sensor.key] = { a: sensor.actual, g: sensor.target };
      }
      state.history.push(sample);
      if (state.history.length > 720) state.history.shift();
      if (state.activeTab === 'temps') drawChart();
    } catch (err) {
      state.consecutiveFailures += 1;
      // One blip on a phone connection is normal; three in a row is not.
      if (state.consecutiveFailures >= 3) {
        banner('server-lost', 'danger', err.message);
        el.stateDot.className = 'dot offline';
        el.stateLabel.textContent = 'No connection';
      }
    }
  }

  function startPolling() {
    stopPolling();
    poll();
    state.pollTimer = setInterval(poll, state.serverConfig?.pollIntervalMs || 2500);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // --- Events log ----------------------------------------------------------

  async function loadEvents() {
    try {
      const { events } = await api('/api/events?limit=60');
      el.eventList.innerHTML = '';

      if (!events.length) {
        el.eventList.innerHTML = '<li class="muted small">Nothing logged yet.</li>';
        return;
      }

      for (const event of events) {
        const li = document.createElement('li');
        li.className = `lvl-${event.level}`;
        const time = document.createElement('time');
        time.textContent = new Date(event.ts).toLocaleTimeString();
        const text = document.createElement('span');
        text.textContent = event.message;
        li.append(time, text);
        el.eventList.appendChild(li);
      }
    } catch {
      el.eventList.innerHTML = '<li class="muted small">Could not load events.</li>';
    }
  }

  // --- Print controls ------------------------------------------------------

  function wireControls() {
    el.btnPause.addEventListener('click', () => {
      const action = state.snapshot?.state === 'paused' ? 'resume' : 'pause';
      withBusy(el.btnPause, action === 'pause' ? 'Pausing…' : 'Resuming…', async () => {
        await post('/api/control/pause', { action });
        toast(action === 'pause' ? 'Print paused.' : 'Print resumed.', 'ok');
      });
    });

    el.btnCancel.addEventListener('click', async () => {
      const file = state.snapshot?.job?.file || 'the current print';
      const ok = await confirmAction({
        title: 'Cancel this print?',
        body: `This stops ${file} permanently. The partial print cannot be resumed — you would have to start over.`,
        confirmLabel: 'Cancel print',
        cancelLabel: 'Keep printing',
      });
      if (!ok) return;

      withBusy(el.btnCancel, 'Cancelling…', async () => {
        await post('/api/control/cancel');
        toast('Print cancelled.', 'ok');
      });
    });

    el.btnEstop.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Emergency stop?',
        body: 'Sends M112. All motors and heaters cut out instantly and the printer firmware halts. You will need to reconnect or power-cycle the printer, and the print is lost. Use this only if something is actually going wrong.',
        confirmLabel: 'Stop everything',
        cancelLabel: 'Never mind',
      });
      if (!ok) return;

      withBusy(el.btnEstop, '…', async () => {
        const result = await post('/api/control/emergency-stop');
        toast(result?.message || 'Emergency stop sent.', 'error');
        banner('estop', 'danger', 'Emergency stop sent. Power-cycle the printer, then press Reconnect.');
      });
    });

    el.btnReconnect.addEventListener('click', () => {
      withBusy(el.btnReconnect, 'Reconnecting…', async () => {
        await post('/api/control/reconnect');
        toast('Reconnect requested.', 'ok');
        clearBanner('estop');
      });
    });
  }

  // --- Move ----------------------------------------------------------------

  function wireMove() {
    for (const button of el.jogSteps.querySelectorAll('.step')) {
      button.addEventListener('click', () => {
        state.jogStep = Number(button.dataset.step);
        for (const b of el.jogSteps.querySelectorAll('.step')) b.classList.toggle('active', b === button);
      });
    }

    for (const button of $$('.jog[data-axis]')) {
      button.addEventListener('click', () => {
        const axis = button.dataset.axis;
        const distance = state.jogStep * Number(button.dataset.dir);
        withBusy(button, '·', async () => {
          await post('/api/control/jog', { axis, distance });
        });
      });
    }

    for (const button of $$('.jog[data-home]')) {
      button.addEventListener('click', () => {
        const axes = button.dataset.home.split(',');
        withBusy(button, '·', async () => {
          await post('/api/control/home', { axes });
          toast(`Homing ${axes.join(' and ').toUpperCase()}.`, 'ok');
        });
      });
    }

    el.homeAll.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Home all axes?',
        body: 'The toolhead will move to the origin. Make sure nothing is in the way.',
        confirmLabel: 'Home',
      });
      if (!ok) return;
      withBusy(el.homeAll, 'Homing…', async () => {
        await post('/api/control/home', { axes: [] });
        toast('Homing all axes.', 'ok');
      });
    });

    el.motorsOff.addEventListener('click', () => {
      withBusy(el.motorsOff, '…', async () => {
        await post('/api/control/command', { id: 'motorsOff' });
        toast('Motors released.', 'ok');
      });
    });

    const move = (sign) => {
      const amount = Number(el.extrudeAmount.value) * sign;
      const tool = el.extrudeTool.value || 'tool0';
      const button = sign > 0 ? el.btnExtrude : el.btnRetract;
      if (!Number.isFinite(amount) || amount === 0) {
        toast('Enter an amount in millimetres.', 'error');
        return;
      }
      withBusy(button, '…', async () => {
        await post('/api/control/extrude', { tool, amount });
        toast(`${sign > 0 ? 'Extruded' : 'Retracted'} ${Math.abs(amount)}mm.`, 'ok');
      });
    };
    el.btnExtrude.addEventListener('click', () => move(1));
    el.btnRetract.addEventListener('click', () => move(-1));
  }

  // --- Tune ----------------------------------------------------------------

  /** Sliders fire continuously while dragging; only send on release. */
  function wireSlider(slider, output, format, send) {
    const show = () => { output.textContent = format(Number(slider.value)); };
    slider.addEventListener('input', show);
    slider.addEventListener('change', async () => {
      try {
        await send(Number(slider.value));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    show();
  }

  function wireTune() {
    wireSlider(el.fanSlider, el.fanValue, (v) => `${v}%`, async (percent) => {
      await post('/api/control/fan', { percent });
      toast(`Fan ${percent}%.`, 'ok');
    });
    for (const button of $$('.preset[data-fan]')) {
      button.addEventListener('click', () => {
        el.fanSlider.value = button.dataset.fan;
        el.fanSlider.dispatchEvent(new Event('input'));
        el.fanSlider.dispatchEvent(new Event('change'));
      });
    }

    wireSlider(el.feedSlider, el.feedValue, (v) => `${v}%`, async (percent) => {
      await post('/api/control/feedrate', { percent });
      toast(`Print speed ${percent}%.`, 'ok');
    });

    wireSlider(el.flowSlider, el.flowValue, (v) => `${v}%`, async (percent) => {
      await post('/api/control/flow', { percent });
      toast(`Flow ${percent}%.`, 'ok');
    });

    for (const button of $$('[data-baby]')) {
      button.addEventListener('click', () => {
        const delta = Number(button.dataset.baby);
        withBusy(button, '…', async () => {
          await post('/api/control/babystep', { delta });
          toast(`Z ${delta > 0 ? '+' : ''}${delta}mm.`, 'ok');
        });
      });
    }
  }

  // --- Maintenance ---------------------------------------------------------

  async function loadMaintenance() {
    let commands = [];
    try {
      ({ commands } = await api('/api/control/commands'));
    } catch {
      return;
    }

    el.maintenance.innerHTML = '';
    for (const command of commands) {
      // Home and release-motors have dedicated controls on the Move tab.
      if (command.id === 'home' || command.id === 'motorsOff') continue;

      const button = document.createElement('button');
      button.className = 'ghost';
      button.textContent = command.label.replace(/ \(.*\)$/, '');
      button.title = command.gcode.join(' ; ');

      button.addEventListener('click', async () => {
        if (command.blockedWhilePrinting) {
          const ok = await confirmAction({
            title: `${button.textContent}?`,
            body: `This sends ${command.gcode.join(' and ')} to the printer.`,
            confirmLabel: 'Run it',
          });
          if (!ok) return;
        }
        withBusy(button, '…', async () => {
          await post('/api/control/command', { id: command.id });
          toast(`Sent ${command.gcode.join(', ')}.`, 'ok');
          loadEvents();
        });
      });
      el.maintenance.appendChild(button);
    }
  }

  // --- Stored files --------------------------------------------------------

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function loadFiles() {
    try {
      const { files } = await api('/api/files');
      el.fileList.innerHTML = '';

      if (!files.length) {
        el.fileList.innerHTML = '<li class="muted small">No files on the printer yet.</li>';
        return;
      }

      for (const file of files.slice(0, 40)) {
        const li = document.createElement('li');

        const meta = document.createElement('div');
        meta.className = 'file-meta';
        const name = document.createElement('strong');
        name.textContent = file.name;
        name.title = file.path;
        const sub = document.createElement('span');
        sub.className = 'muted small';
        sub.textContent = formatBytes(file.size);
        meta.append(name, sub);

        const printButton = document.createElement('button');
        printButton.className = 'ghost small';
        printButton.textContent = 'Print';
        printButton.addEventListener('click', async () => {
          const ok = await confirmAction({
            title: 'Start this print?',
            body: `${file.name} will be selected and printing will begin straight away. Make sure the bed is clear.`,
            confirmLabel: 'Start printing',
          });
          if (!ok) return;
          withBusy(printButton, '…', async () => {
            await post('/api/files/print', { path: file.path });
            toast(`Printing ${file.name}.`, 'ok');
          });
        });

        li.append(meta, printButton);
        el.fileList.appendChild(li);
      }
    } catch (err) {
      el.fileList.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = err.message;
      el.fileList.appendChild(li);
    }
  }

  // --- Upload --------------------------------------------------------------

  function selectFile(file) {
    if (!file) return;
    if (!/\.(gcode|gco|g)$/i.test(file.name)) {
      toast('That is not a G-code file. Expected .gcode, .gco or .g.', 'error');
      return;
    }
    if (file.size > 250 * 1024 * 1024) {
      toast('That file is larger than the 250 MB limit.', 'error');
      return;
    }

    state.pendingFile = file;
    el.fileName.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    el.fileChosen.hidden = false;
    el.btnUpload.disabled = false;
    el.uploadStatus.hidden = true;
  }

  function clearFile() {
    state.pendingFile = null;
    el.fileInput.value = '';
    el.fileChosen.hidden = true;
    el.btnUpload.disabled = true;
    el.uploadProgress.hidden = true;
    el.uploadFill.style.width = '0%';
  }

  /**
   * XHR rather than fetch: fetch still gives no upload progress events, and
   * a 200 MB G-code file over a phone tunnel needs a progress bar.
   */
  function uploadFile() {
    const file = state.pendingFile;
    if (!file) return;

    const startNow = el.startNow.checked;
    const form = new FormData();
    form.append('file', file);
    form.append('print', String(startNow));

    el.btnUpload.disabled = true;
    el.btnUpload.textContent = 'Uploading…';
    el.uploadProgress.hidden = false;
    el.uploadStatus.hidden = false;
    el.uploadStatus.className = 'small muted';
    el.uploadStatus.textContent = 'Starting upload…';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const pct = (event.loaded / event.total) * 100;
      el.uploadFill.style.width = `${pct}%`;
      el.uploadStatus.textContent =
        pct >= 100
          ? 'Upload complete — waiting for OctoPrint to accept the file…'
          : `Uploading… ${pct.toFixed(0)}%`;
    });

    const finish = (message, kind) => {
      el.btnUpload.textContent = 'Upload';
      el.btnUpload.disabled = !state.pendingFile;
      el.uploadStatus.className = `small ${kind === 'ok' ? 'muted' : 'error'}`;
      el.uploadStatus.textContent = message;
      poll();
      loadEvents();
      loadFiles();
    };

    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }

      if (xhr.status === 401) {
        showLogin();
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(
          data?.started
            ? `${data.filename} uploaded — the print is starting.`
            : `${data?.filename || file.name} uploaded to OctoPrint.`,
          'ok',
        );
        toast(data?.started ? 'Print started.' : 'File uploaded.', 'ok');
        clearFile();
      } else {
        finish(data?.error || `Upload failed (HTTP ${xhr.status}).`, 'error');
      }
    });

    xhr.addEventListener('error', () => finish('Upload failed — the connection dropped.', 'error'));
    xhr.addEventListener('abort', () => finish('Upload cancelled.', 'error'));
    xhr.addEventListener('timeout', () => finish('Upload timed out.', 'error'));

    xhr.send(form);
  }

  function wireUpload() {
    el.dropzone.addEventListener('click', () => el.fileInput.click());
    el.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        el.fileInput.click();
      }
    });

    el.fileInput.addEventListener('change', () => selectFile(el.fileInput.files[0]));
    el.fileClear.addEventListener('click', clearFile);
    el.btnUpload.addEventListener('click', uploadFile);

    for (const type of ['dragenter', 'dragover']) {
      el.dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        el.dropzone.classList.add('dragging');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      el.dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        el.dropzone.classList.remove('dragging');
      });
    }
    el.dropzone.addEventListener('drop', (event) => selectFile(event.dataTransfer?.files?.[0]));

    // Stop a stray drop elsewhere on the page from navigating away from the app.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  // --- Auth flow -----------------------------------------------------------

  function showLogin() {
    state.authenticated = false;
    stopPolling();
    stopCameraTimers();
    el.camera.src = '';
    el.dashboard.hidden = true;
    el.loginScreen.hidden = false;
    el.password.focus();
  }

  async function showDashboard() {
    state.authenticated = true;
    el.loginScreen.hidden = true;
    el.dashboard.hidden = false;

    try {
      state.serverConfig = await api('/api/config');
    } catch {
      state.serverConfig = null;
    }

    if (state.serverConfig && !state.serverConfig.notificationsConfigured) {
      banner('no-ntfy', 'info', 'Push notifications are off. Set NTFY_TOPIC_URL in .env to get alerts on your phone.');
    }

    initCamera();
    startPolling();
    loadHistory();
    loadEvents();
    loadMaintenance();
    loadFiles();
    setInterval(loadEvents, 30000);
  }

  function wireAuth() {
    el.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      el.loginError.hidden = true;
      el.loginButton.disabled = true;
      el.loginButton.textContent = 'Signing in…';

      try {
        await post('/api/login', { password: el.password.value });
        el.password.value = '';
        await showDashboard();
      } catch (err) {
        el.loginError.textContent = err.message;
        el.loginError.hidden = false;
      } finally {
        el.loginButton.disabled = false;
        el.loginButton.textContent = 'Sign in';
      }
    });

    el.logout.addEventListener('click', async () => {
      try { await post('/api/logout'); } catch { /* sign out locally anyway */ }
      showLogin();
    });
  }

  // --- Boot ----------------------------------------------------------------

  async function boot() {
    wireAuth();
    wireTabs();
    wireControls();
    wireMove();
    wireTune();
    wireUpload();
    el.refreshEvents.addEventListener('click', loadEvents);
    el.refreshFiles.addEventListener('click', loadFiles);
    window.addEventListener('resize', () => { if (state.activeTab === 'temps') drawChart(); });

    try {
      const session = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json());
      if (session.authenticated) await showDashboard();
      else showLogin();
    } catch {
      showLogin();
      el.loginError.textContent = 'Cannot reach the server.';
      el.loginError.hidden = false;
    }
  }

  boot();
})();
