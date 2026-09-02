/* SV02 Control — single-page frontend, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    loginScreen: $('login-screen'),
    loginForm: $('login-form'),
    loginButton: $('login-button'),
    password: $('password'),
    loginError: $('login-error'),

    dashboard: $('dashboard'),
    logout: $('logout'),
    banners: $('banners'),

    stateDot: $('state-dot'),
    stateLabel: $('state-label'),

    camera: $('camera'),
    cameraOverlay: $('camera-overlay'),
    cameraMessage: $('camera-message'),
    cameraRetry: $('camera-retry'),
    cameraBadge: document.querySelector('.camera-badge'),
    cameraSpinner: document.querySelector('.camera-overlay .spinner'),

    jobFile: $('job-file'),
    jobPercent: $('job-percent'),
    progressFill: $('progress-fill'),
    jobElapsed: $('job-elapsed'),
    jobRemaining: $('job-remaining'),

    temps: $('temps'),
    maintenance: $('maintenance'),
    fileList: $('file-list'),
    refreshFiles: $('refresh-files'),

    btnPause: $('btn-pause'),
    btnCancel: $('btn-cancel'),
    btnEstop: $('btn-estop'),
    btnReconnect: $('btn-reconnect'),

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

    // State indicator
    el.stateDot.className = `dot ${snap.state}`;
    el.stateLabel.textContent = STATE_LABELS[snap.state] || snap.state;

    // Offline banner
    if (snap.state === 'offline') {
      banner('offline', 'danger', snap.offlineReason || 'The printer is not reachable.');
    } else {
      clearBanner('offline');
      state.dismissedBanners.delete('offline');
    }

    // Job
    const job = snap.job || {};
    el.jobFile.textContent = job.file || 'No job loaded';
    el.jobFile.title = job.file || '';

    const pct = Number.isFinite(job.completion) ? job.completion : null;
    el.jobPercent.textContent = pct === null ? '—' : `${pct.toFixed(1)}%`;
    el.progressFill.style.width = `${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%`;
    el.jobElapsed.textContent = `Elapsed ${job.printTimeText || '—'}`;
    el.jobRemaining.textContent = `Remaining ${job.printTimeLeftText || '—'}`;

    renderSensors(snap.sensors || []);

    // Controls
    const printing = snap.state === 'printing';
    const paused = snap.state === 'paused';
    const active = printing || paused;

    el.btnPause.disabled = !active;
    el.btnPause.textContent = paused ? 'Resume' : 'Pause';
    el.btnPause.classList.toggle('primary', true);
    el.btnCancel.disabled = !active;
    el.btnReconnect.hidden = !(snap.state === 'offline' || snap.state === 'error');

    // Upload button
    el.btnUpload.disabled = !state.pendingFile;

    // Footer
    const stamp = snap.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : '—';
    el.footerInfo.textContent = `Last update ${stamp}`;
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
            <span class="temp-target">→ —</span>
          </div>
          <div class="temp-value"><span class="temp-actual">—</span><small>°C</small></div>
          <div class="temp-bar"><div class="temp-bar-fill"></div></div>
          <div class="temp-set">
            <input type="number" min="0" max="${sensor.max}" step="5" placeholder="°C" inputmode="numeric">
            <button class="ghost small set-temp" type="button">Set</button>
            <button class="ghost small set-temp" data-value="0" type="button">Off</button>
          </div>`;
        card.querySelector('h3').textContent = sensor.label;

        for (const button of card.querySelectorAll('.set-temp')) {
          button.addEventListener('click', () => {
            const input = card.querySelector('input');
            const value = button.dataset.value !== undefined ? Number(button.dataset.value) : Number(input.value);
            if (!Number.isFinite(value) || input.value === '' && button.dataset.value === undefined) {
              toast('Enter a temperature first.', 'error');
              return;
            }
            withBusy(button, '…', async () => {
              await api('/api/control/temperature', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target: sensor.key, value }),
              });
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
        Number.isFinite(sensor.target) && sensor.target > 0 ? `→ ${sensor.target.toFixed(0)}°C` : 'off';
      card.querySelector('.temp-bar-fill').style.width =
        `${Number.isFinite(sensor.actual) ? Math.max(0, Math.min(100, (sensor.actual / sensor.max) * 100)) : 0}%`;

      // Highlighted while a deviation is being timed, before it becomes an alert.
      card.classList.toggle('anomaly', Boolean(sensor.deviatingSince));
    }
  }

  // --- Polling -------------------------------------------------------------

  async function poll() {
    try {
      const snap = await api('/api/status');
      state.consecutiveFailures = 0;
      clearBanner('server-lost');
      render(snap);
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
      const { events } = await api('/api/events?limit=40');
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

  // --- Controls ------------------------------------------------------------

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

  function wireControls() {
    el.btnPause.addEventListener('click', () => {
      const action = state.snapshot?.state === 'paused' ? 'resume' : 'pause';
      withBusy(el.btnPause, action === 'pause' ? 'Pausing…' : 'Resuming…', async () => {
        await api('/api/control/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
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
        await api('/api/control/cancel', { method: 'POST' });
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

      withBusy(el.btnEstop, 'Stopping…', async () => {
        const result = await api('/api/control/emergency-stop', { method: 'POST' });
        toast(result?.message || 'Emergency stop sent.', 'error');
        banner('estop', 'danger', 'Emergency stop sent. Power-cycle the printer, then press Reconnect.');
      });
    });

    el.btnReconnect.addEventListener('click', () => {
      withBusy(el.btnReconnect, 'Reconnecting…', async () => {
        await api('/api/control/reconnect', { method: 'POST' });
        toast('Reconnect requested.', 'ok');
        clearBanner('estop');
      });
    });

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
      const button = document.createElement('button');
      button.className = 'ghost small';
      button.textContent = command.label.replace(/ \(.*\)$/, '');
      button.title = command.gcode.join(' ; ');

      button.addEventListener('click', async () => {
        // Homing mid-print would drive the toolhead through the model.
        if (command.blockedWhilePrinting) {
          const ok = await confirmAction({
            title: button.textContent + '?',
            body: `This sends ${command.gcode.join(' and ')} to the printer.`,
            confirmLabel: 'Run it',
            cancelLabel: 'Cancel',
          });
          if (!ok) return;
        }
        withBusy(button, '…', async () => {
          await api('/api/control/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: command.id }),
          });
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

      for (const file of files.slice(0, 25)) {
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
            cancelLabel: 'Cancel',
          });
          if (!ok) return;
          withBusy(printButton, '…', async () => {
            await api('/api/files/print', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: file.path }),
            });
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
      el.uploadStatus.className = `small ${kind === 'ok' ? '' : 'error'}`;
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
        await api('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: el.password.value }),
        });
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
      try { await api('/api/logout', { method: 'POST' }); } catch { /* sign out locally anyway */ }
      showLogin();
    });
  }

  // --- Boot ----------------------------------------------------------------

  async function boot() {
    wireAuth();
    wireControls();
    wireUpload();
    el.refreshEvents.addEventListener('click', loadEvents);
    el.refreshFiles.addEventListener('click', loadFiles);

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
