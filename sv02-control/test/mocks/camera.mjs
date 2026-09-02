/**
 * A stand-in for the "IP Webcam" app on the phone: MJPEG at /video and a
 * still frame at /shot.jpg, so the relay can be tested without a phone.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Smallest valid JPEG (1x1). */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const BOUNDARY = 'mjpegboundary';

export function start(port = 5098) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/shot.jpg')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
      return res.end(JPEG);
    }

    if (req.url.startsWith('/video')) {
      res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}` });
      const timer = setInterval(() => {
        if (res.writableEnded) return clearInterval(timer);
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
        res.write(JPEG);
        return res.write('\r\n');
      }, 100);
      req.on('close', () => clearInterval(timer));
      return undefined;
    }

    res.writeHead(404).end();
    return undefined;
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is already in use, so the mock camera cannot start. ` +
              'Most likely a mock left running from an earlier run — stop it and try again.',
            )
          : err,
      );
    });
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(() => console.log('mock camera on 5098'));
}
