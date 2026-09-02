/**
 * A stand-in for OctoPrint, so the app can be tested without a printer.
 *
 * Modelled on a dual-extruder SV02: tool0, tool1 and bed. Send SIGUSR2 to
 * toggle a thermal fault on tool0.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

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
  job: { file: { name: 'benchy_v3.gcode', size: 4823901 }, estimatedPrintTime: 5400 },
  progress: { completion: 42.7, printTime: 2310, printTimeLeft: 3090 },
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

    if (req.method === 'GET') {
      if (url.pathname === '/api/printer') return json(200, printer());
      if (url.pathname === '/api/job') return json(200, job());
      if (url.pathname === '/api/version') return json(200, { server: '1.10.0' });
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
export const getMode = () => mode;

// Allow running standalone: `node test/mocks/octoprint.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(() => console.log('mock OctoPrint on 5099'));
}
