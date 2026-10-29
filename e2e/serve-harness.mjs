// Minimal static server for the test-only PC harness (harness/pc.html + dist/pc.js).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.HARNESS_PORT ?? 8796);
const files = {
  '/pc.html': [join(here, 'harness/pc.html'), 'text/html; charset=utf-8'],
  '/pc.js': [join(here, 'dist/pc.js'), 'text/javascript; charset=utf-8'],
};
createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') return res.writeHead(200).end('ok');
  const f = files[path];
  if (!f) return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-store' }).end(await readFile(f[0]));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, '127.0.0.1', () => console.log(`[harness] http://127.0.0.1:${port}/pc.html`));
