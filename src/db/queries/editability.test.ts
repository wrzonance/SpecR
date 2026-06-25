import { describe, it, expect, vi } from 'vitest';

vi.mock('../index.js', () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
  DatabaseError: class DatabaseError extends Error {},
}));

import { ClassificationSchema, OverrideSchema } from './editability.js';

// The DB-boundary editability schemas are CLOSED (.strict()): the payloads are
// our own engine output, so a malformed value is engine drift and must be
// rejected at the boundary, not silently kept. These tests pin that contract.
describe('ClassificationSchema (closed)', () => {
  const valid = {
    editability: 'editable' as const,
    confidence: 0.9,
    evidence: [{ rule: 'defaultEditability' }],
  };

  it('accepts a well-formed machine verdict', () => {
    expect(ClassificationSchema.parse(valid)).toEqual(valid);
  });

  it('rejects confidence > 1', () => {
    expect(() => ClassificationSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
  });

  it('rejects confidence < 0', () => {
    expect(() => ClassificationSchema.parse({ ...valid, confidence: -0.1 })).toThrow();
  });

  it('rejects empty evidence', () => {
    expect(() => ClassificationSchema.parse({ ...valid, evidence: [] })).toThrow();
  });

  it('rejects an editability value outside the closed vocabulary', () => {
    expect(() => ClassificationSchema.parse({ ...valid, editability: 'readonly' })).toThrow();
  });

  it('rejects unknown keys (closed schema catches engine drift)', () => {
    expect(() => ClassificationSchema.parse({ ...valid, severity: 'high' })).toThrow();
  });
});

describe('OverrideSchema (closed)', () => {
  it('accepts a bare editability override', () => {
    expect(OverrideSchema.parse({ editability: 'locked' })).toEqual({ editability: 'locked' });
  });

  it('rejects an unknown override value', () => {
    expect(() => OverrideSchema.parse({ editability: 'frozen' })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => OverrideSchema.parse({ editability: 'locked', who: 'me' })).toThrow();
  });
});
