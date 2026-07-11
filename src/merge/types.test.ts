import { describe, it, expect } from 'vitest';
import { DiffResultSchema } from '../ast/index.js';
import { toDiffResult, toParagraphDiff } from './types.js';
import type { DiffResult, ParagraphDiff } from './types.js';

// Pins the exactOptionalPropertyTypes boundary between the Zod-inferred parse shape
// (afterUuid is an optional KEY — may be absent entirely) and the internal DiffResult
// shape (afterUuid is a REQUIRED key whose VALUE may be undefined). toParagraphDiff /
// toDiffResult must reconcile the two via explicit field-by-field mapping, never a
// structural/implicit passthrough of the parsed Zod output.

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function parseDiff(added: readonly Record<string, unknown>[]): DiffResult {
  const parsed = DiffResultSchema.parse({
    added,
    modified: [],
    deleted: [],
    conflicts: [],
    warnings: [],
  });
  return toDiffResult(parsed);
}

describe('toParagraphDiff', () => {
  it('maps a Zod-parsed entry with afterUuid present', () => {
    const parsed = DiffResultSchema.parse({
      added: [{ uuid: U1, text: 'New paragraph', index: 2, afterUuid: U2 }],
      modified: [],
      deleted: [],
      conflicts: [],
      warnings: [],
    }).added[0];
    expect(parsed).toBeDefined();

    const result = toParagraphDiff(parsed!);

    expect(result).toEqual<ParagraphDiff>({
      uuid: U1,
      text: 'New paragraph',
      index: 2,
      afterUuid: U2,
    });
  });

  it('reconciles an absent Zod key into an explicit afterUuid: undefined own-property', () => {
    const parsed = DiffResultSchema.parse({
      added: [{ uuid: U1, text: 'New paragraph', index: 2 }],
      modified: [],
      deleted: [],
      conflicts: [],
      warnings: [],
    }).added[0];
    expect(parsed).toBeDefined();
    // Confirms the premise: Zod genuinely omits the key rather than setting it undefined.
    expect(Object.hasOwn(parsed!, 'afterUuid')).toBe(false);

    const result = toParagraphDiff(parsed!);

    // The internal ParagraphDiff shape requires the key to always be present.
    expect(Object.hasOwn(result, 'afterUuid')).toBe(true);
    expect(result.afterUuid).toBeUndefined();
  });
});

describe('toDiffResult', () => {
  it('maps every added entry via toParagraphDiff and passes modified/deleted/conflicts/warnings through unchanged', () => {
    const modified = [{ uuid: U2, base: 'b', theirs: 't', ours: 'o' }];
    const conflicts = [{ uuid: U3, base: 'b2', theirs: 't2', ours: 'o2' }];
    const parsed = DiffResultSchema.parse({
      added: [{ uuid: U1, text: 'New paragraph', index: 0, afterUuid: U2 }],
      modified,
      deleted: [U3],
      conflicts,
      warnings: ['heads up'],
    });

    const result = toDiffResult(parsed);

    expect(result).toEqual<DiffResult>({
      added: [{ uuid: U1, text: 'New paragraph', index: 0, afterUuid: U2 }],
      modified,
      deleted: [U3],
      conflicts,
      warnings: ['heads up'],
    });
  });

  it('produces new added-entry objects rather than passing the parsed ones through by reference', () => {
    const parsed = DiffResultSchema.parse({
      added: [{ uuid: U1, text: 'New paragraph', index: 0 }],
      modified: [],
      deleted: [],
      conflicts: [],
      warnings: [],
    });

    const result = toDiffResult(parsed);

    expect(result.added[0]).not.toBe(parsed.added[0]);
    expect(Object.hasOwn(result.added[0]!, 'afterUuid')).toBe(true);
  });

  it('leaves afterUuid absent-turned-undefined on every added entry when omitted, end to end', () => {
    const result = parseDiff([{ uuid: U1, text: 'x', index: 0 }]);
    expect(result.added).toEqual<readonly ParagraphDiff[]>([
      { uuid: U1, text: 'x', index: 0, afterUuid: undefined },
    ]);
  });
});
