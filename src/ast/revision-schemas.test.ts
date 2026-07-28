import { describe, it, expect } from 'vitest';
import {
  StructuredCreateRevisionBodySchema,
  CreateRevisionBodySchema,
  IssuanceModeSchema,
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

describe('StructuredCreateRevisionBodySchema — baseRevisionId', () => {
  it('accepts an optional UUID comparison base', () => {
    expect(
      StructuredCreateRevisionBodySchema.parse({ type: 'addendum', baseRevisionId: VALID_UUID })
    ).toEqual({ type: 'addendum', baseRevisionId: VALID_UUID });
    expect(StructuredCreateRevisionBodySchema.parse({ type: 'addendum' })).not.toHaveProperty(
      'baseRevisionId'
    );
  });

  it('rejects a malformed comparison base', () => {
    expect(
      StructuredCreateRevisionBodySchema.safeParse({
        type: 'addendum',
        baseRevisionId: 'not-a-uuid',
      }).success
    ).toBe(false);
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

  it('rejects baseRevisionId on the legacy body but accepts it on the structured body', () => {
    expect(
      CreateRevisionBodySchema.safeParse({ label: 'Addendum 1', baseRevisionId: VALID_UUID })
        .success
    ).toBe(false);
    expect(
      CreateRevisionBodySchema.parse({ type: 'addendum', baseRevisionId: VALID_UUID })
    ).toEqual({ type: 'addendum', baseRevisionId: VALID_UUID });
  });
});

// ADR-079 (#406): issuance-readiness gate. `mode`/`overrideReadinessGate` are
// additive, optional fields on the structured revision body only — the
// legacy `{ label }` body is untouched and stays `.strict()`, so a stray
// `mode` leaking onto a legacy-shaped request must fail closed rather than
// be silently dropped (INV-10).
describe('StructuredCreateRevisionBodySchema — mode / overrideReadinessGate (ADR-079)', () => {
  it('accepts an optional mode alongside the required type', () => {
    const parsed = StructuredCreateRevisionBodySchema.parse({
      type: 'addendum',
      mode: 'final',
    });
    expect(parsed.mode).toBe('final');
  });

  it('accepts an optional overrideReadinessGate alongside mode', () => {
    const parsed = StructuredCreateRevisionBodySchema.parse({
      type: 'addendum',
      mode: 'final',
      overrideReadinessGate: true,
    });
    expect(parsed.overrideReadinessGate).toBe(true);
  });

  it('stays optional — omitting mode and overrideReadinessGate still validates', () => {
    const parsed = StructuredCreateRevisionBodySchema.parse({ type: 'addendum' });
    expect(parsed).not.toHaveProperty('mode');
    expect(parsed).not.toHaveProperty('overrideReadinessGate');
  });

  it('rejects a mode value outside the draft/final enum', () => {
    const result = StructuredCreateRevisionBodySchema.safeParse({
      type: 'addendum',
      mode: 'published',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean overrideReadinessGate', () => {
    const result = StructuredCreateRevisionBodySchema.safeParse({
      type: 'addendum',
      mode: 'final',
      overrideReadinessGate: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('IssuanceModeSchema', () => {
  it('accepts exactly draft and final', () => {
    expect(IssuanceModeSchema.parse('draft')).toBe('draft');
    expect(IssuanceModeSchema.parse('final')).toBe('final');
  });

  it('rejects any other value', () => {
    expect(IssuanceModeSchema.safeParse('review').success).toBe(false);
  });
});

describe('CreateRevisionBodySchema union — legacy body never accepts mode (INV-10)', () => {
  it(
    'rejects { label, mode } — legacy .strict() has no such field, and the ' +
      'structured branch requires `type`',
    () => {
      const result = CreateRevisionBodySchema.safeParse({
        label: 'Addendum 1',
        mode: 'final',
      });
      expect(result.success).toBe(false);
    }
  );

  it('accepts a structured body with mode through the union', () => {
    const parsed = CreateRevisionBodySchema.parse({ type: 'addendum', mode: 'final' });
    expect(parsed).toEqual({ type: 'addendum', mode: 'final' });
  });

  it('rejects overrideReadinessGate on the legacy body but accepts it on the structured body', () => {
    expect(
      CreateRevisionBodySchema.safeParse({ label: 'Addendum 1', overrideReadinessGate: true })
        .success
    ).toBe(false);
    expect(
      CreateRevisionBodySchema.parse({
        type: 'addendum',
        mode: 'final',
        overrideReadinessGate: true,
      })
    ).toEqual({ type: 'addendum', mode: 'final', overrideReadinessGate: true });
  });
});
