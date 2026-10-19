/**
 * A stand-in for ntfy.sh, so notification delivery can be asserted.
 *
 * Worth mocking rather than trusting: a text notification is a POST with the
 * message as the body, but a notification with a photo is a PUT whose body is
 * the image and whose text moves into a header. That difference is easy to
 * get wrong and impossible to notice without checking what was actually sent.
 */
import http from 'node:http';

export const received = [];

export function start(port = 5097) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({
        method: req.method,
        title: req.headers.title,
        priority: req.headers.priority,
        contentType: req.headers['content-type'],
        filename: req.headers.filename,
        messageHeader: req.headers.message,
        bodyIsJpeg: body.length > 2 && body[0] === 0xff && body[1] === 0xd8,
        bodyText: body.length < 2000 ? body.toString('utf8') : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use, so the mock ntfy cannot start.`)
          : err,
      );
    });
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log('mock ntfy on 5097'));
}
