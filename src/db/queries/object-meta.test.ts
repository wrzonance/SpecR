import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { PoolClient } from 'pg';
import type { ObjectMeta } from '../../ast/index.js';

// vi.mock factories are hoisted above all other module code (including class
// declarations), so a class referenced by the factory but declared at plain
// module scope hits a TDZ ReferenceError — vi.hoisted is the sanctioned escape
// hatch, run inside the same hoist pass as the mock itself.
const { MockDatabaseError } = vi.hoisted(() => {
  class MockDatabaseError extends Error {
    readonly cause?: unknown;
    constructor(message: string, options?: { cause?: unknown }) {
      super(message);
      this.cause = options?.cause;
    }
  }
  return { MockDatabaseError };
});

vi.mock('../index.js', () => ({ DatabaseError: MockDatabaseError }));

import { parseObjectMeta, updateObjectData } from './object-meta.js';

const VALID_TABLE_META = {
  kind: 'table',
  floating: false,
  generation: 'drawingml',
  rows: 2,
  columns: 3,
  blob: [{ 'w:tbl': [] }],
};

/** A minimal PoolClient double: only `query` is ever called by updateObjectData. */
function fakeClient(query: Mock): PoolClient {
  return { query } as unknown as PoolClient;
}

// #300, ADR-072: parseObjectMeta is the single boundary that turns the raw
// `paragraphs.object_data` JSONB column into `meta.object`. It mirrors
// parseNodeType's context-named, throw-loud-on-drift pattern (node-type.ts).
describe('parseObjectMeta', () => {
  it('returns undefined for a non-object node type, even with a populated column', () => {
    expect(parseObjectMeta('pr1', VALID_TABLE_META, 'test')).toBeUndefined();
  });

  it('returns undefined for a non-object node type with a NULL column', () => {
    expect(parseObjectMeta('article', null, 'test')).toBeUndefined();
  });

  it('validates and returns ObjectMeta for a well-formed object row', () => {
    expect(parseObjectMeta('object', VALID_TABLE_META, 'test')).toEqual(VALID_TABLE_META);
  });

  it('throws DatabaseError naming the context for an object row with NULL object_data', () => {
    expect(() => parseObjectMeta('object', null, 'buildNodeTree')).toThrow(
      /buildNodeTree: invalid object_data/
    );
  });

  it('throws DatabaseError for an object row with a malformed object_data payload', () => {
    expect(() => parseObjectMeta('object', { kind: 'bogus' }, 'test')).toThrow(
      /invalid object_data/
    );
  });

  it('chains the ZodError as cause so the boundary failure is diagnosable', () => {
    try {
      parseObjectMeta('object', { kind: 'bogus' }, 'test');
      expect.unreachable('parseObjectMeta should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as { cause?: unknown }).cause).toBeDefined();
    }
  });
});

// #519 — the write side of the boundary parseObjectMeta reads back: persists a
// caller-built ObjectMeta onto its owning `object` row, re-validating against
// ObjectMetaSchema before the write (never trust an in-memory value blindly
// back into JSONB) and treating a zero-rowCount write as a loud failure, not a
// silent no-op — the object row it names must actually exist and be `object`-typed.
describe('updateObjectData', () => {
  it('re-validates meta and writes object_data as JSONB, never touching the DB on an invalid payload', async () => {
    const query = vi.fn();
    const invalidMeta = { kind: 'bogus' } as unknown as ObjectMeta;

    await expect(
      updateObjectData(fakeClient(query), 'spec-1', 'obj-1', invalidMeta)
    ).rejects.toThrow(/invalid object_data/);
    expect(query).not.toHaveBeenCalled();
  });

  it('updates the named object row scoped to its spec, resolving on a successful single-row write', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    await updateObjectData(fakeClient(query), 'spec-1', 'obj-1', VALID_TABLE_META as ObjectMeta);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toMatch(/UPDATE paragraphs/);
    expect(sql).toMatch(/node_type = 'object'/);
    expect(params).toEqual([JSON.stringify(VALID_TABLE_META), 'obj-1', 'spec-1']);
  });

  it('throws DatabaseError when no row matched (wrong id, wrong spec, or not an object row)', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });

    await expect(
      updateObjectData(fakeClient(query), 'spec-1', 'obj-missing', VALID_TABLE_META as ObjectMeta)
    ).rejects.toThrow(/no object row/);
  });

  it('wraps a raw pg query failure as DatabaseError with the original error chained as cause', async () => {
    const pgErr = new Error('connection terminated');
    const query = vi.fn().mockRejectedValue(pgErr);

    const err = await updateObjectData(
      fakeClient(query),
      'spec-1',
      'obj-1',
      VALID_TABLE_META as ObjectMeta
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MockDatabaseError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });
});
