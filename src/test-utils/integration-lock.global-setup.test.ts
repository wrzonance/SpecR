import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-level coverage for the advisory-lock mechanism (ADR-090, #638): the
// original PR shipped with zero tests anywhere in the diff for the module
// that IS the "at most one invocation holds the lock" invariant. `pg`'s
// `Client` is mocked so this runs in the no-DB `unit` project — the
// `integration` project already exercises the real lock end-to-end simply by
// existing (its `globalSetup` entry), so this file targets the branches that
// are otherwise unreachable without genuinely contending processes: the
// non-blocking-vs-blocking acquire paths and teardown's error handling.

const connect = vi.fn();
const query = vi.fn();
const end = vi.fn();

vi.mock('pg', () => ({
  // A regular `function`, not an arrow function: `new Client(...)` invokes
  // this via a constructor call, and arrow functions cannot be constructed
  // (`Reflect.construct` throws "is not a constructor"). A plain function
  // that returns an object short-circuits `new`'s usual `this` binding and
  // returns that object instead, which is exactly the mock instance below.
  Client: vi.fn(function mockClientConstructor() {
    return { connect, query, end };
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  end.mockResolvedValue(undefined);
});

describe('integration-lock.global-setup: acquire', () => {
  it('acquires via pg_try_advisory_lock and returns without falling back to the blocking call when uncontended', async () => {
    query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] });

    const setup = (await import('./integration-lock.global-setup.js')).default;
    await setup();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT pg_try_advisory_lock\(\$1\)$/);
  });

  it('falls back to the blocking pg_advisory_lock when another invocation already holds it', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] })
      .mockResolvedValueOnce({ rows: [] });

    const setup = (await import('./integration-lock.global-setup.js')).default;
    await setup();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toMatch(/^SELECT pg_advisory_lock\(\$1\)$/);
  });
});

describe('integration-lock.global-setup: teardown', () => {
  it('releases the lock and ends the dedicated client', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });

    const setup = (await import('./integration-lock.global-setup.js')).default;
    const teardown = await setup();
    await teardown();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toMatch(/^SELECT pg_advisory_unlock\(\$1\)$/);
    expect(end).toHaveBeenCalledTimes(1);
  });

  // Pins the fix for the review finding: teardown previously let a rejected
  // pg_advisory_unlock query propagate uncaught, contradicting this module's
  // own documented invariant (ADR-090: "teardown must never throw past
  // itself") and still leaked the connection because client.end() never ran.
  it('swallows a failing pg_advisory_unlock query rather than throwing (ADR-090)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockRejectedValueOnce(new Error('connection reset by peer'));

    const setup = (await import('./integration-lock.global-setup.js')).default;
    const teardown = await setup();

    await expect(teardown()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });

  // The same invariant applies to closing the connection itself: a run whose
  // unlock succeeded but whose client.end() rejects (e.g. the server already
  // dropped the socket) must not crash the runner on the way out either.
  it('swallows a failing client.end() rather than throwing (ADR-090)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    end.mockRejectedValueOnce(new Error('socket already closed'));

    const setup = (await import('./integration-lock.global-setup.js')).default;
    const teardown = await setup();

    await expect(teardown()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
