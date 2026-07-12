import { describe, it, expect } from 'vitest';
import { InsertParagraphBodySchema, InsertableNodeTypeSchema } from './paragraph-schemas.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('InsertableNodeTypeSchema (#372)', () => {
  it('accepts every insertable node type', () => {
    expect(InsertableNodeTypeSchema.options).toEqual([
      'article',
      'pr1',
      'pr2',
      'pr3',
      'pr4',
      'pr5',
      'pr6',
      'pr7',
      'continuation',
    ]);
  });
  it('rejects part, note, and spec', () => {
    expect(InsertableNodeTypeSchema.safeParse('part').success).toBe(false);
    expect(InsertableNodeTypeSchema.safeParse('note').success).toBe(false);
    expect(InsertableNodeTypeSchema.safeParse('spec').success).toBe(false);
  });
});

describe('InsertParagraphBodySchema (#372)', () => {
  it('accepts a minimal body', () => {
    expect(InsertParagraphBodySchema.parse({ anchorNodeId: VALID_UUID, text: 'hello' })).toEqual({
      anchorNodeId: VALID_UUID,
      text: 'hello',
    });
  });
  it('rejects empty text', () => {
    expect(
      InsertParagraphBodySchema.safeParse({ anchorNodeId: VALID_UUID, text: '' }).success
    ).toBe(false);
  });
  it('rejects a missing anchorNodeId', () => {
    expect(InsertParagraphBodySchema.safeParse({ text: 'hello' }).success).toBe(false);
  });

  // ── actorLabel passthrough (#377) ──────────────────────────────────────────
  it('omitting actorLabel parses byte-identical to the pre-#377 shape', () => {
    expect(InsertParagraphBodySchema.parse({ anchorNodeId: VALID_UUID, text: 'hello' })).toEqual({
      anchorNodeId: VALID_UUID,
      text: 'hello',
    });
  });
  it('accepts an explicit actorLabel', () => {
    expect(
      InsertParagraphBodySchema.parse({
        anchorNodeId: VALID_UUID,
        text: 'hello',
        actorLabel: 'jane.doe',
      })
    ).toEqual({
      anchorNodeId: VALID_UUID,
      text: 'hello',
      actorLabel: 'jane.doe',
    });
  });
  it('rejects a whitespace-only actorLabel', () => {
    expect(
      InsertParagraphBodySchema.safeParse({
        anchorNodeId: VALID_UUID,
        text: 'hello',
        actorLabel: '   ',
      }).success
    ).toBe(false);
  });
});
