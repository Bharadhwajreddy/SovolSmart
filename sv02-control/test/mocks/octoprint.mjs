/**
 * A stand-in for OctoPrint, so the app can be tested without a printer.
 *
 * Modelled on a dual-extruder SV02: tool0, tool1 and bed. Send SIGUSR2 to
 * toggle a thermal fault on tool0.
 */
import http from 'node:http';
import { makeGcode } from './make-gcode.mjs';

/** The file the mock pretends to be printing, served for indexing. */
export const GCODE = makeGcode();

/** How far through that file the mock claims to be. */
let filepos = Math.floor(GCODE.length * 0.55);
export const setFilepos = (n) => { filepos = n; };
export const getFilepos = () => filepos;

let mode = process.env.MOCK_MODE || 'printing';

/** Every request body the app sent, so tests can assert on what was sent. */
export const received = [];

const printer = () => ({
  temperature: {
    tool0: { actual: mode === 'anomaly' ? 150.2 : 209.8, target: 210, offset: 0 },
    tool1: { actual: 24.3, target: 0, offset: 0 },
    bed: { actual: 59.7, target: 60, offset: 0 },
  },
  state: {
    text: mode === 'printing' || mode === 'anomaly' ? 'Printing' : 'Operational',
    flags: {
      operational: true,
      printing: mode === 'printing' || mode === 'anomaly',
      paused: mode === 'paused',
      error: false,
      closedOrError: false,
      ready: mode === 'idle',
    },
  },
});

const job = () => ({
  job: {
    file: { name: 'benchy_v3.gcode', path: 'benchy_v3.gcode', size: GCODE.length },
    estimatedPrintTime: 5400,
  },
  progress: { completion: 42.7, printTime: 2310, printTimeLeft: 3090, filepos },
  state: mode === 'printing' ? 'Printing' : 'Operational',
});

const fileListing = {
  files: [
    { type: 'machinecode', name: 'benchy_v3.gcode', path: 'benchy_v3.gcode', size: 4823901, date: 1786900000 },
    {
      type: 'folder',
      name: 'brackets',
      children: [
        { type: 'machinecode', name: 'bracket_v2.gcode', path: 'brackets/bracket_v2.gcode', size: 1200000, date: 1786910000 },
      ],
    },
    { type: 'machinecode', name: 'old_test.gcode', path: 'old_test.gcode', size: 90000, date: 1786800000 },
  ],
};

export function start(port = 5099) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Every real OctoPrint call must carry the key; this is what proves the
    // app is authenticating rather than getting lucky.
    if (!req.headers['x-api-key']) return json(403, { error: 'missing api key' });

    // OctoPrint answers 409 on /api/printer when no printer is connected.
    if (mode === 'disconnected' && url.pathname === '/api/printer') {
      return json(409, { error: 'Printer is not operational' });
    }

    if (req.method === 'GET') {
      // OctoPrint serves the raw G-code here; the layer view downloads it.
      if (url.pathname.startsWith('/downloads/files/local/')) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(GCODE) });
        return res.end(GCODE);
      }
      if (url.pathname === '/api/printer') return json(200, printer());
      if (url.pathname === '/api/job') return json(200, job());
      if (url.pathname === '/api/version') return json(200, { server: '1.10.0' });
      if (url.pathname === '/api/connection') {
        return json(200, {
          current: { state: mode === 'disconnected' ? 'Closed' : 'Operational', port: serialPorts[0] ?? null },
          options: { ports: serialPorts, baudrates: [250000, 115200, 57600] },
        });
      }
      if (url.pathname === '/api/files/local') return json(200, fileListing);
      return json(404, { error: 'not found' });
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try {
        body = JSON.parse(raw.toString());
      } catch {
        body = { __raw: raw.length };
      }
      received.push({ method: req.method, path: url.pathname, body });

      if (url.pathname === '/api/files/local') {
        return json(201, { done: true, files: { local: { name: 'uploaded.gcode' } } });
      }
      if (url.pathname === '/api/job') {
        if (body.command === 'pause') mode = body.action === 'resume' ? 'printing' : 'paused';
        if (body.command === 'cancel') mode = 'idle';
      }
      if (url.pathname.startsWith('/api/files/local/') && body.command === 'select' && body.print) {
        mode = 'printing';
      }
      return res.writeHead(204).end();
    });
  });

  process.on('SIGUSR2', () => {
    mode = mode === 'anomaly' ? 'printing' : 'anomaly';
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is already in use, so the mock OctoPrint cannot start. ` +
              'Most likely a mock left running from an earlier run — stop it and try again.',
            )
          : err,
      );
    });
    server.listen(port, () => resolve(server));
  });
}

export const setMode = (next) => { mode = next; };

/** Whether the mock pretends a serial port exists. */
let serialPorts = ['/dev/ttyUSB0'];
export const setPorts = (ports) => { serialPorts = ports; };
export const getMode = () => mode;

// Allow running standalone: `node test/mocks/octoprint.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log('mock OctoPrint on 5099'));
}
