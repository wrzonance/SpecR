import { describe, it, expect, vi } from 'vitest';

vi.mock('../index.js', () => ({
  DatabaseError: class DatabaseError extends Error {
    readonly cause?: unknown;
    constructor(message: string, options?: { cause?: unknown }) {
      super(message);
      this.cause = options?.cause;
    }
  },
}));

import { parseObjectMeta } from './object-meta.js';

const VALID_TABLE_META = {
  kind: 'table',
  floating: false,
  generation: 'drawingml',
  rows: 2,
  columns: 3,
  blob: [{ 'w:tbl': [] }],
};

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
