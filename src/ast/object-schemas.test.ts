import { describe, it, expect } from 'vitest';
import {
  ObjectKindSchema,
  ObjectGenerationSchema,
  ObjectBlobNodeSchema,
  ObjectMetaSchema,
} from './object-schemas.js';
import { NodeTypeSchema, SpecNodeSchema, SpecTreeSchema } from './spec-tree-schemas.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SPEC_UUID = '00000000-0000-4000-8000-000000000001';
const TEXT_UUID = '00000000-0000-4000-8000-000000000002';

// One fast-xml-parser preserveOrder w:tbl node containing a single cell
// paragraph, in the shape body-order.ts/body-objects.ts (later tasks) will
// actually capture: a single top-level key per node, an optional ':@'
// attribute record, and children as either further nodes or raw '#text'.
const TABLE_BLOB = [
  {
    'w:tbl': [
      {
        'w:tr': [
          {
            'w:tc': [
              {
                'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'Cell one' }] }] }],
                ':@': { '@_w:rsidR': '00AB12CD' },
              },
            ],
          },
        ],
      },
    ],
  },
];

describe('NodeTypeSchema — body object model (#300)', () => {
  it('accepts object and objectText', () => {
    expect(NodeTypeSchema.parse('object')).toBe('object');
    expect(NodeTypeSchema.parse('objectText')).toBe('objectText');
  });
});

describe('ObjectKindSchema / ObjectGenerationSchema', () => {
  it('accepts table and textBox kinds', () => {
    expect(ObjectKindSchema.parse('table')).toBe('table');
    expect(ObjectKindSchema.parse('textBox')).toBe('textBox');
  });
  it('rejects an unrecognized kind', () => {
    expect(ObjectKindSchema.safeParse('image').success).toBe(false);
  });
  it('accepts drawingml and vml generations, rejects anything else', () => {
    expect(ObjectGenerationSchema.parse('drawingml')).toBe('drawingml');
    expect(ObjectGenerationSchema.parse('vml')).toBe('vml');
    expect(ObjectGenerationSchema.safeParse('svg').success).toBe(false);
  });
});

describe('ObjectBlobNodeSchema — JSON-safety only', () => {
  it('accepts a realistic nested preserveOrder node with an attribute record', () => {
    expect(ObjectBlobNodeSchema.safeParse(TABLE_BLOB[0]).success).toBe(true);
  });
  it('accepts a bare text leaf', () => {
    expect(ObjectBlobNodeSchema.safeParse({ '#text': 'hello' }).success).toBe(true);
  });
  it('rejects an array at the top level (must be a single node)', () => {
    expect(ObjectBlobNodeSchema.safeParse(TABLE_BLOB).success).toBe(false);
  });
  it('rejects null and non-object values', () => {
    expect(ObjectBlobNodeSchema.safeParse(null).success).toBe(false);
    expect(ObjectBlobNodeSchema.safeParse('w:tbl').success).toBe(false);
  });
  it('rejects a non-JSON-safe value nested in a child array', () => {
    const withFunction = { 'w:p': [{ 'w:r': () => undefined }] };
    expect(ObjectBlobNodeSchema.safeParse(withFunction).success).toBe(false);
  });
  it('rejects an attribute (":@") value that is not string|number', () => {
    const badAttrs = { 'w:tag': [], ':@': { '@_w:val': true } };
    expect(ObjectBlobNodeSchema.safeParse(badAttrs).success).toBe(false);
  });
});

describe('ObjectMetaSchema', () => {
  const validTable = {
    kind: 'table' as const,
    floating: false,
    generation: 'drawingml' as const,
    rows: 1,
    columns: 1,
    blob: TABLE_BLOB,
  };

  it('accepts a fully-populated table object', () => {
    expect(ObjectMetaSchema.safeParse(validTable).success).toBe(true);
  });
  it('accepts a textBox object without rows/columns', () => {
    const textBox = {
      kind: 'textBox' as const,
      floating: true,
      generation: 'vml' as const,
      blob: [{ '#text': 'boxed text' }],
    };
    expect(ObjectMetaSchema.safeParse(textBox).success).toBe(true);
  });
  it('rejects an empty blob — an object with no captured content is never modeled', () => {
    expect(ObjectMetaSchema.safeParse({ ...validTable, blob: [] }).success).toBe(false);
  });
  it('rejects a non-positive rows/columns', () => {
    expect(ObjectMetaSchema.safeParse({ ...validTable, rows: 0 }).success).toBe(false);
    expect(ObjectMetaSchema.safeParse({ ...validTable, columns: -1 }).success).toBe(false);
  });
});

// ── kind/rows/columns cross-field check (#650 Part B) ──────────────────────
// rows/columns are table-grid dimensions; a textBox has no grid. The check
// names exactly kind, rows, columns — it must never touch vanishCharStyleIds
// or any other field, additive or otherwise.
describe('ObjectMetaSchema — textBox/rows/columns cross-field check (#650)', () => {
  const baseTextBox = {
    kind: 'textBox' as const,
    floating: true,
    generation: 'vml' as const,
    blob: [{ '#text': 'boxed text' }],
  };
  const baseTable = {
    kind: 'table' as const,
    floating: false,
    generation: 'drawingml' as const,
    rows: 1,
    columns: 1,
    blob: TABLE_BLOB,
  };

  it('rejects a textBox with rows set', () => {
    expect(ObjectMetaSchema.safeParse({ ...baseTextBox, rows: 1 }).success).toBe(false);
  });

  it('rejects a textBox with columns set', () => {
    expect(ObjectMetaSchema.safeParse({ ...baseTextBox, columns: 1 }).success).toBe(false);
  });

  it('accepts a textBox with neither rows nor columns', () => {
    expect(ObjectMetaSchema.safeParse(baseTextBox).success).toBe(true);
  });

  it('leaves table with rows/columns unaffected', () => {
    expect(ObjectMetaSchema.safeParse(baseTable).success).toBe(true);
  });

  it('accepts a textBox with vanishCharStyleIds populated and no rows/columns — the check never touches vanishCharStyleIds', () => {
    const result = ObjectMetaSchema.safeParse({
      ...baseTextBox,
      vanishCharStyleIds: ['HiddenChar'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.vanishCharStyleIds).toEqual(['HiddenChar']);
    expect(result.data.rows).toBeUndefined();
    expect(result.data.columns).toBeUndefined();
  });
});

// ── vanishCharStyleIds (#650) ───────────────────────────────────────────────
// Resolved w:rStyle → character-style w:vanish IDs, captured alongside the
// object so capture and rewrite share one source of truth without needing
// styles.xml at rewrite time. Additive JSONB field: absent and [] are
// interchangeable, and a row captured before this change (no key at all)
// must still load/parse identically to today.
describe('ObjectMetaSchema — vanishCharStyleIds (#650)', () => {
  const validTable = {
    kind: 'table' as const,
    floating: false,
    generation: 'drawingml' as const,
    rows: 1,
    columns: 1,
    blob: TABLE_BLOB,
  };

  it('a row/object captured before this change (no vanishCharStyleIds key) loads identically', () => {
    const result = ObjectMetaSchema.safeParse(validTable);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect('vanishCharStyleIds' in result.data).toBe(false);
  });

  it('accepts a table object with a populated vanishCharStyleIds array', () => {
    const withVanish = { ...validTable, vanishCharStyleIds: ['HiddenChar', 'Redacted'] };
    const result = ObjectMetaSchema.safeParse(withVanish);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.vanishCharStyleIds).toEqual(['HiddenChar', 'Redacted']);
  });

  it('accepts an empty vanishCharStyleIds array, interchangeable with absent', () => {
    expect(ObjectMetaSchema.safeParse({ ...validTable, vanishCharStyleIds: [] }).success).toBe(
      true
    );
  });

  it('rejects a non-string entry in vanishCharStyleIds', () => {
    const bad = { ...validTable, vanishCharStyleIds: ['HiddenChar', 42] };
    expect(ObjectMetaSchema.safeParse(bad).success).toBe(false);
  });

  it('a textBox object (no rows/columns) still validates with vanishCharStyleIds populated — the field never couples to kind', () => {
    const textBox = {
      kind: 'textBox' as const,
      floating: true,
      generation: 'vml' as const,
      blob: [{ '#text': 'boxed text' }],
      vanishCharStyleIds: ['HiddenChar'],
    };
    const result = ObjectMetaSchema.safeParse(textBox);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.vanishCharStyleIds).toEqual(['HiddenChar']);
    expect(result.data.rows).toBeUndefined();
    expect(result.data.columns).toBeUndefined();
  });
});

// ── Editability fixation (#300, ADR-072 decision 2) ────────────────────────
// An 'object' node is always locked (a captured OOXML blob is never
// paragraph-editable text) and its 'objectText' children are always editable
// (they're exactly the paragraph text an editor may redline). Neither value
// is derived by the classification engine — the AST schema boundary must
// accept a tree that fixes them this way without rejecting or reshaping it,
// since every later task (parser, generator, DB) builds on this shape holding.
describe('SpecNodeSchema — editability fixation for object/objectText (#300)', () => {
  const objectTextNode = {
    id: TEXT_UUID,
    type: 'objectText',
    text: 'Cell one',
    children: [],
    meta: {
      editability: { value: 'editable', confidence: 1, evidence: [{ rule: 'body-object' }] },
    },
  };

  const objectNode = {
    id: VALID_UUID,
    type: 'object',
    text: 'Table (1x1)',
    children: [objectTextNode],
    meta: {
      editability: { value: 'locked', confidence: 1, evidence: [{ rule: 'body-object' }] },
      object: {
        kind: 'table',
        floating: false,
        generation: 'drawingml',
        rows: 1,
        columns: 1,
        blob: TABLE_BLOB,
      },
    },
  };

  it('accepts an object node fixed to locked, with its objectText child fixed to editable', () => {
    const result = SpecNodeSchema.safeParse(objectNode);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.editability?.value).toBe('locked');
    expect(result.data.children[0]?.type).toBe('objectText');
    expect(result.data.children[0]?.meta.editability?.value).toBe('editable');
  });

  it('round-trips inside a full SpecTree without reshaping meta.object', () => {
    const tree = SpecTreeSchema.parse({
      id: SPEC_UUID,
      section: '09 91 26',
      title: 'Painting',
      parts: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          type: 'part',
          text: 'GENERAL',
          children: [objectNode],
          meta: {},
        },
      ],
    });
    const object = tree.parts[0]?.children[0];
    expect(object?.type).toBe('object');
    expect(object?.meta.object?.kind).toBe('table');
    expect(object?.meta.editability?.value).toBe('locked');
  });

  it('rejects an object node whose meta.object is missing required fields', () => {
    const malformed = {
      ...objectNode,
      meta: { ...objectNode.meta, object: { kind: 'table', floating: false } },
    };
    expect(SpecNodeSchema.safeParse(malformed).success).toBe(false);
  });
});
