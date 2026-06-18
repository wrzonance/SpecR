import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '3001', 10);
const API_BASE = process.env.SPECR_API_BASE || 'http://127.0.0.1:3000';

const API_PREFIXES = [
  '/health',
  '/specs',
  '/parse',
  '/projects',
  '/libraries',
  '/packages',
  '/revisions',
  '/templates',
];

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function isApiPath(pathname) {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function proxyHeaders(req, body) {
  const headers = new Headers(req.headers);
  headers.delete('connection');
  headers.delete('host');
  headers.delete('content-length');
  if (body) headers.set('content-length', String(body.byteLength));
  return headers;
}

async function proxyApi(req, res, url) {
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readRequestBody(req);
    const upstream = await fetch(new URL(`${url.pathname}${url.search}`, API_BASE), {
      method: req.method,
      headers: proxyHeaders(req, body),
      body,
    });
    const headers = Object.fromEntries(upstream.headers);
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    res.writeHead(upstream.status, headers);
    const payload = Buffer.from(await upstream.arrayBuffer());
    res.end(payload);
  } catch (err) {
    sendJson(res, 502, {
      success: false,
      error: `demo proxy could not reach SpecR API at ${API_BASE}: ${err.message}`,
    });
  }
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const resolved = resolve(ROOT, `.${pathname}`);
  const rootWithSep = ROOT.endsWith(sep) ? ROOT : `${ROOT}${sep}`;
  if (!resolved.startsWith(rootWithSep)) {
    sendJson(res, 403, { success: false, error: 'forbidden' });
    return;
  }

  try {
    const stats = statSync(resolved);
    const file = stats.isDirectory() ? join(resolved, 'index.html') : resolved;
    const mime = MIME_TYPES.get(extname(file)) || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    createReadStream(file).pipe(res);
  } catch {
    const fallback = await readFile(join(ROOT, 'index.html'), 'utf8');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fallback);
  }
}

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (isApiPath(url.pathname)) {
    void proxyApi(req, res, url);
    return;
  }
  void serveStatic(req, res, url);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`SpecR web UI demo: http://127.0.0.1:${PORT}`);
  console.log(`Proxying API calls to: ${API_BASE}`);
});
