import { describe, it, expect } from 'vitest';
import {
  NodeTypeSchema,
  CsiNodeMetaSchema,
  CsiTreeSchema,
  PatchSpecBodySchema,
} from './schemas.js';

const VALID_NODE_TYPES = [
  'spec',
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
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

describe('CsiTreeSchema — valid inputs', () => {
  it('parses minimal valid CsiTree', () => {
    const input = {
      id: VALID_UUID,
      section: VALID_SECTION,
      title: 'Structured Cabling',
      parts: [],
    };
    const result = CsiTreeSchema.parse(input);
    expect(result.id).toBe(input.id);
    expect(result.section).toBe(VALID_SECTION);
    expect(result.parts).toEqual([]);
  });

  it('parses CsiTree with nested CsiNode children', () => {
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
    const result = CsiTreeSchema.parse(input);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.children).toHaveLength(1);
    expect(result.parts[0]?.children[0]?.type).toBe('article');
  });
});

describe('CsiTreeSchema — invalid inputs', () => {
  it('rejects section not matching DD NN NN format', () => {
    expect(() =>
      CsiTreeSchema.parse({
        id: VALID_UUID,
        section: '27210',
        title: 'Bad',
        parts: [],
      })
    ).toThrow();
  });

  it('rejects empty title', () => {
    expect(() =>
      CsiTreeSchema.parse({
        id: VALID_UUID,
        section: VALID_SECTION,
        title: '',
        parts: [],
      })
    ).toThrow();
  });
});

describe('CsiNodeMetaSchema', () => {
  it('accepts empty meta', () => {
    expect(CsiNodeMetaSchema.parse({})).toEqual({});
  });

  it('accepts fully populated meta', () => {
    const result = CsiNodeMetaSchema.parse({
      vanish: true,
      source: 'ufgs',
      revitParam: 'Manufacturer',
      baseVersion: 1,
    });
    expect(result.vanish).toBe(true);
    expect(result.source).toBe('ufgs');
  });

  it('rejects unknown source value', () => {
    expect(() => CsiNodeMetaSchema.parse({ source: 'unknown-vendor' })).toThrow();
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
