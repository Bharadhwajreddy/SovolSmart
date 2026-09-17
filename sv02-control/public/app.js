/* SV02 Control — instrument-panel frontend. Plain JS, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

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
    linkLatency: $('link-latency'),
    stateChip: $('state-chip'),
    stateLabel: $('state-label'),

    viewfinder: $('viewfinder'),
    camera: $('camera'),
    cameraOverlay: $('camera-overlay'),
    cameraMessage: $('camera-message'),
    cameraRetry: $('camera-retry'),
    cameraExpand: $('camera-expand'),
    cameraBadge: $('camera-badge'),
    cameraMode: $('camera-mode'),
    cameraClock: $('camera-clock'),
    cameraSpinner: document.querySelector('#camera-overlay .spinner'),

    viz2d: $('viz-2d'),
    viz3d: $('viz-3d'),
    vizEmpty2d: $('viz-empty-2d'),
    vizEmpty3d: $('viz-empty-3d'),
    vizCode: $('viz-code'),
    vizFollow: $('viz-follow'),
    vizSlider: $('viz-slider'),
    vizLayer: $('viz-layer'),
    vizZ: $('viz-z'),
    vizX: $('viz-x'),
    vizY: $('viz-y'),

    jobFile: $('job-file'),
    jobPercent: $('job-percent'),
    jobMeter: $('job-meter'),
    progressFill: $('progress-fill'),
    jobElapsed: $('job-elapsed'),
    jobRemaining: $('job-remaining'),
    jobEta: $('job-eta'),
    jobEstimate: $('job-estimate'),

    dockFile: $('dock-file'),
    dockPct: $('dock-pct'),
    dockFill: $('dock-fill'),
    btnPause: $('btn-pause'),
    btnCancel: $('btn-cancel'),
    btnEstop: $('btn-estop'),
    btnReconnect: $('btn-reconnect'),

    temps: $('temps'),
    watchCode: $('watch-code'),
    cooldownAll: $('cooldown-all'),

    chart: $('temp-chart'),
    chartWrap: $('chart-wrap'),
    chartLegend: $('chart-legend'),
    chartNote: $('chart-note'),
    chartTip: $('chart-tip'),
    chartRange: $('chart-range'),
    chartTableToggle: $('chart-table-toggle'),
    chartTable: $('chart-table'),

    jogSteps: $('jog-steps'),
    homeAll: $('home-all'),
    motorsOff: $('motors-off'),

    extrudeTool: $('extrude-tool'),
    extrudeReady: $('extrude-ready'),
    extrudeLengths: $('extrude-lengths'),
    extrudeAmount: $('extrude-amount'),
    btnExtrude: $('btn-extrude'),
    btnRetract: $('btn-retract'),

    fanSlider: $('fan-slider'),
    fanValue: $('fan-value'),
    feedSlider: $('feed-slider'),
    feedValue: $('feed-value'),
    flowSlider: $('flow-slider'),
    flowValue: $('flow-value'),
    babyTotal: $('baby-total'),

    maintenance: $('maintenance'),

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
    fileList: $('file-list'),
    refreshFiles: $('refresh-files'),

    eventList: $('event-list'),
    refreshEvents: $('refresh-events'),

    footerInfo: $('footer-info'),
    sbLinkItem: $('sb-link-item'),
    sbLink: $('sb-link'),
    sbPoll: $('sb-poll'),
    sbWatch: $('sb-watch'),
    sbAutopause: $('sb-autopause'),
    sbNotify: $('sb-notify'),

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
    eventsTimer: null,
    consecutiveFailures: 0,
    dismissedBanners: new Set(),
    activeTab: 'monitor',
    jogStep: 1,
    history: [],
    chartRange: 1800,
    chartTable: false,
    viz: {
      model: null,
      key: null,
      loading: false,
      layer: 0,
      follow: true,
      stackKey: '',
      stack2d: null,
      stack3d: null,
      nozzle: null,      // where the printer says it is
      shown: null,       // where the marker currently is, eased toward nozzle
      frame: null,
    },
    hoverT: null,
    extrudeTool: null,
    babyTotal: 0,
    linkMs: null,
  };

  // --- Constants -----------------------------------------------------------

  // Categorical order validated for CVD separation (see the dataviz palette):
  // slots are assigned to heaters in a fixed order and never cycled by rank.
  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  const INK = {
    surface: '#fdfcf9',
    grid: '#ebe9e3',
    axis: '#c3c2b7',
    muted: '#898781',
    crosshair: 'rgba(22, 24, 27, 0.35)',
  };

  const STATE_LABELS = {
    idle: 'Ready',
    printing: 'Printing',
    paused: 'Paused',
    error: 'Error',
    offline: 'Offline',
    connecting: 'Connecting…',
  };

  const PRESETS = {
    tool: [[0, 'Off'], [200, 'PLA'], [240, 'PETG']],
    bed: [[0, 'Off'], [60, 'PLA'], [80, 'PETG']],
  };

  const COLD_EXTRUDE_C = 170;

  // --- Formatting ----------------------------------------------------------

  const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  const fmtClock = (d) => d.toLocaleTimeString('en-GB', { hour12: false });
  const fmtHM = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  }

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtSigned(v, digits = 1) {
    if (!Number.isFinite(v)) return '—';
    const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
    return `${sign}${Math.abs(v).toFixed(digits)}`;
  }

  const codeFor = (key) => (key === 'bed' ? 'BED' : key.replace('tool', 'T'));

  /** Tools in numeric order, then the bed. */
  function sortKeys(keys) {
    return [...keys].sort((a, b) => {
      if (a === 'bed') return 1;
      if (b === 'bed') return -1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  /**
   * Colour is pinned to the heater, never to its rank or to which heaters
   * happened to exist when the page loaded: tool0 is always slot 1, tool1
   * slot 2, the bed slot 3. Those three validate all-pairs for colour-blind
   * separation, so any subset of them stays safe.
   */
  function colourFor(key) {
    if (key === 'bed') return SERIES[2];
    const n = Number(key.replace('tool', ''));
    if (n === 0) return SERIES[0];
    if (n === 1) return SERIES[1];
    return SERIES[(n + 1) % SERIES.length];
  }

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
    // away. On /api/login a 401 is simply a wrong password.
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

  const post = (path, body) =>
    api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  const GLYPHS = { danger: '✕', warn: '▲', info: 'i' };

  function banner(id, kind, message) {
    if (state.dismissedBanners.has(id)) return;
    const existing = el.banners.querySelector(`[data-id="${id}"]`);
    if (existing) {
      existing.querySelector('.text').textContent = message;
      return;
    }

    const node = document.createElement('div');
    node.className = `banner ${kind}`;
    node.dataset.id = id;
    node.setAttribute('role', kind === 'danger' ? 'alert' : 'status');

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = GLYPHS[kind] || '·';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => {
      state.dismissedBanners.add(id);
      node.remove();
    });

    node.append(glyph, text, close);
    el.banners.appendChild(node);
  }

  const clearBanner = (id) => el.banners.querySelector(`[data-id="${id}"]`)?.remove();

  function confirmAction({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      el.confirmTitle.textContent = title;
      el.confirmBody.textContent = body;
      el.confirmYes.textContent = confirmLabel;
      el.confirmNo.textContent = cancelLabel;
      el.confirmYes.className = danger ? 'btn btn-danger-solid' : 'btn btn-ink';

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

  /**
   * Disable a control for the duration of a request. Pass `label` to swap the
   * text; pass null for controls with structured content (the jog pad) that
   * should keep their markup and just dim.
   */
  async function withBusy(button, label, fn) {
    const keep = label === null;
    const original = keep ? null : button.textContent;
    button.disabled = true;
    button.classList.add('is-busy');
    if (!keep) button.textContent = label;
    try {
      await fn();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (!keep) button.textContent = original;
      button.classList.remove('is-busy');
      button.disabled = false;
      poll();
    }
  }

  const isPrinting = () => ['printing', 'paused'].includes(state.snapshot?.state);

  // --- Tabs (phone layout) -------------------------------------------------

  function wireTabs() {
    for (const tab of $$('.tab')) {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.tab;
        for (const t of $$('.tab')) {
          t.classList.toggle('active', t === tab);
          t.setAttribute('aria-selected', String(t === tab));
        }
        for (const panel of $$('.panel')) {
          panel.classList.toggle('active', panel.dataset.panel === state.activeTab);
        }
        // A canvas has no size while its panel is display:none, so redraw
        // once it is actually on screen.
        if (state.activeTab === 'monitor') drawChart();
        if (state.activeTab === 'monitor') state.viz.stackKey = '';
        if (state.activeTab === 'files') loadFiles();
        if (state.activeTab === 'log') loadEvents();
        window.scrollTo({ top: 0 });
      });
    }
  }

  // --- Camera --------------------------------------------------------------
  //
  // The stream can die for reasons entirely outside this app: the phone
  // reboots, WiFi drops, Android kills IP Webcam. So the camera never assumes
  // it is healthy — it retries with backoff, and if the stream will not hold
  // it degrades to polling single frames.

  const camera = {
    mode: 'stream',
    attempts: 0,
    retryTimer: null,
    watchdog: null,
    snapshotTimer: null,
    live: false,
    wired: false,
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

  function setCameraMode(mode) {
    camera.mode = mode;
    el.cameraMode.textContent = mode === 'stream' ? 'STREAM' : 'SNAPSHOT 1 Hz';
  }

  function stopCameraTimers() {
    clearTimeout(camera.retryTimer);
    clearTimeout(camera.watchdog);
    clearInterval(camera.snapshotTimer);
    camera.snapshotTimer = null;
  }

  function startStream() {
    stopCameraTimers();
    setCameraMode('stream');

    if (camera.attempts === 0) cameraOverlay('Connecting to camera…');
    else cameraOverlay(`Camera dropped — reconnecting (attempt ${camera.attempts + 1})…`);

    // Cache-buster: without it the browser may reuse the dead connection.
    el.camera.src = `/api/camera/stream?t=${Date.now()}`;

    camera.watchdog = setTimeout(() => {
      if (!camera.live) startSnapshotMode();
    }, 12000);
  }

  function scheduleStreamRetry() {
    stopCameraTimers();
    camera.attempts += 1;

    // 2s, 4s, 8s, 16s, then hold at 20s so a phone that is off overnight
    // does not hammer the network.
    const delay = Math.min(2000 * 2 ** (camera.attempts - 1), 20000);
    cameraOverlay(`Camera offline — retrying in ${Math.round(delay / 1000)}s`, { spinner: false, retry: true });

    camera.retryTimer = setTimeout(() => {
      if (camera.attempts > 4) startSnapshotMode();
      else startStream();
    }, delay);
  }

  function startSnapshotMode() {
    stopCameraTimers();
    setCameraMode('snapshot');
    cameraOverlay('Live stream unavailable — trying still frames…');

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
          cameraOverlay('Camera unreachable. Is the phone awake and IP Webcam’s server started?', {
            spinner: false,
            retry: true,
          });
        }
      };
      probe.src = `/api/camera/snapshot?t=${Date.now()}`;
    };

    tick();
    camera.snapshotTimer = setInterval(tick, 1000);

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
      cameraOverlay('No camera configured. Set PHONE_CAMERA_URL in the .env file.', { spinner: false });
      return;
    }

    if (!camera.wired) {
      camera.wired = true;
      el.camera.addEventListener('load', () => {
        if (camera.mode === 'stream') cameraHealthy();
      });
      el.camera.addEventListener('error', () => {
        if (camera.mode === 'stream' && state.authenticated) scheduleStreamRetry();
      });
      el.cameraRetry.addEventListener('click', () => {
        camera.attempts = 0;
        startStream();
      });
      el.cameraExpand.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else el.viewfinder.requestFullscreen?.();
      });
      // A backgrounded tab has its stream torn down by the browser.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.authenticated && !camera.live) {
          camera.attempts = 0;
          startStream();
        }
      });
    }

    startStream();
  }

  // --- Rendering -----------------------------------------------------------

  function render(snap) {
    state.snapshot = snap;

    el.stateChip.dataset.state = snap.state;
    el.stateLabel.textContent = STATE_LABELS[snap.state] || snap.state;

    if (snap.state === 'offline') {
      banner('offline', 'danger', snap.offlineReason || 'The printer is not reachable.');
    } else {
      clearBanner('offline');
      state.dismissedBanners.delete('offline');
    }

    renderJob(snap);
    renderVisualiser(snap);
    renderSensors(snap.sensors || []);
    renderExtruder(snap.sensors || []);

    const active = isPrinting();
    el.btnPause.disabled = !active;
    el.btnPause.textContent = snap.state === 'paused' ? 'Resume' : 'Pause';
    el.btnCancel.disabled = !active;
    el.btnReconnect.hidden = !(snap.state === 'offline' || snap.state === 'error');

    for (const jog of $$('.jog')) jog.disabled = active || snap.state === 'offline';
    el.homeAll.disabled = active || snap.state === 'offline';
    el.motorsOff.disabled = active || snap.state === 'offline';

    el.btnUpload.disabled = !state.pendingFile;
    el.footerInfo.textContent = snap.updatedAt ? fmtClock(new Date(snap.updatedAt)) : '—';
  }

  function renderJob(snap) {
    const job = snap.job || {};
    const file = job.file || null;
    const pct = Number.isFinite(job.completion) ? Math.max(0, Math.min(100, job.completion)) : null;
    const running = isPrinting();

    el.jobFile.textContent = file || 'No job loaded';
    el.jobFile.title = file || '';
    el.jobPercent.textContent = pct === null ? '—' : pct.toFixed(1);
    el.jobPercent.classList.toggle('is-empty', pct === null);
    el.progressFill.style.width = `${pct ?? 0}%`;
    el.jobMeter.setAttribute('aria-valuenow', pct === null ? '0' : pct.toFixed(1));

    el.jobElapsed.textContent = job.printTimeText || '—';
    el.jobRemaining.textContent = job.printTimeLeftText || '—';
    el.jobEta.textContent = running && Number.isFinite(job.printTimeLeft) && job.printTimeLeft > 0
      ? fmtHM(new Date(Date.now() + job.printTimeLeft * 1000))
      : '—';
    el.jobEstimate.textContent = Number.isFinite(job.estimatedTotal) ? fmtDuration(job.estimatedTotal) : '—';

    el.dockFile.textContent = file || 'No job loaded';
    el.dockPct.textContent = pct === null ? '—' : `${pct.toFixed(1)}%`;
    el.dockFill.style.width = `${pct ?? 0}%`;
  }

  /** Degrees per minute over the last ~20 s of history, or null. */
  function heatingRate(key) {
    const h = state.history;
    if (h.length < 3) return null;
    const last = h[h.length - 1];
    const now = last?.[key]?.a;
    if (!Number.isFinite(now)) return null;
    for (let i = h.length - 2; i >= 0; i -= 1) {
      const dt = last.t - h[i].t;
      if (dt >= 20000) {
        const then = h[i][key]?.a;
        if (!Number.isFinite(then)) return null;
        return ((now - then) / dt) * 60000;
      }
    }
    return null;
  }

  function buildGaugeScale(container, max, kind) {
    const minor = kind === 'bed' ? 10 : 25;
    const major = kind === 'bed' ? 30 : 50;
    for (let v = 0; v <= max + 0.001; v += minor) {
      const left = (v / max) * 100;
      const tick = document.createElement('span');
      tick.className = v % major === 0 ? 'tick major' : 'tick';
      tick.style.left = `${left}%`;
      container.appendChild(tick);

      if (v % major === 0) {
        const label = document.createElement('span');
        label.className = 'tick-label';
        if (v === 0) label.classList.add('first');
        else if (left > 94) label.classList.add('last');
        label.style.left = `${left}%`;
        label.textContent = String(v);
        container.appendChild(label);
      }
    }
  }

  function setTarget(sensor, value, button, label) {
    withBusy(button, label, async () => {
      await post('/api/control/temperature', { target: sensor.key, value });
      toast(value === 0 ? `${sensor.label} heater off.` : `${sensor.label} target ${value} °C.`, 'ok');
    });
  }

  function buildHeaterCard(sensor) {
    const card = document.createElement('article');
    card.className = 'heater temp-card';
    card.dataset.sensor = sensor.key;
    card.style.setProperty('--series', colourFor(sensor.key));

    card.innerHTML = `
      <div class="heater-head">
        <h3></h3>
        <span class="code"></span>
        <span class="status-chip" hidden></span>
      </div>
      <div class="heater-main">
        <div class="heater-value"><span class="temp-actual">—</span><span class="unit">°C</span></div>
        <dl class="heater-kv">
          <div><dt>Target °C</dt><dd class="v-target">—</dd></div>
          <div><dt>Δ °C</dt><dd class="v-delta">—</dd></div>
          <div><dt>°C / min</dt><dd class="v-rate">—</dd></div>
        </dl>
      </div>
      <div class="gauge" aria-hidden="true">
        <div class="gauge-track"><div class="gauge-fill"></div><div class="gauge-target" hidden></div></div>
        <div class="gauge-scale"></div>
      </div>
      <div class="heater-foot">
        <span class="heater-note">—</span>
        <div class="heater-set">
          <div class="seg presets" role="group"></div>
          <input class="input input-sm mono set-input" type="number" min="0" step="5" inputmode="numeric" placeholder="°C">
          <button class="btn btn-ink btn-sm set-temp" type="button">Set</button>
        </div>
      </div>`;

    card.querySelector('h3').textContent = sensor.label;
    // A shared nozzle is fed by every drive, so its tag names all of them.
    const drives = state.snapshot?.toolhead?.extruders || 1;
    card.querySelector('.code').textContent =
      state.snapshot?.toolhead?.sharedNozzle && sensor.kind === 'tool' && drives > 1
        ? Array.from({ length: drives }, (_, i) => `T${i}`).join('+')
        : codeFor(sensor.key);
    buildGaugeScale(card.querySelector('.gauge-scale'), sensor.max, sensor.kind);

    const input = card.querySelector('.set-input');
    input.max = String(sensor.max);
    input.setAttribute('aria-label', `${sensor.label} target temperature`);

    const presets = card.querySelector('.presets');
    presets.setAttribute('aria-label', `${sensor.label} presets`);
    for (const [value, material] of PRESETS[sensor.kind] || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = value === 0 ? 'OFF' : String(value);
      button.title = value === 0 ? 'Heater off' : `${material} · ${value} °C`;
      button.addEventListener('click', () => setTarget(sensor, value, button, null));
      presets.appendChild(button);
    }

    const setButton = card.querySelector('.set-temp');
    const submit = () => {
      const value = Number(input.value);
      if (input.value === '' || !Number.isFinite(value)) {
        toast('Enter a temperature first.', 'error');
        return;
      }
      setTarget(sensor, value, setButton, '…');
      input.value = '';
    };
    setButton.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });

    return card;
  }

  /**
   * One tile per heater the printer reports. Tiles are rebuilt only when the
   * set of sensors changes, so a half-typed target survives the poll.
   */
  function renderSensors(sensors) {
    const toolhead = state.snapshot?.toolhead || {};
    const signature = `${sensors.map((s) => s.key).join(',')}|${toolhead.sharedNozzle}|${toolhead.extruders}`;

    if (signature !== renderSensors.signature) {
      renderSensors.signature = signature;
      el.temps.replaceChildren();
      if (!sensors.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-row';
        empty.textContent = 'No temperature data — the printer is offline.';
        el.temps.appendChild(empty);
        return;
      }
      for (const sensor of sensors) el.temps.appendChild(buildHeaterCard(sensor));
    }

    const nowMs = state.snapshot?.updatedAt ? Date.parse(state.snapshot.updatedAt) : Date.now();

    for (const sensor of sensors) {
      const card = el.temps.querySelector(`[data-sensor="${sensor.key}"]`);
      if (!card) continue;
      const q = (sel) => card.querySelector(sel);

      const { actual, target, max } = sensor;
      const on = Number.isFinite(target) && target > 0;
      const delta = on && Number.isFinite(actual) ? actual - target : null;
      const rate = heatingRate(sensor.key);

      q('.temp-actual').textContent = fmt1(actual);
      q('.v-target').textContent = on ? target.toFixed(0) : 'OFF';
      q('.v-delta').textContent = delta === null ? '—' : fmtSigned(delta);
      q('.v-rate').textContent = rate === null ? '—' : Math.abs(rate) < 0.5 ? '0.0' : fmtSigned(rate);

      q('.gauge-fill').style.width = `${Number.isFinite(actual) ? Math.max(0, Math.min(100, (actual / max) * 100)) : 0}%`;
      const marker = q('.gauge-target');
      marker.hidden = !on;
      if (on) marker.style.left = `${Math.min(100, (target / max) * 100)}%`;

      let note;
      if (!on) {
        note = Number.isFinite(actual) && actual > 45 ? 'Heater off · cooling down' : 'Heater off';
      } else if (Math.abs(delta) <= 2) {
        note = 'Holding at target';
      } else if (rate !== null && Math.abs(rate) >= 0.5 && Math.sign(rate) === Math.sign(target - actual)) {
        const secs = (Math.abs(target - actual) / Math.abs(rate)) * 60;
        note = `${actual < target ? 'Heating' : 'Cooling'} · at target in ~${fmtDuration(secs)}`;
      } else {
        note = actual < target ? 'Heating' : 'Above target';
      }
      q('.heater-note').textContent = note;

      const chip = q('.status-chip');
      if (sensor.alerting) {
        chip.className = 'status-chip crit';
        chip.textContent = '✕ Fault';
        chip.hidden = false;
      } else if (sensor.deviatingSince) {
        const held = Math.max(0, Math.round((nowMs - Date.parse(sensor.deviatingSince)) / 1000));
        chip.className = 'status-chip warn';
        chip.textContent = `▲ Drift ${held}s`;
        chip.hidden = false;
      } else {
        chip.hidden = true;
      }

      card.classList.toggle('anomaly', Boolean(sensor.deviatingSince) && !sensor.alerting);
      card.classList.toggle('alerting', Boolean(sensor.alerting));
    }
  }

  // --- Extrusion -----------------------------------------------------------

  function renderExtruder(sensors) {
    const snap = state.snapshot || {};
    const tools = sensors.filter((s) => s.kind === 'tool');
    // Drives come from the printer profile, not from the heater list: the SV02
    // has two drives feeding one shared nozzle, and both can be extruded on.
    const drives = Math.max(snap.toolhead?.extruders || 0, tools.length);
    const shared = Boolean(snap.toolhead?.sharedNozzle);
    const keys = Array.from({ length: drives }, (_, i) => `tool${i}`);
    const signature = `${keys.join(',')}|${shared}`;

    if (signature !== renderExtruder.signature) {
      renderExtruder.signature = signature;
      if (!keys.includes(state.extrudeTool)) state.extrudeTool = keys[0] || null;
      el.extrudeTool.replaceChildren();
      for (const key of keys) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.tool = key;
        button.textContent = codeFor(key);
        button.title = `Extruder drive ${Number(key.replace('tool', '')) + 1}`;
        button.addEventListener('click', () => {
          state.extrudeTool = key;
          renderExtruder(state.snapshot?.sensors || []);
        });
        el.extrudeTool.appendChild(button);
      }
    }

    for (const button of $$('button', el.extrudeTool)) {
      button.classList.toggle('active', button.dataset.tool === state.extrudeTool);
    }

    // With a shared nozzle every drive melts filament in the same heater.
    const heater = tools.find((t) => t.key === (shared ? 'tool0' : state.extrudeTool)) || tools[0];
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    const text = document.createElement('span');

    if (!state.extrudeTool || !heater) {
      el.extrudeReady.className = 'ready-chip';
      glyph.textContent = '·';
      text.textContent = 'No hotend reported.';
      el.extrudeReady.replaceChildren(glyph, text);
      el.btnExtrude.disabled = true;
      el.btnRetract.disabled = true;
      return;
    }

    const hot = Number.isFinite(heater.actual) && heater.actual >= COLD_EXTRUDE_C;
    const reading = document.createElement('b');
    reading.textContent = `${fmt1(heater.actual)} °C`;
    const subject = shared ? 'Shared nozzle' : heater.label;

    if (isPrinting()) {
      el.extrudeReady.className = 'ready-chip';
      glyph.textContent = '‖';
      text.append(`${subject} at `, reading, ' — unavailable while printing');
    } else if (hot) {
      el.extrudeReady.className = 'ready-chip ok';
      glyph.textContent = '✓';
      text.append(`${subject} at `, reading, ` — ready to extrude on ${codeFor(state.extrudeTool)}`);
    } else {
      el.extrudeReady.className = 'ready-chip cold';
      glyph.textContent = '▲';
      text.append(`${subject} at `, reading, ` — heat to ${COLD_EXTRUDE_C} °C first`);
    }
    el.extrudeReady.replaceChildren(glyph, text);

    const blocked = !hot || isPrinting();
    el.btnExtrude.disabled = blocked;
    el.btnRetract.disabled = blocked;
  }

  // --- Temperature chart ---------------------------------------------------
  //
  // Hand-drawn on a canvas: roughly the size of a charting library's config
  // block, and a Pi serving a phone over a tunnel should not ship 200 KB of
  // JavaScript to draw three lines.

  function appendHistory(snap) {
    const t = snap.updatedAt ? Date.parse(snap.updatedAt) : Date.now();
    const last = state.history[state.history.length - 1];
    if (last && t <= last.t) return;

    const sample = { t };
    for (const sensor of snap.sensors || []) {
      sample[sensor.key] = { a: sensor.actual, g: sensor.target };
    }
    state.history.push(sample);
    if (state.history.length > 720) state.history.shift();
  }

  async function loadHistory() {
    try {
      const { samples } = await api('/api/history?limit=720');
      if (Array.isArray(samples) && samples.length) state.history = samples;
      drawChart();
    } catch {
      /* the chart fills from live polls instead */
    }
  }

  function visibleSamples() {
    const h = state.history;
    if (!h.length) return [];
    const start = h[h.length - 1].t - state.chartRange * 1000;
    return h.filter((s) => s.t >= start);
  }

  function niceScale(max) {
    const m = Math.max(50, max * 1.08);
    for (const step of [10, 20, 25, 50, 100]) {
      const n = Math.ceil(m / step);
      if (n <= 6) return { yMax: n * step, step };
    }
    return { yMax: Math.ceil(m / 100) * 100, step: 100 };
  }

  function niceTimeStep(spanMs) {
    const steps = [15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3];
    return steps.find((s) => spanMs / s <= 6) || 3600e3;
  }

  function nearestSample(samples, t) {
    if (t === null || !samples.length) return null;
    let best = samples[0];
    for (const s of samples) {
      if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    }
    return best;
  }

  function sensorLabels() {
    return Object.fromEntries((state.snapshot?.sensors || []).map((s) => [s.key, s.label]));
  }

  function tracePath(ctx, samples, key, field, x, y) {
    let open = false;
    ctx.beginPath();
    for (const s of samples) {
      const v = s[key]?.[field];
      const valid = Number.isFinite(v) && (field === 'a' || v > 0);
      if (!valid) {
        open = false;
        continue;
      }
      if (!open) {
        ctx.moveTo(x(s.t), y(v));
        open = true;
      } else {
        ctx.lineTo(x(s.t), y(v));
      }
    }
  }

  function dot(ctx, cx, cy, colour) {
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = INK.surface;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  function renderLegend(keys) {
    const signature = keys.join(',');
    const labels = sensorLabels();

    if (signature !== renderLegend.signature) {
      renderLegend.signature = signature;
      el.chartLegend.replaceChildren();
      for (const key of keys) {
        const item = document.createElement('span');
        item.className = 'legend-item';
        const swatch = document.createElement('i');
        swatch.className = 'legend-key';
        swatch.style.background = colourFor(key);
        const name = document.createElement('span');
        name.textContent = labels[key] || key;
        const value = document.createElement('span');
        value.className = 'legend-value';
        value.dataset.key = key;
        item.append(swatch, name, value);
        el.chartLegend.appendChild(item);
      }
      if (keys.length) {
        const hint = document.createElement('span');
        hint.className = 'legend-hint';
        const dash = document.createElement('i');
        dash.className = 'dash';
        hint.append(dash, 'Target');
        el.chartLegend.appendChild(hint);
      }
    }

    const byKey = Object.fromEntries((state.snapshot?.sensors || []).map((s) => [s.key, s]));
    for (const value of $$('.legend-value', el.chartLegend)) {
      value.textContent = `${fmt1(byKey[value.dataset.key]?.actual)} °C`;
    }
  }

  function renderChartTable(samples, keys) {
    const labels = sensorLabels();
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    const th = (text) => {
      const cell = document.createElement('th');
      cell.textContent = text;
      head.appendChild(cell);
    };
    th('Time');
    for (const key of keys) th(`${labels[key] || key} · actual / target`);

    const body = table.createTBody();
    const stride = Math.max(1, Math.ceil(samples.length / 24));
    for (let i = samples.length - 1; i >= 0; i -= stride) {
      const s = samples[i];
      const row = body.insertRow();
      row.insertCell().textContent = fmtClock(new Date(s.t));
      for (const key of keys) {
        const v = s[key];
        const targetText = v && Number.isFinite(v.g) && v.g > 0 ? v.g.toFixed(0) : 'off';
        row.insertCell().textContent = v ? `${fmt1(v.a)} / ${targetText}` : '—';
      }
    }
    el.chartTable.replaceChildren(table);
  }

  function drawChart() {
    const canvas = el.chart;
    if (!canvas || canvas.offsetParent === null) return;

    const width = el.chartWrap.clientWidth;
    const height = el.chartWrap.clientHeight;
    if (!width || !height) return;

    const ratio = window.devicePixelRatio || 1;
    const pxW = Math.round(width * ratio);
    const pxH = Math.round(height * ratio);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const samples = visibleSamples();
    // Chart only heaters that exist now. History can outlive a layout change --
    // e.g. samples taken before a shared-nozzle profile was re-read -- and a
    // vanished heater must not linger as a ghost line or legend entry.
    const live = new Set((state.snapshot?.sensors || []).map((s) => s.key));
    const seen = new Set(samples.flatMap((s) => Object.keys(s).filter((k) => k !== 't')));
    const keys = sortKeys([...seen].filter((k) => live.size === 0 || live.has(k)));
    renderLegend(keys);
    if (state.chartTable) renderChartTable(samples, keys);

    if (samples.length < 2) {
      el.chartNote.hidden = false;
      el.chartTip.hidden = true;
      drawChart.geom = null;
      return;
    }
    el.chartNote.hidden = true;

    let max = 0;
    for (const s of samples) {
      for (const key of keys) {
        const v = s[key];
        if (!v) continue;
        if (Number.isFinite(v.a)) max = Math.max(max, v.a);
        if (Number.isFinite(v.g)) max = Math.max(max, v.g);
      }
    }
    const { yMax, step } = niceScale(max);

    const pad = { l: 36, r: 14, t: 10, b: 24 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const t0 = samples[0].t;
    const t1 = samples[samples.length - 1].t;
    const span = Math.max(1, t1 - t0);
    const x = (t) => pad.l + ((t - t0) / span) * plotW;
    const y = (v) => pad.t + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

    ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.lineWidth = 1;

    // Value grid: solid hairlines, baseline one step darker.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= yMax + 0.001; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? INK.axis : INK.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(width - pad.r, yy);
      ctx.stroke();
      ctx.fillStyle = INK.muted;
      ctx.fillText(String(v), pad.l - 7, yy);
    }

    // Time axis.
    const tickMs = niceTimeStep(span);
    const withSeconds = tickMs < 60000;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(t0 / tickMs) * tickMs; t <= t1; t += tickMs) {
      const xx = Math.round(x(t)) + 0.5;
      ctx.strokeStyle = INK.axis;
      ctx.beginPath();
      ctx.moveTo(xx, pad.t + plotH);
      ctx.lineTo(xx, pad.t + plotH + 4);
      ctx.stroke();
      if (xx - pad.l < 18 || width - pad.r - xx < 18) continue;
      const d = new Date(t);
      ctx.fillStyle = INK.muted;
      ctx.fillText(withSeconds ? fmtClock(d) : fmtHM(d), xx, pad.t + plotH + 7);
    }

    // Series: target dashed (a threshold), actual solid 2px.
    for (const key of keys) {
      const colour = colourFor(key);

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = colour;
      tracePath(ctx, samples, key, 'g', x, y);
      ctx.stroke();
      ctx.restore();

      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = colour;
      tracePath(ctx, samples, key, 'a', x, y);
      ctx.stroke();
    }

    // End markers with a surface ring.
    const last = samples[samples.length - 1];
    for (const key of keys) {
      const v = last[key];
      if (v && Number.isFinite(v.a)) dot(ctx, x(last.t), y(v.a), colourFor(key));
    }

    drawChart.geom = { samples, pad, plotW, t0, span };

    // Crosshair + tooltip.
    const hovered = nearestSample(samples, state.hoverT);
    if (!hovered) {
      el.chartTip.hidden = true;
      return;
    }
    const hx = Math.round(x(hovered.t)) + 0.5;
    ctx.strokeStyle = INK.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, pad.t);
    ctx.lineTo(hx, pad.t + plotH);
    ctx.stroke();
    for (const key of keys) {
      const v = hovered[key];
      if (v && Number.isFinite(v.a)) dot(ctx, x(hovered.t), y(v.a), colourFor(key));
    }
    showTip(hovered, keys, hx, width);
  }

  function showTip(sample, keys, hx, width) {
    const labels = sensorLabels();
    const time = document.createElement('div');
    time.className = 'tip-time';
    time.textContent = fmtClock(new Date(sample.t));
    const rows = [time];

    for (const key of keys) {
      const v = sample[key];
      if (!v) continue;
      const row = document.createElement('div');
      row.className = 'tip-row';
      const swatch = document.createElement('i');
      swatch.className = 'legend-key';
      swatch.style.background = colourFor(key);
      const value = document.createElement('b');
      value.textContent = `${fmt1(v.a)}°`;
      const name = document.createElement('span');
      name.textContent = `${labels[key] || key} `;
      const target = document.createElement('em');
      target.textContent = Number.isFinite(v.g) && v.g > 0 ? `→ ${v.g.toFixed(0)}` : '→ off';
      name.appendChild(target);
      row.append(swatch, value, name);
      rows.push(row);
    }

    el.chartTip.replaceChildren(...rows);
    el.chartTip.hidden = false;
    const tipW = el.chartTip.offsetWidth;
    const left = hx + 14 + tipW > width ? hx - tipW - 14 : hx + 14;
    el.chartTip.style.left = `${Math.max(4, left)}px`;
  }

  function wireChart() {
    const onPointer = (event) => {
      const g = drawChart.geom;
      if (!g) return;
      const rect = el.chart.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const t = g.t0 + ((px - g.pad.l) / g.plotW) * g.span;
      state.hoverT = nearestSample(g.samples, t)?.t ?? null;
      drawChart();
    };
    el.chart.addEventListener('pointermove', onPointer);
    el.chart.addEventListener('pointerdown', onPointer);
    el.chart.addEventListener('pointerleave', () => {
      state.hoverT = null;
      el.chartTip.hidden = true;
      drawChart();
    });

    for (const button of $$('button', el.chartRange)) {
      button.addEventListener('click', () => {
        state.chartRange = Number(button.dataset.range);
        for (const b of $$('button', el.chartRange)) b.classList.toggle('active', b === button);
        state.hoverT = null;
        drawChart();
      });
    }

    el.chartTableToggle.addEventListener('click', () => {
      state.chartTable = !state.chartTable;
      el.chartTableToggle.setAttribute('aria-pressed', String(state.chartTable));
      el.chartTableToggle.textContent = state.chartTable ? 'Hide table' : 'Table';
      el.chartTable.hidden = !state.chartTable;
      drawChart();
    });

    let resizeFrame = null;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(drawChart);
    });
  }

  // --- Print visualiser ----------------------------------------------------
  //
  // Everything drawn here comes from the sliced file and OctoPrint's real byte
  // position in it: the layer, its shape, and how far along that layer the
  // nozzle is. It is a substitute for the camera, not a simulation.

  const VIZ_STACK_LAYERS = 60;   // how many layers the 3D view draws at once

  function vizCanvasSize(canvas) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return null;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    return { width, height, ratio };
  }

  /**
   * Fit the model's footprint into a canvas, flipping Y (printer Y is up).
   * The top padding is larger to clear the corner tag overlaying the canvas.
   */
  function vizFlat(bounds, width, height, padX = 14, padTop = 30, padBottom = 14) {
    const w = Math.max(bounds.maxX - bounds.minX, 1);
    const h = Math.max(bounds.maxY - bounds.minY, 1);
    const availW = width - padX * 2;
    const availH = height - padTop - padBottom;
    const scale = Math.min(availW / w, availH / h);
    const left = padX + (availW - w * scale) / 2;
    const top = padTop + (availH - h * scale) / 2;
    return (x, y) => [left + (x - bounds.minX) * scale, top + (h - (y - bounds.minY)) * scale];
  }

  /** Isometric projection, fitted by projecting the bounding box's corners. */
  function vizIso(bounds, width, height, padX = 14, padTop = 30, padBottom = 14) {
    const angle = Math.PI / 6;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const raw = (x, y, z) => {
      const dx = x - cx;
      const dy = y - cy;
      return [(dx - dy) * cos, (dx + dy) * sin - (z - bounds.minZ)];
    };

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const X of [bounds.minX, bounds.maxX]) {
      for (const Y of [bounds.minY, bounds.maxY]) {
        for (const Z of [bounds.minZ, bounds.maxZ]) {
          const [u, v] = raw(X, Y, Z);
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
    }

    const availW = width - padX * 2;
    const availH = height - padTop - padBottom;
    const scale = Math.min(availW / Math.max(maxU - minU, 1), availH / Math.max(maxV - minV, 1));
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    const centreX = padX + availW / 2;
    const centreY = padTop + availH / 2;
    return (x, y, z) => {
      const [u, v] = raw(x, y, z);
      return [centreX + (u - midU) * scale, centreY + (v - midV) * scale];
    };
  }

  function vizStrokeLayer(ctx, layer, project, colour, lineWidth) {
    ctx.beginPath();
    for (const path of layer.paths) {
      for (let i = 0; i < path.length; i += 2) {
        const [px, py] = project(path[i], path[i + 1], layer.z);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /**
   * Redraw the expensive part — every printed layer — into offscreen canvases.
   * Only the nozzle marker is drawn per frame on top of these.
   */
  function vizBuildStacks() {
    const { model } = state.viz;
    if (!model) return;

    const size2d = vizCanvasSize(el.viz2d);
    const size3d = vizCanvasSize(el.viz3d);
    if (!size2d || !size3d) return;

    const index = Math.max(0, Math.min(model.layers.length - 1, state.viz.layer));
    const key = `${state.viz.key}|${index}|${size2d.width}x${size2d.height}|${size3d.width}x${size3d.height}`;
    if (key === state.viz.stackKey) return;
    state.viz.stackKey = key;

    // --- 2D: this layer, with a few beneath it as context ---
    const flat = document.createElement('canvas');
    flat.width = el.viz2d.width;
    flat.height = el.viz2d.height;
    const fctx = flat.getContext('2d');
    fctx.setTransform(size2d.ratio, 0, 0, size2d.ratio, 0, 0);
    const project2d = vizFlat(model.bounds, size2d.width, size2d.height);
    const flatProject = (x, y) => project2d(x, y);

    for (let i = Math.max(0, index - 4); i < index; i += 1) {
      vizStrokeLayer(fctx, model.layers[i], flatProject, 'rgba(22, 24, 27, 0.10)', 1);
    }
    vizStrokeLayer(fctx, model.layers[index], flatProject, SERIES[0], 1.6);
    state.viz.stack2d = flat;

    // --- 3D: everything printed so far ---
    const iso = document.createElement('canvas');
    iso.width = el.viz3d.width;
    iso.height = el.viz3d.height;
    const ictx = iso.getContext('2d');
    ictx.setTransform(size3d.ratio, 0, 0, size3d.ratio, 0, 0);
    const project3d = vizIso(model.bounds, size3d.width, size3d.height);

    // Draw a bounded sample of the stack so a 400-layer print stays cheap.
    const stride = Math.max(1, Math.ceil(index / VIZ_STACK_LAYERS));
    for (let i = 0; i < index; i += stride) {
      vizStrokeLayer(ictx, model.layers[i], project3d, 'rgba(22, 24, 27, 0.13)', 1);
    }
    if (index > 0) vizStrokeLayer(ictx, model.layers[index - 1], project3d, 'rgba(22, 24, 27, 0.22)', 1);
    vizStrokeLayer(ictx, model.layers[index], project3d, SERIES[0], 1.6);
    state.viz.stack3d = iso;
  }

  function vizDrawMarker(ctx, px, py, size, ratio) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.beginPath();
    ctx.arc(px, py, size + 2, 0, Math.PI * 2);
    ctx.fillStyle = INK.surface;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fillStyle = '#16181b';
    ctx.fill();
  }

  function vizPaint() {
    const { model, stack2d, stack3d, shown } = state.viz;
    if (!model || !stack2d || !stack3d) return;

    const size2d = vizCanvasSize(el.viz2d);
    const size3d = vizCanvasSize(el.viz3d);
    if (!size2d || !size3d) return;

    const index = Math.max(0, Math.min(model.layers.length - 1, state.viz.layer));
    const layer = model.layers[index];

    const ctx2 = el.viz2d.getContext('2d');
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.clearRect(0, 0, el.viz2d.width, el.viz2d.height);
    ctx2.drawImage(stack2d, 0, 0);

    const ctx3 = el.viz3d.getContext('2d');
    ctx3.setTransform(1, 0, 0, 1, 0, 0);
    ctx3.clearRect(0, 0, el.viz3d.width, el.viz3d.height);
    ctx3.drawImage(stack3d, 0, 0);

    if (!shown) return;

    const [fx, fy] = vizFlat(model.bounds, size2d.width, size2d.height)(shown.x, shown.y);
    ctx2.setTransform(size2d.ratio, 0, 0, size2d.ratio, 0, 0);
    ctx2.strokeStyle = 'rgba(22, 24, 27, 0.18)';
    ctx2.lineWidth = 1;
    ctx2.beginPath();
    ctx2.moveTo(0, fy + 0.5);
    ctx2.lineTo(size2d.width, fy + 0.5);
    ctx2.moveTo(fx + 0.5, 0);
    ctx2.lineTo(fx + 0.5, size2d.height);
    ctx2.stroke();
    vizDrawMarker(ctx2, fx, fy, 4, size2d.ratio);

    const [ix, iy] = vizIso(model.bounds, size3d.width, size3d.height)(shown.x, shown.y, layer.z);
    vizDrawMarker(ctx3, ix, iy, 4, size3d.ratio);
  }

  /** Ease the marker toward the reported position between polls. */
  function vizFrame() {
    const viz = state.viz;
    if (viz.nozzle) {
      if (!viz.shown) viz.shown = { ...viz.nozzle };
      else {
        viz.shown.x += (viz.nozzle.x - viz.shown.x) * 0.16;
        viz.shown.y += (viz.nozzle.y - viz.shown.y) * 0.16;
      }
    }
    if (el.viz2d.offsetParent !== null) {
      vizBuildStacks();
      vizPaint();
    }
    viz.frame = requestAnimationFrame(vizFrame);
  }

  async function ensureVizModel(visual) {
    const viz = state.viz;
    if (!visual || visual.state !== 'ready' || !visual.key) return;
    if (viz.key === visual.key || viz.loading) return;

    viz.loading = true;
    try {
      const data = await api('/api/gcode/model');
      viz.model = data;
      viz.key = data.key;
      viz.layer = 0;
      viz.stackKey = '';
      viz.shown = null;
      el.vizSlider.max = String(Math.max(1, data.layers.length));
    } catch {
      /* the empty state already explains itself */
    } finally {
      viz.loading = false;
    }
  }

  const VIZ_MESSAGES = {
    idle: 'No file loaded. Start a print to see its layers.',
    loading: 'Reading the G-code…',
    unavailable: 'The layer view is unavailable for this file.',
  };

  function renderVisualiser(snap) {
    const visual = snap.visual || { state: 'idle' };
    const viz = state.viz;

    if (visual.state !== 'ready' && viz.key) {
      // The job ended or changed: drop the old model rather than show a stale one.
      viz.model = null;
      viz.key = null;
      viz.shown = null;
      viz.nozzle = null;
      viz.stackKey = '';
    }
    ensureVizModel(visual);

    const ready = Boolean(viz.model);
    const message = ready ? '' : (visual.error && visual.state === 'unavailable')
      ? visual.error
      : VIZ_MESSAGES[visual.state] || 'Loading layers…';
    el.vizEmpty2d.hidden = ready;
    el.vizEmpty3d.hidden = ready;
    if (!ready) {
      el.vizEmpty2d.textContent = message;
      el.vizEmpty3d.textContent = message;
      el.vizCode.textContent = visual.state === 'ready' ? 'loading layers' : (visual.state || 'no file loaded');
      el.vizLayer.textContent = '—';
      el.vizZ.textContent = '—';
      el.vizX.textContent = '—';
      el.vizY.textContent = '—';
      return;
    }

    const total = viz.model.layers.length;
    if (viz.follow && Number.isFinite(visual.layer)) viz.layer = visual.layer;
    viz.layer = Math.max(0, Math.min(total - 1, viz.layer));
    el.vizSlider.max = String(total);
    el.vizSlider.value = String(viz.layer + 1);

    if (visual.nozzle && viz.follow) viz.nozzle = visual.nozzle;

    const layer = viz.model.layers[viz.layer];
    el.vizLayer.textContent = `${viz.layer + 1} / ${total}`;
    el.vizZ.textContent = `${layer.z.toFixed(2)} mm`;
    el.vizX.textContent = viz.shown ? `${viz.shown.x.toFixed(1)} mm` : '—';
    el.vizY.textContent = viz.shown ? `${viz.shown.y.toFixed(1)} mm` : '—';
    el.vizCode.textContent = `${total} layers${viz.model.truncated ? ' · simplified' : ''}`;
  }

  function wireVisualiser() {
    el.vizSlider.addEventListener('input', () => {
      state.viz.layer = Number(el.vizSlider.value) - 1;
      state.viz.follow = false;
      el.vizFollow.setAttribute('aria-pressed', 'false');
      el.vizFollow.textContent = 'Follow print';
      paintSlider(el.vizSlider);
    });

    el.vizFollow.addEventListener('click', () => {
      state.viz.follow = !state.viz.follow;
      el.vizFollow.setAttribute('aria-pressed', String(state.viz.follow));
      el.vizFollow.textContent = state.viz.follow ? 'Following print' : 'Follow print';
    });

    let resizeFrame = null;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { state.viz.stackKey = ''; });
    });

    if (!state.viz.frame) state.viz.frame = requestAnimationFrame(vizFrame);
  }

  // --- Polling -------------------------------------------------------------

  function updateLink(ok) {
    const text = ok && state.linkMs !== null ? `${state.linkMs} ms` : 'lost';
    el.linkLatency.textContent = text;
    el.sbLink.textContent = text;
    el.sbLinkItem.dataset.state = ok ? 'idle' : 'offline';
  }

  async function poll() {
    const started = performance.now();
    try {
      const snap = await api('/api/status');
      state.linkMs = Math.round(performance.now() - started);
      state.consecutiveFailures = 0;
      clearBanner('server-lost');
      appendHistory(snap);
      render(snap);
      updateLink(true);
      drawChart();
    } catch (err) {
      state.consecutiveFailures += 1;
      // One blip on a phone connection is normal; three in a row is not.
      if (state.consecutiveFailures >= 3) {
        banner('server-lost', 'danger', err.message);
        el.stateChip.dataset.state = 'offline';
        el.stateLabel.textContent = 'No connection';
        updateLink(false);
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

  // --- Event log -----------------------------------------------------------

  async function loadEvents() {
    try {
      const { events } = await api('/api/events?limit=80');
      el.eventList.replaceChildren();

      if (!events.length) {
        const li = document.createElement('li');
        li.className = 'empty-row';
        li.textContent = 'Nothing logged yet.';
        el.eventList.appendChild(li);
        return;
      }

      for (const event of events) {
        const li = document.createElement('li');
        li.className = `lvl-${event.level}`;
        const time = document.createElement('time');
        const when = new Date(event.ts);
        time.dateTime = when.toISOString();
        time.textContent = fmtClock(when);
        const level = document.createElement('span');
        level.className = 'log-lvl';
        level.textContent = event.level === 'error' ? 'err' : event.level;
        const message = document.createElement('span');
        message.className = 'log-msg';
        message.textContent = event.message;
        li.append(time, level, message);
        el.eventList.appendChild(li);
      }
    } catch {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = 'Could not load events.';
      el.eventList.replaceChildren(li);
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
        body: `This stops ${file} permanently. A cancelled print cannot be resumed.`,
        confirmLabel: 'Cancel print',
        cancelLabel: 'Keep printing',
        danger: true,
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
        body: 'Sends M112. Every motor and heater cuts out instantly and the firmware halts. The print is lost and the printer needs a reconnect or power cycle.',
        confirmLabel: 'Stop everything',
        cancelLabel: 'Never mind',
        danger: true,
      });
      if (!ok) return;
      withBusy(el.btnEstop, '…', async () => {
        const result = await post('/api/control/emergency-stop');
        toast(result?.message || 'Emergency stop sent.', 'error');
        banner('estop', 'danger', 'Emergency stop sent. Power-cycle the printer, then press Reconnect printer.');
      });
    });

    el.btnReconnect.addEventListener('click', () => {
      withBusy(el.btnReconnect, 'Reconnecting…', async () => {
        await post('/api/control/reconnect');
        toast('Reconnect requested.', 'ok');
        clearBanner('estop');
      });
    });

    el.cooldownAll.addEventListener('click', async () => {
      if (isPrinting()) {
        const ok = await confirmAction({
          title: 'Turn off every heater?',
          body: 'A print is running. Cutting the heaters now will ruin it.',
          confirmLabel: 'Turn heaters off',
          danger: true,
        });
        if (!ok) return;
      }
      withBusy(el.cooldownAll, '…', async () => {
        await post('/api/control/command', { id: 'cooldown' });
        toast('All heaters off.', 'ok');
      });
    });
  }

  // --- Motion --------------------------------------------------------------

  function wireMotion() {
    for (const button of $$('.step', el.jogSteps)) {
      button.addEventListener('click', () => {
        state.jogStep = Number(button.dataset.step);
        for (const b of $$('.step', el.jogSteps)) b.classList.toggle('active', b === button);
      });
    }

    for (const button of $$('.jog[data-axis]')) {
      button.addEventListener('click', () => {
        const axis = button.dataset.axis;
        const distance = state.jogStep * Number(button.dataset.dir);
        withBusy(button, null, () => post('/api/control/jog', { axis, distance }));
      });
    }

    for (const button of $$('.jog[data-home]')) {
      button.addEventListener('click', () => {
        const axes = button.dataset.home.split(',');
        withBusy(button, null, async () => {
          await post('/api/control/home', { axes });
          toast(`Homing ${axes.join(' + ').toUpperCase()}.`, 'ok');
        });
      });
    }

    el.homeAll.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Home all axes?',
        body: 'The toolhead and bed move to their endstops. Make sure nothing is in the way.',
        confirmLabel: 'Home',
      });
      if (!ok) return;
      withBusy(el.homeAll, null, async () => {
        await post('/api/control/home', { axes: [] });
        toast('Homing all axes.', 'ok');
      });
    });

    el.motorsOff.addEventListener('click', () => {
      withBusy(el.motorsOff, null, async () => {
        await post('/api/control/command', { id: 'motorsOff' });
        toast('Motors released.', 'ok');
      });
    });

    for (const button of $$('button[data-len]', el.extrudeLengths)) {
      button.addEventListener('click', () => {
        el.extrudeAmount.value = button.dataset.len;
        for (const b of $$('button', el.extrudeLengths)) b.classList.toggle('active', b === button);
      });
    }
    el.extrudeAmount.addEventListener('input', () => {
      for (const b of $$('button', el.extrudeLengths)) {
        b.classList.toggle('active', b.dataset.len === el.extrudeAmount.value);
      }
    });

    const move = (sign) => {
      const length = Number(el.extrudeAmount.value);
      const button = sign > 0 ? el.btnExtrude : el.btnRetract;
      if (!Number.isFinite(length) || length <= 0) {
        toast('Enter a length in millimetres.', 'error');
        return;
      }
      const amount = length * sign;
      withBusy(button, '…', async () => {
        await post('/api/control/extrude', { tool: state.extrudeTool || 'tool0', amount });
        toast(`${sign > 0 ? 'Extruded' : 'Retracted'} ${length} mm on ${codeFor(state.extrudeTool || 'tool0')}.`, 'ok');
      });
    };
    el.btnExtrude.addEventListener('click', () => move(1));
    el.btnRetract.addEventListener('click', () => move(-1));
  }

  // --- Tuning --------------------------------------------------------------

  function paintSlider(slider) {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const pct = ((Number(slider.value) - min) / (max - min)) * 100;
    slider.style.setProperty('--pct', `${pct}%`);
  }

  /** Sliders fire continuously while dragging; only send on release. */
  function wireSlider(slider, output, send) {
    const show = () => {
      output.textContent = `${slider.value}%`;
      paintSlider(slider);
    };
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

  function setSlider(slider, value) {
    slider.value = String(value);
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));
  }

  function wireTune() {
    wireSlider(el.fanSlider, el.fanValue, async (percent) => {
      await post('/api/control/fan', { percent });
      toast(percent === 0 ? 'Fan off.' : `Fan ${percent}%.`, 'ok');
    });
    for (const button of $$('[data-fan]')) {
      button.addEventListener('click', () => setSlider(el.fanSlider, button.dataset.fan));
    }

    wireSlider(el.feedSlider, el.feedValue, async (percent) => {
      await post('/api/control/feedrate', { percent });
      toast(`Print speed ${percent}%.`, 'ok');
    });

    wireSlider(el.flowSlider, el.flowValue, async (percent) => {
      await post('/api/control/flow', { percent });
      toast(`Flow ${percent}%.`, 'ok');
    });

    for (const button of $$('[data-reset]')) {
      button.addEventListener('click', () => setSlider($(button.dataset.reset), 100));
    }

    for (const button of $$('[data-baby]')) {
      button.addEventListener('click', () => {
        const delta = Number(button.dataset.baby);
        withBusy(button, null, async () => {
          await post('/api/control/babystep', { delta });
          state.babyTotal = Math.round((state.babyTotal + delta) * 100) / 100;
          el.babyTotal.textContent = `${fmtSigned(state.babyTotal, 2)} mm`;
          toast(`Z ${fmtSigned(delta, 2)} mm.`, 'ok');
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

    el.maintenance.replaceChildren();
    for (const command of commands) {
      // Homing and releasing motors have dedicated controls under Motion.
      if (command.id === 'home' || command.id === 'motorsOff') continue;

      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'cmd-main';
      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = command.label.replace(/ \(.*\)$/, '');
      const meta = document.createElement('span');
      meta.className = 'cmd-meta';
      const gcode = document.createElement('code');
      gcode.className = 'cmd-gcode';
      gcode.textContent = command.gcode.join(' · ');
      const flag = document.createElement('span');
      flag.className = 'cmd-flag';
      flag.textContent = command.blockedWhilePrinting ? 'Idle only' : 'Any time';
      meta.append(gcode, flag);
      main.append(name, meta);

      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'btn btn-outline btn-sm';
      run.textContent = 'Run';
      run.addEventListener('click', async () => {
        if (command.blockedWhilePrinting) {
          const ok = await confirmAction({
            title: `${name.textContent}?`,
            body: `This sends ${command.gcode.join(' then ')} to the printer.`,
            confirmLabel: 'Run it',
          });
          if (!ok) return;
        }
        withBusy(run, '…', async () => {
          await post('/api/control/command', { id: command.id });
          toast(`Sent ${command.gcode.join(', ')}.`, 'ok');
          loadEvents();
        });
      });

      li.append(main, run);
      el.maintenance.appendChild(li);
    }
  }

  // --- Stored files --------------------------------------------------------

  async function loadFiles() {
    try {
      const { files } = await api('/api/files');
      el.fileList.replaceChildren();

      if (!files.length) {
        const li = document.createElement('li');
        li.className = 'empty-row';
        li.textContent = 'No files on the printer yet.';
        el.fileList.appendChild(li);
        return;
      }

      for (const file of files.slice(0, 60)) {
        const li = document.createElement('li');

        const glyph = document.createElement('span');
        glyph.className = 'file-glyph';
        glyph.textContent = (file.name.split('.').pop() || 'GCODE').slice(0, 5).toUpperCase();

        const meta = document.createElement('div');
        meta.className = 'file-meta';
        const name = document.createElement('strong');
        name.textContent = file.name;
        name.title = file.path;
        const sub = document.createElement('span');
        const parts = [fmtBytes(file.size)];
        if (Number.isFinite(file.uploaded)) {
          const d = new Date(file.uploaded * 1000);
          parts.push(`${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${fmtHM(d)}`);
        }
        if (Number.isFinite(file.estimatedPrintTime)) parts.push(`est ${fmtDuration(file.estimatedPrintTime)}`);
        sub.textContent = parts.join(' · ');
        meta.append(name, sub);

        const printButton = document.createElement('button');
        printButton.type = 'button';
        printButton.className = 'btn btn-outline btn-sm';
        printButton.textContent = 'Print';
        printButton.addEventListener('click', async () => {
          const ok = await confirmAction({
            title: 'Start this print?',
            body: `${file.name} will be selected and printing starts immediately. Make sure the bed is clear.`,
            confirmLabel: 'Start printing',
          });
          if (!ok) return;
          withBusy(printButton, '…', async () => {
            await post('/api/files/print', { path: file.path });
            toast(`Printing ${file.name}.`, 'ok');
          });
        });

        li.append(glyph, meta, printButton);
        el.fileList.appendChild(li);
      }
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = err.message;
      el.fileList.replaceChildren(li);
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
    el.fileName.textContent = `${file.name} · ${fmtBytes(file.size)}`;
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
   * a large G-code file over a phone tunnel needs a progress bar.
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
    el.uploadStatus.className = 'upload-status';
    el.uploadStatus.textContent = 'Starting upload…';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const pct = (event.loaded / event.total) * 100;
      el.uploadFill.style.width = `${pct}%`;
      el.uploadStatus.textContent = pct >= 100
        ? 'Upload complete — waiting for OctoPrint to accept the file…'
        : `Uploading… ${pct.toFixed(0)}%`;
    });

    const finish = (message, ok) => {
      el.btnUpload.textContent = 'Upload';
      el.btnUpload.disabled = !state.pendingFile;
      el.uploadStatus.className = ok ? 'upload-status' : 'upload-status error';
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
        finish(data?.started
          ? `${data.filename} uploaded — the print is starting.`
          : `${data?.filename || file.name} uploaded to OctoPrint.`, true);
        toast(data?.started ? 'Print started.' : 'File uploaded.', 'ok');
        clearFile();
      } else {
        finish(data?.error || `Upload failed (HTTP ${xhr.status}).`, false);
      }
    });

    xhr.addEventListener('error', () => finish('Upload failed — the connection dropped.', false));
    xhr.addEventListener('abort', () => finish('Upload cancelled.', false));
    xhr.addEventListener('timeout', () => finish('Upload timed out.', false));

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

    // Stop a stray drop elsewhere on the page from navigating away.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  // --- Clock ---------------------------------------------------------------

  function tickClock() {
    const now = fmtClock(new Date());
    el.clock.textContent = now;
    el.cameraClock.textContent = now;
  }

  // --- Auth flow -----------------------------------------------------------

  function showLogin() {
    state.authenticated = false;
    stopPolling();
    stopCameraTimers();
    clearInterval(state.eventsTimer);
    state.eventsTimer = null;
    el.camera.removeAttribute('src');
    el.dashboard.hidden = true;
    el.loginScreen.hidden = false;
    el.password.focus();
  }

  function applyServerConfig(cfg) {
    if (!cfg) return;
    el.watchCode.textContent = `WATCH ±${cfg.thresholdC} °C · ${cfg.holdSeconds} s`;
    el.sbPoll.textContent = `${(cfg.pollIntervalMs / 1000).toFixed(1)} s`;
    el.sbWatch.textContent = `±${cfg.thresholdC} °C / ${cfg.holdSeconds} s`;
    el.sbAutopause.textContent = cfg.autoPause ? 'on' : 'off';
    el.sbNotify.textContent = cfg.notificationsConfigured ? 'on' : 'off';
    if (!cfg.notificationsConfigured) {
      banner('no-ntfy', 'info', 'Push notifications are off. Set NTFY_TOPIC_URL in .env to get alerts on your phone.');
    }
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
    applyServerConfig(state.serverConfig);

    initCamera();
    startPolling();
    loadHistory();
    loadEvents();
    loadMaintenance();
    loadFiles();
    clearInterval(state.eventsTimer);
    state.eventsTimer = setInterval(loadEvents, 30000);
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
    wireMotion();
    wireTune();
    wireUpload();
    wireChart();
    wireVisualiser();
    el.refreshEvents.addEventListener('click', loadEvents);
    el.refreshFiles.addEventListener('click', loadFiles);

    tickClock();
    setInterval(tickClock, 1000);

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
