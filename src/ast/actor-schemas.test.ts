import { describe, it, expect } from 'vitest';
import { ActorLabelSchema, AcceptNoteBodySchema } from './actor-schemas.js';

// A caller-supplied actor identity, threaded through every paragraph/merge
// write so ADR-052's `paragraph_versions.user_id` can resolve a real row
// instead of leaving history attributed to nobody. The base schema itself is
// non-optional by design (each embedding site applies `.exactOptional()` /
// `.optional()` — see the comment above the export) so omitted-ness is
// exercised on the embedding schemas (schemas.test.ts, paragraph-schemas.test.ts,
// merge-schemas.test.ts), not here.
describe('ActorLabelSchema (#377)', () => {
  it('accepts a non-empty label', () => {
    expect(ActorLabelSchema.parse('jane.doe')).toBe('jane.doe');
  });
  it('trims surrounding whitespace', () => {
    expect(ActorLabelSchema.parse('  jane.doe  ')).toBe('jane.doe');
  });
  it('rejects an empty string', () => {
    expect(ActorLabelSchema.safeParse('').success).toBe(false);
  });
  it('rejects a whitespace-only string (trim happens before the length check)', () => {
    expect(ActorLabelSchema.safeParse('   ').success).toBe(false);
  });
  it('rejects a non-string value', () => {
    expect(ActorLabelSchema.safeParse(42).success).toBe(false);
  });
  it('accepts a label at the 200-char users.label bound', () => {
    expect(ActorLabelSchema.safeParse('a'.repeat(200)).success).toBe(true);
  });
  it('rejects a label over 200 chars — an actorLabel becomes a users.label (POST /users bound)', () => {
    // Without this ceiling a long actorLabel would mint a users row that the
    // public user API (1-200) rejects; keep the two in lockstep.
    expect(ActorLabelSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
  // #642, ADR-091 — bounded in Unicode CODE POINTS, not UTF-16 code units.
  // U+1F600 GRINNING FACE is 1 code point / 2 UTF-16 units, so 200 of them is
  // a 400-.length string that a UTF-16-unit-counting regression would reject.
  it('accepts a label at the 200-code-point bound made of astral (non-BMP) characters', () => {
    const atLimit = '\u{1F600}'.repeat(200);
    expect(atLimit).toHaveLength(400); // UTF-16 units — sanity-checks the fixture itself
    expect(ActorLabelSchema.safeParse(atLimit).success).toBe(true);
  });
  it('rejects 201 code points of astral characters', () => {
    expect(ActorLabelSchema.safeParse('\u{1F600}'.repeat(201)).success).toBe(false);
  });
});

// ── AcceptNoteBodySchema — accept-as-note's first-ever request body (#377) ──
describe('AcceptNoteBodySchema (#377)', () => {
  it('accepts an empty body (the route was bodyless pre-#377)', () => {
    expect(AcceptNoteBodySchema.parse({})).toEqual({});
  });
  it('accepts an explicit actorLabel', () => {
    expect(AcceptNoteBodySchema.parse({ actorLabel: 'jane.doe' })).toEqual({
      actorLabel: 'jane.doe',
    });
  });
  it('rejects a whitespace-only actorLabel', () => {
    expect(AcceptNoteBodySchema.safeParse({ actorLabel: '  ' }).success).toBe(false);
  });
});
