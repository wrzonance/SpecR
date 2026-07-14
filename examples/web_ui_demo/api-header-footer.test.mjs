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
import {
  getClientHeaderFooter,
  fetchSpecDocx,
  fetchManualDocx,
  fetchRevisionDocx,
} from './js/api.js';

const LIBRARY_ID = '11111111-1111-1111-1111-111111111111';
const SPEC_ID = '22222222-2222-2222-2222-222222222222';
const PROJECT_ID = '33333333-3333-3333-3333-333333333333';
const REVISION_ID = '44444444-4444-4444-4444-444444444444';

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
      assert.rejects(
        () => getClientHeaderFooter(LIBRARY_ID),
        (err) => {
          assert.ok(err instanceof Error);
          assert.equal(err.status, 500);
          assert.equal(err.message, 'internal server error');
          return true;
        }
      )
  );
});

test('getJsonOrNull: a 2xx envelope failure (success:false) throws rather than resolving', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { success: false, error: 'unexpected shape' }),
    () =>
      assert.rejects(
        () => getClientHeaderFooter(LIBRARY_ID),
        (err) => {
          assert.equal(err.status, 200);
          return true;
        }
      )
  );
});

test('getJsonOrNull: a non-JSON body on a non-2xx still throws with .status set', async () => {
  await withMockFetch(
    async () => new Response('not json', { status: 503 }),
    () =>
      assert.rejects(
        () => getClientHeaderFooter(LIBRARY_ID),
        (err) => {
          assert.equal(err.status, 503);
          return true;
        }
      )
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

// ── Shared fetchDocx boundary (#481) ────────────────────────────────────────
// fetchSpecDocx, fetchManualDocx, and fetchRevisionDocx are three thin
// wrappers over one shared fetchDocx blob-fetch-with-status-error
// implementation (spike DRY finding — code.md's 3+ call-site bar). These
// tests pin that the three wrappers behave IDENTICALLY on success and on
// every failure mode, differing only in which path/method/body they send —
// so the shared implementation can be refactored freely without any one
// wrapper silently diverging in error handling.

function blobResponse(body = 'docx-bytes') {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  });
}

const DOCX_WRAPPERS = [
  { name: 'fetchSpecDocx', call: () => fetchSpecDocx(SPEC_ID), path: `/specs/${SPEC_ID}/generate` },
  {
    name: 'fetchManualDocx',
    call: () => fetchManualDocx(PROJECT_ID),
    path: `/projects/${PROJECT_ID}/generate`,
  },
  {
    name: 'fetchRevisionDocx',
    call: () => fetchRevisionDocx(REVISION_ID),
    path: `/revisions/${REVISION_ID}/generate`,
  },
];

for (const { name, call, path } of DOCX_WRAPPERS) {
  test(`${name}: 2xx resolves with the response Blob, POSTing to ${path}`, async () => {
    let seenPath;
    let seenMethod;
    let result;
    await withMockFetch(
      async (p, init) => {
        seenPath = p;
        seenMethod = init && init.method;
        return blobResponse();
      },
      async () => {
        result = await call();
      }
    );
    assert.ok(result instanceof Blob, 'resolves with a Blob');
    assert.equal(seenPath, path);
    assert.equal(seenMethod, 'POST');
  });

  test(`${name}: a non-2xx JSON error body throws an Error carrying .status and the server's message`, async () => {
    await withMockFetch(
      async () => jsonResponse(500, { success: false, error: 'generation failed' }),
      () =>
        assert.rejects(
          () => call(),
          (err) => {
            assert.ok(err instanceof Error);
            assert.equal(err.status, 500);
            assert.equal(err.message, 'generation failed');
            return true;
          }
        )
    );
  });

  test(`${name}: a non-JSON error body still throws with .status set and a generic fallback message`, async () => {
    await withMockFetch(
      async () => new Response('not json', { status: 503 }),
      () =>
        assert.rejects(
          () => call(),
          (err) => {
            assert.equal(err.status, 503);
            assert.match(err.message, /503/);
            return true;
          }
        )
    );
  });
}

test('fetchRevisionDocx: an addendum body (baseRevisionId) is sent as a JSON request body', async () => {
  let seenInit;
  await withMockFetch(
    async (_path, init) => {
      seenInit = init;
      return blobResponse();
    },
    () => fetchRevisionDocx(REVISION_ID, { baseRevisionId: SPEC_ID })
  );
  assert.equal(seenInit.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seenInit.body), { baseRevisionId: SPEC_ID });
});

test('fetchRevisionDocx: no body arg sends no JSON request body (issued-revision request)', async () => {
  let seenInit;
  await withMockFetch(
    async (_path, init) => {
      seenInit = init;
      return blobResponse();
    },
    () => fetchRevisionDocx(REVISION_ID)
  );
  assert.equal(seenInit.body, undefined);
  assert.equal(seenInit.headers, undefined);
});
