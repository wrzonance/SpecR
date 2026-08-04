import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseError } from '../db/errors.js';

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

  // A failed acquire throws out of globalSetup before the teardown closure
  // exists, so Vitest never gets a handle it could close the connection with.
  // Unless setup closes it itself, `connect()` having already succeeded leaves
  // a live socket keeping the event loop alive on the way out.
  it('closes the dedicated client when the non-blocking probe rejects, and rethrows it as a typed DatabaseError', async () => {
    const boom = new Error('terminating connection due to administrator command');
    query.mockRejectedValueOnce(boom);

    const setup = (await import('./integration-lock.global-setup.js')).default;

    // setup() is invoked ONCE and the rejection captured: each mock above is a
    // *Once* mock, so a second call would not reproduce the same failure.
    const err: unknown = await setup().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as Error).cause, 'the original pg error must survive as cause').toBe(boom);
    expect(end).toHaveBeenCalledTimes(1);
  });

  // CodeRabbit #644: connect() itself can reject (bad DATABASE_URL, server
  // down, TLS refusal) BEFORE any lock query runs. That path never reached
  // acquireOrClose, so nothing closed the client and nothing typed the error.
  it('wraps a client.connect() rejection as DatabaseError without attempting a lock query', async () => {
    const boom = new Error('ECONNREFUSED 127.0.0.1:5432');
    connect.mockRejectedValueOnce(boom);

    const setup = (await import('./integration-lock.global-setup.js')).default;

    const err: unknown = await setup().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as Error).cause).toBe(boom);
    expect(
      query,
      'no lock query can be attempted on a connection that never opened'
    ).not.toHaveBeenCalled();
  });

  // The blocking acquire is the likelier one to fail in practice: a
  // `statement_timeout` shorter than the holding run cancels it outright.
  it('closes the dedicated client when the blocking pg_advisory_lock rejects, and rethrows it as a typed DatabaseError', async () => {
    const boom = new Error('canceling statement due to statement timeout');
    query
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] })
      .mockRejectedValueOnce(boom);

    const setup = (await import('./integration-lock.global-setup.js')).default;

    // setup() is invoked ONCE and the rejection captured: each mock above is a
    // *Once* mock, so a second call would not reproduce the same failure.
    const err: unknown = await setup().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as Error).cause, 'the original pg error must survive as cause').toBe(boom);
    expect(end).toHaveBeenCalledTimes(1);
  });

  // The cleanup is best-effort: if closing the socket ALSO fails there is
  // nothing further to do, and surfacing that secondary error would hide why
  // the run actually failed to start.
  it('still surfaces the original acquire error as DatabaseError.cause when the cleanup client.end() also fails', async () => {
    const boom = new Error('canceling statement due to statement timeout');
    query.mockRejectedValueOnce(boom);
    end.mockRejectedValueOnce(new Error('socket already closed'));

    const setup = (await import('./integration-lock.global-setup.js')).default;

    // setup() is invoked ONCE and the rejection captured: each mock above is a
    // *Once* mock, so a second call would not reproduce the same failure.
    const err: unknown = await setup().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as Error).cause, 'the original pg error must survive as cause').toBe(boom);
    expect(end).toHaveBeenCalledTimes(1);
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
