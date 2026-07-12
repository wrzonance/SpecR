import { describe, it, expect } from 'vitest';
import {
  StructuredCreateRevisionBodySchema,
  CreateRevisionBodySchema,
} from './revision-schemas.js';

// ADR-066 — package_revisions.parent_revision_id (#389). The query layer
// (createPackageRevision) already accepts and validates a caller-supplied
// parentRevisionId; this pins the schema boundary that lets it reach there
// at all. Rejections here (malformed field, or the legacy body never
// declaring it) must surface as 422 via REST (validateBody) and
// { isError: true } via MCP (IssueArgs.safeParse) — both already convert
// any schema failure generically, so the schema shape is the whole fix.

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('StructuredCreateRevisionBodySchema — parentRevisionId', () => {
  it('accepts a well-formed parentRevisionId alongside the required type', () => {
    const parsed = StructuredCreateRevisionBodySchema.parse({
      type: 'addendum',
      parentRevisionId: VALID_UUID,
    });
    expect(parsed.parentRevisionId).toBe(VALID_UUID);
  });

  it('stays optional — omitting parentRevisionId still validates', () => {
    const parsed = StructuredCreateRevisionBodySchema.parse({ type: 'addendum' });
    expect(parsed).not.toHaveProperty('parentRevisionId');
  });

  it('rejects a malformed parentRevisionId (not a UUID)', () => {
    const result = StructuredCreateRevisionBodySchema.safeParse({
      type: 'addendum',
      parentRevisionId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string parentRevisionId', () => {
    const result = StructuredCreateRevisionBodySchema.safeParse({
      type: 'addendum',
      parentRevisionId: 12345,
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateRevisionBodySchema union — legacy body never accepts parentRevisionId', () => {
  it(
    'rejects { label, parentRevisionId } — legacy .strict() has no such field, and the ' +
      'structured branch requires `type`',
    () => {
      const result = CreateRevisionBodySchema.safeParse({
        label: 'Addendum 1',
        parentRevisionId: VALID_UUID,
      });
      expect(result.success).toBe(false);
    }
  );

  it('still accepts a bare legacy { label } body unchanged', () => {
    const parsed = CreateRevisionBodySchema.parse({ label: 'Addendum 1' });
    expect(parsed).toEqual({ label: 'Addendum 1' });
  });

  it('accepts a structured body with parentRevisionId through the union', () => {
    const parsed = CreateRevisionBodySchema.parse({
      type: 'addendum',
      parentRevisionId: VALID_UUID,
    });
    expect(parsed).toEqual({ type: 'addendum', parentRevisionId: VALID_UUID });
  });
});
