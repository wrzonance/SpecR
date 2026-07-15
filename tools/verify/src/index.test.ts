// Boot-time reachability probe tests (#150, task 6/8): probeApiReachable is
// the only piece of index.ts's boot sequence worth unit-testing in
// isolation — main() itself is a thin side-effecting wire-up (env -> probe
// -> api client -> pipeline -> app -> listen) guarded behind an ESM
// main-module check so importing this file for these tests never actually
// boots a server or hits the network (see index.ts's docstring).

import { describe, expect, it, vi } from 'vitest';
import { probeApiReachable } from './index.js';
import { VerifyApiError } from './errors.js';

describe('probeApiReachable', () => {
  it('resolves when the API responds at all, even with a non-2xx status', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));

    await expect(probeApiReachable('http://localhost:3000', fetchImpl)).resolves.toBeUndefined();
  });

  it('throws VerifyApiError (stage: config) when the network request itself fails', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(probeApiReachable('http://localhost:3000', fetchImpl)).rejects.toThrow(
      VerifyApiError
    );

    try {
      await probeApiReachable('http://localhost:3000', fetchImpl);
      expect.unreachable('probeApiReachable should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyApiError);
      expect((error as VerifyApiError).stage).toBe('config');
      expect((error as VerifyApiError).message).toContain('http://localhost:3000');
    }
  });

  it('requests GET /health at the configured base URL', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 }))
    );

    await probeApiReachable('http://localhost:3000', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    if (call === undefined) throw new Error('fetchImpl was not called');
    expect(call[0]).toBe('http://localhost:3000/health');
  });
});
