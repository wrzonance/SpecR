// Boot entrypoint for the visual round-trip verification harness (#150,
// task 6/8): loads env, confirms the real SpecR REST API is actually
// reachable before this harness accepts any traffic (design decision 3 —
// every run this harness drives depends on that API), wires
// api-client/run-store/pipeline/app together, and starts listening. The
// header/footer fixture pipeline (#305 task 6/7) shares the same apiClient
// and runStore as the main pipeline — see header-footer-pipeline.ts's own
// docstring for why it drives a different provisioning path.
//
// probeApiReachable is exported and covered by index.test.ts; main() itself
// is guarded behind the ESM main-module check at the bottom of this file so
// importing this module for that test never actually boots a server or
// hits the network — unlike the main repo's src/index.ts (which nothing
// ever imports), this file needs to be import-safe for its own test.

import { pathToFileURL } from 'node:url';
import { loadVerifyEnv } from './config.js';
import { toRunError, VerifyApiError } from './errors.js';
import { createApiClient } from './api-client/client.js';
import { createRunStore } from './run/run-store.js';
import { createPipeline } from './run/pipeline.js';
import { createHeaderFooterFixturePipeline } from './run/header-footer-pipeline.js';
import { createApp } from './server/app.js';

const REACHABILITY_TIMEOUT_MS = 5000;

/**
 * Confirm the SpecR REST API at `baseUrl` is reachable at all (a bare
 * network round-trip to GET /health) before this harness accepts any
 * traffic. This is a REACHABILITY check, not a health check: a non-2xx
 * response (e.g. 503 because the API's own DB is down) still proves the API
 * process itself is reachable over the network, so only a network-level
 * failure (connection refused, DNS failure, timeout) throws here.
 */
export async function probeApiReachable(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  try {
    await fetchImpl(new URL('/health', baseUrl).toString(), {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new VerifyApiError(`SpecR API at ${baseUrl} is not reachable`, {
      stage: 'config',
      cause: err,
    });
  }
}

async function main(): Promise<void> {
  const env = loadVerifyEnv();
  await probeApiReachable(env.specrApiBaseUrl);

  const apiClient = createApiClient({ baseUrl: env.specrApiBaseUrl });
  const runStore = createRunStore();
  const pipeline = createPipeline({ apiClient, runStore });
  const headerFooterFixturePipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });
  const app = createApp({ pipeline, runStore, headerFooterFixturePipeline });

  // listen() emits an 'error' event (e.g. EADDRINUSE) rather than throwing or
  // rejecting the callback — without this it bypasses main().catch() and
  // crashes with a raw stack trace instead of the "failed to start" path.
  await new Promise<void>((resolve, reject) => {
    // Bind loopback only: this harness has no auth, accepts DOCX uploads, and
    // serves run files — omitting the host binds 0.0.0.0/:: and exposes it to
    // the whole network despite the "localhost" startup log. It is a local dev
    // tool, so keep it reachable only from this machine.
    const server = app.listen(env.port, '127.0.0.1', () => {
      console.log(`verify harness listening on http://localhost:${String(env.port)}`);
      resolve();
    });
    server.on('error', reject);
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    const runError = toRunError('config', err);
    console.error(`verify harness failed to start: ${runError.message}`);
    process.exit(1);
  });
}
