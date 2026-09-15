// Black-box test for the demo server's /vendor allowlist (#396). Spawns server.mjs
// and asserts (a) the lockfile-pinned markdown-it UMD bundle is served, and (b) the
// allowlist is EXACT: a real-but-unlisted file under node_modules is never served,
// proving the request path is used only as a map key, never joined into node_modules.
// Run: node --test examples/web_ui_demo/server.vendor.test.mjs
// Not part of CI (examples/ is outside the vitest projects).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
// markdown-it 15's UMD bundle ships without a license banner, so the marker is the
// UMD prologue's global assignment (`e.markdownit=t()`); index.html only ever mentions
// `window.markdownit` in prose, never assigns it, so the SPA fallback can't match this.
const UMD_GLOBAL_ASSIGNMENT = /\.markdownit\s*=/;

let child;
let port;

before(async () => {
  port = 3000 + (process.pid % 500) + 21; // never 3000/3001 (the live demo stack)
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitForPort(port);
});

after(async () => {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
});

test('GET /vendor/markdown-it.min.js serves the lockfile-pinned UMD bundle', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/vendor/markdown-it.min.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  const body = await res.text();
  assert.match(body, UMD_GLOBAL_ASSIGNMENT, 'expected the markdown-it UMD global assignment');
});

test('an unlisted /vendor file is not served from node_modules (exact allowlist)', async () => {
  // Only /vendor/markdown-it.min.js is allowlisted; a sibling spelling must fall through
  // to static serving and get the SPA fallback — never anything out of node_modules.
  const res = await fetch(`http://127.0.0.1:${port}/vendor/markdown-it.js`);
  const body = await res.text();
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.doesNotMatch(body, UMD_GLOBAL_ASSIGNMENT, 'must not leak an unlisted node_modules file');
});

async function waitForPort(p) {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await fetch(`http://127.0.0.1:${p}/`);
      if (probe.status) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`demo server did not come up on ${p}`);
}
