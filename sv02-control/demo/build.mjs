/**
 * Generates the static demo site from the real frontend.
 *
 * The point of building rather than hand-maintaining a copy is that the demo
 * always shows the actual app: app.js and styles.css are copied verbatim from
 * public/, and only index.html is modified, to load the in-browser mock
 * backend before the app boots.
 *
 *   node demo/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const outDir = path.join(here, 'dist');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Verbatim copies — these are the files the real server serves.
for (const name of ['app.js', 'styles.css']) {
  fs.copyFileSync(path.join(publicDir, name), path.join(outDir, name));
}
fs.copyFileSync(path.join(here, 'mock-backend.js'), path.join(outDir, 'mock-backend.js'));

// Self-hosted IBM Plex, so the demo renders in the real typeface too.
fs.cpSync(path.join(publicDir, 'fonts'), path.join(outDir, 'fonts'), { recursive: true });

let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

// The mock must install itself before app.js runs.
html = html.replace(
  '<script src="/app.js"></script>',
  '<script src="/mock-backend.js"></script>\n<script src="/app.js"></script>',
);

html = html
  .replace('<title>SV02 Control</title>', '<title>SV02 Control — Demo</title>')
  .replace(
    '</head>',
    `<meta name="description" content="Demo of a remote monitoring and control dashboard for a Sovol SV02 3D printer running OctoPrint.">
<meta name="robots" content="noindex">
</head>`,
  );

// A persistent banner, so nobody mistakes this for a printer they can drive.
html = html.replace(
  '<div id="banners" class="banners"></div>',
  `<div class="demo-note">
    <strong>Demo</strong> — simulated printer, no hardware attached. Every control works, but nothing is really moving.
  </div>
  <div id="banners" class="banners"></div>`,
);

html = html.replace(
  '</head>',
  `<style>
    .demo-note {
      background: rgba(76,141,255,.12);
      border: 1px solid rgba(76,141,255,.4);
      color: #bcd4ff;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      margin-bottom: 8px;
    }
  </style>
</head>`,
);

fs.writeFileSync(path.join(outDir, 'index.html'), html);

// --- Single-file build ------------------------------------------------------
//
// For hosts that serve one HTML file with no sibling assets (a Claude
// Artifact, an email attachment, a USB stick). Same content, everything
// inlined, and no <html>/<head>/<body> wrapper since the host supplies it.

const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const mockJs = fs.readFileSync(path.join(here, 'mock-backend.js'), 'utf8');

// Body markup only, taken from the built page so the two never diverge.
const bodyMarkup = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script src="\/(mock-backend|app)\.js"><\/script>\s*/g, '');

// `</script>` inside a string literal would close the inline block early.
const guard = (js) => js.replace(/<\/script>/gi, '<\\/script>');

const singleFile = `<title>SV02 Printer Control</title>
<style>
${css}
.demo-note {
  background: rgba(76,141,255,.12);
  border: 1px solid rgba(76,141,255,.4);
  color: #bcd4ff;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 8px;
}
</style>
${bodyMarkup}
<script>
${guard(mockJs)}
</script>
<script>
${guard(appJs)}
</script>
`;

fs.writeFileSync(path.join(outDir, 'single-file.html'), singleFile);

console.log(`Demo built into ${path.relative(process.cwd(), outDir)}`);
for (const file of fs.readdirSync(outDir)) {
  const { size } = fs.statSync(path.join(outDir, file));
  console.log(`  ${file} (${(size / 1024).toFixed(1)} KB)`);
}
