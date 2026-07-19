import { describe, it, expect } from 'vitest';
import {
  PatchSpecBodySchema,
  CreateProjectBodySchema,
  AddSectionToProjectBodySchema,
  CreatePackageBodySchema,
  SetPackageSpecsBodySchema,
  UpdateParagraphBodySchema,
} from './schemas.js';
import {
  NodeTypeSchema,
  SpecNodeMetaSchema,
  SpecTreeSchema,
  SignalConflictSchema,
  SourceFactsSchema,
  ConventionRulesSchema,
  EditabilitySchema,
  PatchEditabilityBodySchema,
  PatchRemovalBodySchema,
  ReclassifyBodySchema,
  ParseWarningTypeSchema,
  ParseWarningSchema,
  RetainedTableSchema,
} from './spec-tree-schemas.js';
import { HeaderFooterCompositionSchema } from './header-footer-schemas.js';
import {
  CreateNumberingProfileBodySchema,
  PatchNumberingProfileBodySchema,
} from './style-schemas.js';

const VALID_NODE_TYPES = [
  'spec',
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
  'note',
  'continuation',
] as const;

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_SECTION = '27 21 00';

describe('NodeTypeSchema', () => {
  it('accepts all valid node types', () => {
    for (const t of VALID_NODE_TYPES) {
      expect(NodeTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects unknown node type', () => {
    expect(() => NodeTypeSchema.parse('paragraph')).toThrow();
  });
});

describe('#317 numbering-profile body name — trim before length check', () => {
  const RULES = {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: [],
    styleLadder: [],
  };

  it('rejects a whitespace-only create name (→ 422, not a DB CHECK 500)', () => {
    const result = CreateNumberingProfileBodySchema.safeParse({ name: '   ', rules: RULES });
    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace on a valid create name', () => {
    const result = CreateNumberingProfileBodySchema.safeParse({
      name: '  CSI East  ',
      rules: RULES,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('CSI East');
  });

  it('rejects a whitespace-only patch name', () => {
    const result = PatchNumberingProfileBodySchema.safeParse({ name: '  ' });
    expect(result.success).toBe(false);
  });

  it('rejects a fully-empty patch body (matches PatchTemplateBodySchema)', () => {
    const result = PatchNumberingProfileBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts a patch with only rules present', () => {
    const result = PatchNumberingProfileBodySchema.safeParse({ rules: RULES });
    expect(result.success).toBe(true);
  });
});

describe('SpecTreeSchema — valid inputs', () => {
  it('parses minimal valid SpecTree', () => {
    const input = {
      id: VALID_UUID,
      section: VALID_SECTION,
      title: 'Structured Cabling',
      parts: [],
    };
    const result = SpecTreeSchema.parse(input);
    expect(result.id).toBe(input.id);
    expect(result.section).toBe(VALID_SECTION);
    expect(result.parts).toEqual([]);
  });

  it('parses SpecTree with nested SpecNode children', () => {
    const input = {
      id: VALID_UUID,
      section: VALID_SECTION,
      title: 'Cabling',
      parts: [
        {
          id: '660e8400-e29b-41d4-a716-446655440001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '770e8400-e29b-41d4-a716-446655440002',
              type: 'article',
              text: 'Scope',
              children: [],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    };
    const result = SpecTreeSchema.parse(input);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.children).toHaveLength(1);
    expect(result.parts[0]?.children[0]?.type).toBe('article');
  });
});

describe('SpecTreeSchema — expanded section shapes', () => {
  it('SpecTreeSchema: accepts dotted and agency-suffixed sections', () => {
    const base = { id: '00000000-0000-4000-8000-000000000001', title: 'T', parts: [] };
    expect(SpecTreeSchema.safeParse({ ...base, section: '26 00 13.10' }).success).toBe(true);
    expect(SpecTreeSchema.safeParse({ ...base, section: '01 32 01.00 10' }).success).toBe(true);
  });

  it('SpecTreeSchema: accepts the unknown sentinel (parser output for section-less docs)', () => {
    const base = { id: '00000000-0000-4000-8000-000000000001', title: 'T', parts: [] };
    expect(SpecTreeSchema.safeParse({ ...base, section: 'unknown' }).success).toBe(true);
  });
});

describe('PatchSpecBodySchema — expanded section shapes', () => {
  it('PatchSpecBodySchema: accepts suffixed sections, rejects the unknown sentinel', () => {
    expect(PatchSpecBodySchema.safeParse({ section: '26 00 13.10' }).success).toBe(true);
    expect(PatchSpecBodySchema.safeParse({ section: '01 32 01.00 10' }).success).toBe(true);
    expect(PatchSpecBodySchema.safeParse({ section: 'unknown' }).success).toBe(false);
    expect(PatchSpecBodySchema.safeParse({ section: '26 00 13.1' }).success).toBe(false);
  });
});

describe('SpecTreeSchema — invalid inputs', () => {
  it('rejects section not matching DD NN NN format', () => {
    expect(() =>
      SpecTreeSchema.parse({
        id: VALID_UUID,
        section: '27210',
        title: 'Bad',
        parts: [],
      })
    ).toThrow();
  });

  it('rejects empty title', () => {
    expect(() =>
      SpecTreeSchema.parse({
        id: VALID_UUID,
        section: VALID_SECTION,
        title: '',
        parts: [],
      })
    ).toThrow();
  });
});

// #293 — hidden DOCX tables are retained out-of-band (ADR-038); visible tables
// are surfaced as a 'table-content-skipped' warning, not silently dropped.
describe('SpecTreeSchema — hiddenTables (#293)', () => {
  const base = { id: VALID_UUID, section: VALID_SECTION, title: 'Cabling', parts: [] };

  it('accepts a SpecTree with hiddenTables', () => {
    const result = SpecTreeSchema.parse({
      ...base,
      hiddenTables: [{ rows: [['a', 'b']] }],
    });
    expect(result.hiddenTables).toEqual([{ rows: [['a', 'b']] }]);
  });

  it('omits hiddenTables when absent (no default [] injected)', () => {
    const result = SpecTreeSchema.parse(base);
    expect('hiddenTables' in result).toBe(false);
  });

  // INV-5: hiddenTables is .exactOptional(), not .optional() — it mirrors the
  // exactOptionalPropertyTypes contract (CLAUDE.md), which distinguishes "key
  // absent" from "key present with value undefined". A regression that swaps
  // .exactOptional() for .optional() would still pass every other test in this
  // block (they never pass the key at all) but would silently accept a
  // present-but-undefined key here.
  it('rejects an explicit hiddenTables: undefined (exactOptional, not optional)', () => {
    const result = SpecTreeSchema.safeParse({ ...base, hiddenTables: undefined });
    expect(result.success).toBe(false);
  });

  it('rejects a hiddenTables row cell that is not a string', () => {
    expect(() =>
      SpecTreeSchema.parse({
        ...base,
        hiddenTables: [{ rows: [[1, 'b']] }],
      })
    ).toThrow();
  });
});

describe('ParseWarningTypeSchema — table-content-skipped (#293)', () => {
  it('accepts table-content-skipped', () => {
    expect(ParseWarningTypeSchema.parse('table-content-skipped')).toBe('table-content-skipped');
  });

  it('ParseWarningSchema accepts a table-content-skipped warning', () => {
    const result = ParseWarningSchema.parse({
      type: 'table-content-skipped',
      suggestion: '1 visible table(s) detected but not yet modeled into the spec tree',
    });
    expect(result.type).toBe('table-content-skipped');
  });
});

// #306 — captured-but-unmodeled DOCX header/footer content is preserved
// (raw.unmodeled) and surfaced as one aggregate warning, mirroring the
// table-content-skipped (#293) precedent above.
describe('ParseWarningTypeSchema — header-footer-content-skipped (#306)', () => {
  it('accepts header-footer-content-skipped', () => {
    expect(ParseWarningTypeSchema.parse('header-footer-content-skipped')).toBe(
      'header-footer-content-skipped'
    );
  });

  it('ParseWarningSchema accepts a header-footer-content-skipped warning', () => {
    const result = ParseWarningSchema.parse({
      type: 'header-footer-content-skipped',
      suggestion: '1 header/footer item(s) detected but not yet modeled; see raw.unmodeled',
    });
    expect(result.type).toBe('header-footer-content-skipped');
  });
});

// #306 — SpecTree.headerFooter is parse-output only (no DB/REST/MCP
// persistence in this slice), mirroring the hiddenTables (#293) block above.
describe('SpecTreeSchema — headerFooter (#306)', () => {
  const base = { id: VALID_UUID, section: VALID_SECTION, title: 'Cabling', parts: [] };
  const composition = HeaderFooterCompositionSchema.parse({
    header: { center: { content: [{ kind: 'sectionTitle' }] } },
    footer: { right: { content: [{ kind: 'pageNumber' }] } },
  });

  it('accepts a SpecTree with headerFooter', () => {
    const result = SpecTreeSchema.parse({ ...base, headerFooter: composition });
    expect(result.headerFooter).toEqual(composition);
  });

  it('omits headerFooter when absent (no default injected)', () => {
    const result = SpecTreeSchema.parse(base);
    expect('headerFooter' in result).toBe(false);
  });

  // Mirrors the hiddenTables exactOptional regression guard above: distinguishes
  // "key absent" from "key present with value undefined" (exactOptionalPropertyTypes).
  it('rejects an explicit headerFooter: undefined (exactOptional, not optional)', () => {
    const result = SpecTreeSchema.safeParse({ ...base, headerFooter: undefined });
    expect(result.success).toBe(false);
  });

  it('rejects a headerFooter with a malformed field kind', () => {
    expect(() =>
      SpecTreeSchema.parse({
        ...base,
        headerFooter: { header: { center: { content: [{ kind: 'not-a-real-kind' }] } } },
      })
    ).toThrow();
  });
});

describe('RetainedTableSchema (#293)', () => {
  it('accepts a table with string rows', () => {
    const result = RetainedTableSchema.parse({
      rows: [
        ['Header 1', 'Header 2'],
        ['a', 'b'],
      ],
    });
    expect(result.rows).toEqual([
      ['Header 1', 'Header 2'],
      ['a', 'b'],
    ]);
  });

  it('accepts a table with zero rows', () => {
    expect(RetainedTableSchema.parse({ rows: [] }).rows).toEqual([]);
  });

  it('accepts a row with zero cells', () => {
    expect(RetainedTableSchema.parse({ rows: [[]] }).rows).toEqual([[]]);
  });

  it('rejects a non-string cell', () => {
    expect(() => RetainedTableSchema.parse({ rows: [[1, 2]] })).toThrow();
  });

  it('rejects a missing rows field', () => {
    expect(() => RetainedTableSchema.parse({})).toThrow();
  });
});

describe('SpecNodeMetaSchema', () => {
  it('accepts empty meta', () => {
    expect(SpecNodeMetaSchema.parse({})).toEqual({});
  });

  it('accepts fully populated meta', () => {
    const result = SpecNodeMetaSchema.parse({
      vanish: true,
      source: 'ufgs',
      revitParam: 'Manufacturer',
      baseVersion: 1,
      sourceFacts: {
        comments: [{ author: 'Reviewer', text: 'Check this.', anchor: [0, 4] }],
        colors: [{ color: '0000FF', coverage: 0.5, spans: [[6, 10]] }],
      },
    });
    expect(result.vanish).toBe(true);
    expect(result.source).toBe('ufgs');
    expect(result.sourceFacts?.comments?.[0]?.text).toBe('Check this.');
    expect(result.sourceFacts?.colors?.[0]?.color).toBe('0000FF');
  });

  it('rejects unknown source value', () => {
    expect(() => SpecNodeMetaSchema.parse({ source: 'unknown-vendor' })).toThrow();
  });

  it('rejects invalid source color coverage', () => {
    expect(() =>
      SpecNodeMetaSchema.parse({
        sourceFacts: {
          colors: [{ color: '0000FF', coverage: 1.1, spans: [[6, 10]] }],
        },
      })
    ).toThrow();
  });
});

describe('PatchSpecBodySchema', () => {
  it('accepts empty object (no-op patch)', () => {
    expect(PatchSpecBodySchema.parse({})).toEqual({});
  });

  it('accepts title-only patch', () => {
    const result = PatchSpecBodySchema.parse({ title: 'New Title' });
    expect(result.title).toBe('New Title');
  });

  it('accepts section-only patch', () => {
    const result = PatchSpecBodySchema.parse({ section: '27 21 00' });
    expect(result.section).toBe('27 21 00');
  });

  it('rejects empty string title', () => {
    expect(() => PatchSpecBodySchema.parse({ title: '' })).toThrow();
  });

  it('rejects malformed section', () => {
    expect(() => PatchSpecBodySchema.parse({ section: '27210' })).toThrow();
  });
});

describe('SignalConflictSchema', () => {
  it('accepts signals 1 through 5', () => {
    for (const signal of [1, 2, 3, 4, 5] as const) {
      const result = SignalConflictSchema.parse({
        signal,
        reportedIlvl: 2,
        reportedNodeType: 'pr1',
      });
      expect(result.signal).toBe(signal);
    }
  });

  it('rejects signal 6', () => {
    expect(() =>
      SignalConflictSchema.parse({ signal: 6, reportedIlvl: 2, reportedNodeType: 'pr1' })
    ).toThrow();
  });

  it('rejects unknown reportedNodeType', () => {
    expect(() =>
      SignalConflictSchema.parse({ signal: 2, reportedIlvl: 2, reportedNodeType: 'chapter' })
    ).toThrow();
  });

  it('rejects non-integer reportedIlvl', () => {
    expect(() =>
      SignalConflictSchema.parse({ signal: 2, reportedIlvl: 1.5, reportedNodeType: 'pr1' })
    ).toThrow();
  });
});

describe('SpecNodeMetaSchema — conflicts', () => {
  it('round-trips meta carrying conflicts', () => {
    const meta = {
      source: 'arcat',
      conflicts: [
        { signal: 2, reportedIlvl: 1, reportedNodeType: 'article' },
        { signal: 5, reportedIlvl: 3, reportedNodeType: 'pr2' },
      ],
    };
    const result = SpecNodeMetaSchema.parse(meta);
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts?.[0]?.signal).toBe(2);
    expect(result.conflicts?.[1]?.reportedNodeType).toBe('pr2');
  });

  it('meta without conflicts key parses with conflicts undefined', () => {
    const result = SpecNodeMetaSchema.parse({ vanish: true });
    expect(result.conflicts).toBeUndefined();
  });
});

describe('SourceFactsSchema', () => {
  it('accepts known source fact keys and preserves unknown JSON keys', () => {
    const facts = {
      comments: [{ author: 'Specifier', text: 'Verify product.', anchor: [4, 19], closed: false }],
      colors: [{ color: '0000FF', coverage: 0.82, spans: [[12, 96]] }],
      choiceTokens: [{ kind: 'bracket', options: ['Provide mockup.'], span: [20, 37] }],
      emphasis: [
        {
          property: 'bold',
          value: true,
          expected: false,
          text: 'manual emphasis',
          span: [38, 53],
        },
      ],
      banner: 'MASTER NOTE',
      vanish: true,
      reviewer: { severity: 'info', count: 2, tags: ['coordination'] },
    };

    expect(SourceFactsSchema.parse(facts)).toEqual(facts);
  });

  it('defaults comment.closed to false for facts persisted before #262', () => {
    const parsed = SourceFactsSchema.parse({
      comments: [{ author: 'Specifier', text: 'Verify product.', anchor: [4, 19] }],
    });
    expect(parsed.comments?.[0]?.closed).toBe(false);
  });

  it('legacy suffix-closed: backfills closed=true for a pre-#262 fact whose text ends in "Closed"', () => {
    // Comments persisted between #183 and #262 carry no `closed` flag. The only
    // closure signal recoverable from stored text is the trailing "Closed", so
    // the schema must read such a legacy fact as closed — not default it to open.
    const parsed = SourceFactsSchema.parse({
      comments: [{ author: 'Owner', text: 'Use approved product. Closed', anchor: [4, 28] }],
    });
    expect(parsed.comments?.[0]?.closed).toBe(true);
  });

  it('preserves comment.closed = true', () => {
    const parsed = SourceFactsSchema.parse({
      comments: [{ author: 'Specifier', text: 'Done Closed', anchor: [4, 19], closed: true }],
    });
    expect(parsed.comments?.[0]?.closed).toBe(true);
  });

  it('rejects non-JSON unknown fact values', () => {
    expect(SourceFactsSchema.safeParse({ reviewer: 1n }).success).toBe(false);
  });
});

describe('CreateProjectBodySchema (issue #94)', () => {
  const valid = {
    name: 'P',
    sourceLibraryIds: ['8f14e45f-ceea-4e07-8c65-3f0f1c6e1a01'],
  };
  it('accepts name + sourceLibraryIds', () => {
    expect(CreateProjectBodySchema.safeParse(valid).success).toBe(true);
  });
  it('rejects missing sourceLibraryIds', () => {
    expect(CreateProjectBodySchema.safeParse({ name: 'P' }).success).toBe(false);
  });
  it('rejects empty sourceLibraryIds', () => {
    expect(CreateProjectBodySchema.safeParse({ name: 'P', sourceLibraryIds: [] }).success).toBe(
      false
    );
  });
  it('rejects duplicate sourceLibraryIds', () => {
    expect(
      CreateProjectBodySchema.safeParse({
        name: 'P',
        sourceLibraryIds: [valid.sourceLibraryIds[0], valid.sourceLibraryIds[0]],
      }).success
    ).toBe(false);
  });
  it('rejects non-uuid entries', () => {
    expect(
      CreateProjectBodySchema.safeParse({ name: 'P', sourceLibraryIds: ['nope'] }).success
    ).toBe(false);
  });
});

describe('AddSectionToProjectBodySchema (issue #94)', () => {
  it('accepts a canonical section number', () => {
    expect(AddSectionToProjectBodySchema.safeParse({ section: '03 30 00' }).success).toBe(true);
  });
  it('rejects a malformed section number', () => {
    expect(AddSectionToProjectBodySchema.safeParse({ section: '3 30 00' }).success).toBe(false);
  });
  it('rejects a specId body (old contract)', () => {
    expect(
      AddSectionToProjectBodySchema.safeParse({
        specId: '8f14e45f-ceea-4e07-8c65-3f0f1c6e1a01',
      }).success
    ).toBe(false);
  });
});

describe('CreatePackageBodySchema (issue #95)', () => {
  it('accepts a non-empty name', () => {
    expect(CreatePackageBodySchema.safeParse({ name: 'Early Steel Release' }).success).toBe(true);
  });
  it('rejects empty and missing name', () => {
    expect(CreatePackageBodySchema.safeParse({ name: '' }).success).toBe(false);
    expect(CreatePackageBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('SetPackageSpecsBodySchema (issue #95)', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  it('accepts an ordered uuid array', () => {
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: [a, b] }).success).toBe(true);
  });
  it('accepts an empty array (clears the package)', () => {
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: [] }).success).toBe(true);
  });
  it('rejects duplicates, non-uuids, and missing specIds', () => {
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: [a, a] }).success).toBe(false);
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: ['nope'] }).success).toBe(false);
    expect(SetPackageSpecsBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('ConventionRulesSchema (ADR-022 D3/D5)', () => {
  const FULL_RULES = {
    colorMeanings: [{ color: '0000FF', meaning: 'editable' }],
    choiceTokens: [{ kind: 'angle' }, { kind: 'bracket' }],
    noteBanners: ['^NOTES? TO (?:THE )?SPEC(?:IFIER)?S?'],
    comments: { treatAs: 'note' },
    defaultEditability: 'locked',
  };

  it('accepts the full design-doc ruleset and round-trips it identically', () => {
    const parsed = ConventionRulesSchema.parse(FULL_RULES);
    expect(parsed).toEqual(FULL_RULES);
  });

  it('accepts an empty ruleset — every field is optional', () => {
    expect(ConventionRulesSchema.parse({})).toEqual({});
  });

  it('preserves unknown keys via catchall (capture-never-reject)', () => {
    const withUnknown = { defaultEditability: 'locked', futureKnob: { weight: 3 } };
    expect(ConventionRulesSchema.parse(withUnknown)).toEqual(withUnknown);
  });

  it('preserves unknown keys nested inside a known sub-object', () => {
    const input = { colorMeanings: [{ color: 'FF0000', meaning: 'note', note: 'vendor red' }] };
    expect(ConventionRulesSchema.parse(input)).toEqual(input);
  });

  it('rejects an editability value outside the closed vocabulary', () => {
    expect(ConventionRulesSchema.safeParse({ defaultEditability: 'frozen' }).success).toBe(false);
    expect(
      ConventionRulesSchema.safeParse({ colorMeanings: [{ color: '0000FF', meaning: 'maybe' }] })
        .success
    ).toBe(false);
  });

  it('rejects an unknown choice-token kind', () => {
    expect(ConventionRulesSchema.safeParse({ choiceTokens: [{ kind: 'curly' }] }).success).toBe(
      false
    );
  });

  it('EditabilitySchema is the closed four-value vocabulary', () => {
    expect(EditabilitySchema.options).toEqual(['locked', 'editable', 'choice', 'note']);
  });
});

describe('PatchEditabilityBodySchema (O-9 / #136)', () => {
  it('accepts a closed editability value', () => {
    expect(PatchEditabilityBodySchema.parse({ editability: 'note' })).toEqual({
      editability: 'note',
    });
  });
  it('accepts explicit null to clear the override', () => {
    expect(PatchEditabilityBodySchema.parse({ editability: null })).toEqual({ editability: null });
  });
  it('rejects an out-of-vocabulary value', () => {
    expect(PatchEditabilityBodySchema.safeParse({ editability: 'frozen' }).success).toBe(false);
  });
  it('rejects a missing editability key', () => {
    expect(PatchEditabilityBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('ReclassifyBodySchema (O-9 / #136)', () => {
  it('accepts an empty body (resolve the library profile)', () => {
    expect(ReclassifyBodySchema.parse({})).toEqual({});
  });
  it('accepts candidate rules and a preview flag', () => {
    const body = { rules: { defaultEditability: 'editable' }, preview: true };
    expect(ReclassifyBodySchema.parse(body)).toEqual(body);
  });
  it('rejects malformed rules (bad enum)', () => {
    expect(
      ReclassifyBodySchema.safeParse({ rules: { defaultEditability: 'frozen' } }).success
    ).toBe(false);
  });
  it('rejects a null body (the handler coerces only undefined → {}, not null)', () => {
    // The reclassify handler maps `undefined` (truly bodyless) to {} but passes
    // an explicit `null` straight to this schema, which must reject it → 400.
    expect(ReclassifyBodySchema.safeParse(null).success).toBe(false);
  });
});

describe('PatchRemovalBodySchema (#251)', () => {
  it('accepts { removed: true }', () => {
    expect(PatchRemovalBodySchema.parse({ removed: true })).toEqual({ removed: true });
  });
  it('accepts { removed: false } (un-vanish)', () => {
    expect(PatchRemovalBodySchema.parse({ removed: false })).toEqual({ removed: false });
  });
  it('rejects a missing removed flag', () => {
    expect(PatchRemovalBodySchema.safeParse({}).success).toBe(false);
  });
  it('rejects a non-boolean removed flag', () => {
    expect(PatchRemovalBodySchema.safeParse({ removed: 'yes' }).success).toBe(false);
  });
  it('omitting actorLabel parses byte-identical to the pre-#377 shape (#377)', () => {
    expect(PatchRemovalBodySchema.parse({ removed: true })).toEqual({ removed: true });
  });
  it('accepts an explicit actorLabel alongside removed (#377)', () => {
    expect(PatchRemovalBodySchema.parse({ removed: true, actorLabel: 'jane.doe' })).toEqual({
      removed: true,
      actorLabel: 'jane.doe',
    });
  });
  it('rejects a whitespace-only actorLabel (#377)', () => {
    expect(PatchRemovalBodySchema.safeParse({ removed: true, actorLabel: '   ' }).success).toBe(
      false
    );
  });
});

// ActorLabelSchema and AcceptNoteBodySchema now live in actor-schemas.ts
// (split out to keep this file under the 400-line cap) — their invariants
// are pinned in actor-schemas.test.ts, not here.

// ── UpdateParagraphBodySchema — actorLabel passthrough (#377) ───────────────
describe('UpdateParagraphBodySchema — actorLabel (#377)', () => {
  it('omitting actorLabel parses byte-identical to the pre-#377 shape', () => {
    expect(UpdateParagraphBodySchema.parse({ text: 'hello' })).toEqual({ text: 'hello' });
  });
  it('accepts an explicit actorLabel', () => {
    expect(UpdateParagraphBodySchema.parse({ text: 'hello', actorLabel: 'jane.doe' })).toEqual({
      text: 'hello',
      actorLabel: 'jane.doe',
    });
  });
  it('rejects a whitespace-only actorLabel', () => {
    expect(UpdateParagraphBodySchema.safeParse({ text: 'hello', actorLabel: '  ' }).success).toBe(
      false
    );
  });
});
