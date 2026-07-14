// Boundary tests for api.js's internal getJsonOrNull request helper (#477),
// exercised through getClientHeaderFooter — the header/footer GET wrapper
// that uses it. "Not configured" (404, per src/api/header-footer.ts's
// getHeaderFooterConfig) is a valid, expected state for a scope with no
// config row yet: it must resolve `null`, never throw. Every other non-2xx
// or envelope failure must throw an Error carrying `.status` so callers can
// branch (mirrors sendJson's existing contract). Run:
//   node --test examples/web_ui_demo/api-header-footer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientHeaderFooter } from './js/api.js';

const LIBRARY_ID = '11111111-1111-1111-1111-111111111111';

// Stubs the global fetch used by api.js for the duration of one async run,
// restoring the original afterward even if the run throws.
async function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('getJsonOrNull (via getClientHeaderFooter): 404 resolves null, never throws', async () => {
  await withMockFetch(
    async () => jsonResponse(404, { success: false, error: 'header/footer config not found' }),
    async () => {
      const result = await getClientHeaderFooter(LIBRARY_ID);
      assert.equal(result, null);
    }
  );
});

test('getJsonOrNull (via getClientHeaderFooter): other non-2xx throws an Error carrying .status', async () => {
  await withMockFetch(
    async () => jsonResponse(500, { success: false, error: 'internal server error' }),
    () =>
      assert.rejects(() => getClientHeaderFooter(LIBRARY_ID), (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.status, 500);
        assert.equal(err.message, 'internal server error');
        return true;
      })
  );
});

test('getJsonOrNull: a 2xx envelope failure (success:false) throws rather than resolving', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { success: false, error: 'unexpected shape' }),
    () =>
      assert.rejects(() => getClientHeaderFooter(LIBRARY_ID), (err) => {
        assert.equal(err.status, 200);
        return true;
      })
  );
});

test('getJsonOrNull: a non-JSON body on a non-2xx still throws with .status set', async () => {
  await withMockFetch(
    async () => new Response('not json', { status: 503 }),
    () =>
      assert.rejects(() => getClientHeaderFooter(LIBRARY_ID), (err) => {
        assert.equal(err.status, 503);
        return true;
      })
  );
});

test('getClientHeaderFooter: 200 success resolves with the envelope data', async () => {
  const config = { id: 'cfg-1', scope: { clientLibraryId: LIBRARY_ID }, config: {} };
  await withMockFetch(
    async () => jsonResponse(200, { success: true, data: config }),
    async () => {
      const result = await getClientHeaderFooter(LIBRARY_ID);
      assert.deepEqual(result, config);
    }
  );
});
