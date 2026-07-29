import { describe, it, expect } from 'vitest';
import { HistoryAnchorSchema, parseCheckpointAnchor } from './history-schemas.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ADR-052 D3/D9 (issue #380) — HistoryAnchorSchema accepts five wire shapes:
// origin, current, a content_version integer, a package-revision UUID, and
// (this task) a checkpoint:<uuid> anchor. Revision UUIDs and checkpoint
// anchors are otherwise-indistinguishable 36-char strings, so the prefix is
// the only thing separating them at the schema boundary.
describe('HistoryAnchorSchema (#380 checkpoint anchor)', () => {
  it('accepts the origin and current literals', () => {
    expect(HistoryAnchorSchema.safeParse('origin').success).toBe(true);
    expect(HistoryAnchorSchema.safeParse('current').success).toBe(true);
  });

  it('accepts a content_version integer, including a numeric-string query param', () => {
    expect(HistoryAnchorSchema.parse(3)).toBe(3);
    expect(HistoryAnchorSchema.parse('3')).toBe(3);
  });

  it('accepts a bare revision UUID unchanged', () => {
    expect(HistoryAnchorSchema.parse(VALID_UUID)).toBe(VALID_UUID);
  });

  it('accepts a checkpoint:<uuid> anchor unchanged', () => {
    const anchor = `checkpoint:${VALID_UUID}`;
    expect(HistoryAnchorSchema.parse(anchor)).toBe(anchor);
  });

  it('rejects a checkpoint anchor with a malformed uuid suffix', () => {
    expect(HistoryAnchorSchema.safeParse('checkpoint:not-a-uuid').success).toBe(false);
  });

  it('rejects a checkpoint anchor missing the id', () => {
    expect(HistoryAnchorSchema.safeParse('checkpoint:').success).toBe(false);
  });

  it('rejects a checkpoint anchor with a wrong-case prefix (prefix is literal, not case-folded)', () => {
    expect(HistoryAnchorSchema.safeParse(`Checkpoint:${VALID_UUID}`).success).toBe(false);
  });

  it('rejects an arbitrary string matching none of the recognized anchor shapes', () => {
    expect(HistoryAnchorSchema.safeParse('not-an-anchor').success).toBe(false);
  });
});

describe('parseCheckpointAnchor (#380)', () => {
  it('extracts the checkpoint id from a well-formed anchor', () => {
    expect(parseCheckpointAnchor(`checkpoint:${VALID_UUID}`)).toBe(VALID_UUID);
  });

  it('returns null for a bare revision uuid (no prefix)', () => {
    expect(parseCheckpointAnchor(VALID_UUID)).toBeNull();
  });

  it('returns null for the origin/current literals', () => {
    expect(parseCheckpointAnchor('origin')).toBeNull();
    expect(parseCheckpointAnchor('current')).toBeNull();
  });

  it('returns null when the checkpoint prefix is present but the uuid is malformed', () => {
    expect(parseCheckpointAnchor('checkpoint:not-a-uuid')).toBeNull();
  });
});
