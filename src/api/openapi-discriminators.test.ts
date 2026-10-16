import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getValidator, loadSpec } from '../test-utils/contract/validate-response.js';

const ID = '00000000-0000-4000-8000-000000000001';
const UnionSchema = z.object({
  oneOf: z.array(z.object({ $ref: z.string() })),
  discriminator: z.object({
    propertyName: z.string(),
    mapping: z.record(z.string(), z.string()),
  }),
});

interface VariantCase {
  readonly schema: string;
  readonly payload: Record<string, unknown>;
  readonly required: string;
}

const cases: VariantCase[] = [
  { schema: 'OpenCommentsScope', payload: { kind: 'spec', specId: ID }, required: 'specId' },
  {
    schema: 'OpenCommentsScope',
    payload: { kind: 'project', projectId: ID },
    required: 'projectId',
  },
  { schema: 'TextBoxReportScope', payload: { kind: 'spec', specId: ID }, required: 'specId' },
  {
    schema: 'TextBoxReportScope',
    payload: { kind: 'project', projectId: ID },
    required: 'projectId',
  },
  { schema: 'ReadinessScope', payload: { kind: 'spec', specId: ID }, required: 'specId' },
  { schema: 'ReadinessScope', payload: { kind: 'package', packageId: ID }, required: 'packageId' },
  {
    schema: 'HeaderFooterScope',
    payload: { kind: 'client', clientLibraryId: ID },
    required: 'clientLibraryId',
  },
  {
    schema: 'HeaderFooterScope',
    payload: { kind: 'project', projectId: ID },
    required: 'projectId',
  },
  {
    schema: 'HeaderFooterScope',
    payload: { kind: 'package', packageId: ID },
    required: 'packageId',
  },
  {
    schema: 'HeaderFooterScope',
    payload: { kind: 'revision', revisionId: ID },
    required: 'revisionId',
  },
  {
    schema: 'ReadinessFinding',
    payload: {
      type: 'unresolved_choice_token',
      nodeId: ID,
      text: '<A/B>',
      kind: 'angle',
      options: ['A', 'B'],
    },
    required: 'options',
  },
  {
    schema: 'ReadinessFinding',
    payload: { type: 'specifier_note_present', nodeId: ID, text: 'Editorial note' },
    required: 'nodeId',
  },
  {
    schema: 'ReadinessFinding',
    payload: { type: 'open_comment', nodeId: ID, text: 'Review this', author: 'Editor' },
    required: 'author',
  },
  {
    schema: 'ReadinessFinding',
    payload: { type: 'body_object_present', nodeId: ID, text: 'Text box', objectKind: 'textBox' },
    required: 'objectKind',
  },
];

describe('OpenAPI: clients can select every report variant by discriminator (#719)', () => {
  it('maps every declared discriminator value to exactly its oneOf branch', async () => {
    const doc = await loadSpec();
    const schemas = doc.components?.schemas ?? {};
    const tagged = z.object({ discriminator: z.object({ propertyName: z.string() }) });
    const branches = z.object({ properties: z.record(z.string(), z.unknown()) });
    const unions = Object.entries(schemas).filter(([, value]) => tagged.safeParse(value).success);
    expect(unions.length).toBeGreaterThan(0);
    for (const [name, value] of unions) {
      const union = UnionSchema.parse(value);
      const entries = union.oneOf.flatMap(({ $ref }) => {
        const component = $ref.replace('#/components/schemas/', '');
        const branch = branches.parse(schemas[component]);
        const tags = z
          .object({ enum: z.array(z.string()).nonempty() })
          .parse(branch.properties[union.discriminator.propertyName]);
        return tags.enum.map((tag): [string, string] => [tag, $ref]);
      });
      const expected = Object.fromEntries(entries);
      expect(Object.keys(expected), name).toHaveLength(entries.length);
      expect(union.discriminator.mapping, name).toEqual(expected);
    }
  });

  it.each(cases)(
    '$schema selects and validates $payload',
    async ({ schema, payload, required }) => {
      const doc = await loadSpec();
      const union = UnionSchema.parse(doc.components?.schemas?.[schema]);
      const tag = z.string().parse(payload[union.discriminator.propertyName]);
      const ref = z.string().parse(union.discriminator.mapping[tag]);
      expect(union.oneOf).toContainEqual({ $ref: ref });

      const selected = getValidator({ $ref: ref });
      // AJV validates plain oneOf/enum; client selection is checked separately above.
      const wholeUnion = getValidator({ $ref: `#/components/schemas/${schema}` });
      expect(selected(payload)).toBe(true);
      expect(wholeUnion(payload)).toBe(true);
      const incomplete = { ...payload };
      delete incomplete[required];
      expect(selected(incomplete)).toBe(false);
      expect(wholeUnion(incomplete)).toBe(false);
      expect(wholeUnion({ ...payload, [union.discriminator.propertyName]: 'unknown' })).toBe(false);
    }
  );
});
