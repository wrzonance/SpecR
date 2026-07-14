// src/api/header-footer-table-openapi.test.ts
//
// #309 (ADR-071) — header/footer capture and rendering now support a
// table/grid `region.table` slot (src/ast/header-footer-schemas.ts). This
// pins openapi.yaml, the hand-authored, live contract (ADR-026), to that
// addition:
//
//   1. Anchor/alias reuse, not copy-pasted duplicates. `&headerFooterTable`
//      is defined at exactly one site (`header.properties.table`) and
//      aliased at exactly the three other sites the design calls for
//      (`footer.properties.table` plus `variants.default`'s `header`/
//      `footer.properties.table`) — mirroring the pre-existing
//      `&headerFooterRuleLine` pattern. A table cell's `content` items
//      alias the SAME `&headerFooterField` anchor extracted out of the
//      pre-existing inline `left.content.items` schema, not a second,
//      parallel field schema (ADR-071 decision 2/3).
//   2. The dereferenced shape matches the Zod schema
//      (HeaderFooterTableSchema/-Row/-Cell): `rows` required + `minItems: 1`,
//      each row requires `cells`, each cell's `content`/`columnSpan`/
//      `separator`/`style` are optional and `content` reuses the 13-kind
//      field schema, and `borders` reuses the rule-line shape.
//   3. A realistic table-bearing HeaderFooterConfig response validates
//      end-to-end against the documented schema (positive case), and a
//      table violating `rows minItems: 1` is rejected (negative case) —
//      proving the constraint is enforced, not just documented.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { assertResponse, loadRawSpec } from '../test-utils/contract/validate-response.js';

const SPEC_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));
const ROUTE = '/projects/{id}/header-footer';

function countOccurrences(text: string, literal: string): number {
  return text.split(literal).length - 1;
}

const HeaderFooterFieldItemSchema = z.object({
  type: z.literal('object'),
  required: z.array(z.string()),
  properties: z.object({ kind: z.unknown() }),
});

const HeaderFooterTableSchema = z.object({
  type: z.literal('object'),
  required: z.array(z.string()),
  properties: z.object({
    rows: z.object({
      type: z.literal('array'),
      minItems: z.literal(1),
      items: z.object({
        type: z.literal('object'),
        required: z.array(z.string()),
        properties: z.object({
          cells: z.object({
            type: z.literal('array'),
            items: z.object({
              type: z.literal('object'),
              properties: z.object({
                content: z.object({ type: z.literal('array'), items: HeaderFooterFieldItemSchema }),
                columnSpan: z.object({ type: z.literal('integer'), minimum: z.literal(1) }),
                separator: z.object({ type: z.literal('string') }),
                style: z.unknown(),
              }),
            }),
          }),
        }),
      }),
    }),
    columnWidths: z.object({
      type: z.literal('array'),
      items: z.object({ type: z.literal('integer'), minimum: z.literal(1) }),
    }),
    borders: z.unknown(),
  }),
});

const RegionSchema = z.object({
  properties: z.object({
    table: HeaderFooterTableSchema,
    left: z.object({
      properties: z.object({ content: z.object({ items: HeaderFooterFieldItemSchema }) }),
    }),
  }),
});

const SchemasSchema = z.object({
  components: z.object({
    schemas: z.object({
      HeaderFooterComposition: z.object({
        properties: z.object({
          header: RegionSchema,
          footer: RegionSchema,
          variants: z.object({
            properties: z.object({
              default: z.object({
                properties: z.object({
                  header: RegionSchema,
                  footer: RegionSchema,
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});

describe('openapi.yaml — header/footer table composition (#309, ADR-071)', () => {
  it('&headerFooterTable is defined once and aliased at exactly the 3 documented sites', () => {
    const text = readFileSync(SPEC_PATH, 'utf-8');
    expect(
      countOccurrences(text, '&headerFooterTable'),
      'expected exactly one &headerFooterTable anchor definition'
    ).toBe(1);
    expect(
      countOccurrences(text, '*headerFooterTable'),
      'expected exactly 3 *headerFooterTable aliases (footer + variants.default header/footer)'
    ).toBe(3);
  });

  it('&headerFooterField is defined once (extracted from left.content.items) and aliased once (table cell content)', () => {
    const text = readFileSync(SPEC_PATH, 'utf-8');
    expect(
      countOccurrences(text, '&headerFooterField'),
      'expected exactly one &headerFooterField anchor definition'
    ).toBe(1);
    expect(
      countOccurrences(text, '*headerFooterField'),
      'expected exactly one *headerFooterField alias (table cell content reuse)'
    ).toBe(1);
  });

  it('header.properties.table matches HeaderFooterTableSchema (rows required + minItems 1, cells required per row)', async () => {
    const raw = await loadRawSpec();
    const { header } =
      SchemasSchema.parse(raw).components.schemas.HeaderFooterComposition.properties;
    const table = header.properties.table;
    expect(table.required).toEqual(['rows']);
    expect(table.properties.rows.minItems).toBe(1);
    expect(table.properties.rows.items.required).toEqual(['cells']);
  });

  it('footer.properties.table and variants.default.header/footer.properties.table are the SAME schema as header.properties.table (alias reuse, not a copy)', async () => {
    const raw = await loadRawSpec();
    const { header, footer, variants } =
      SchemasSchema.parse(raw).components.schemas.HeaderFooterComposition.properties;
    const headerTable = header.properties.table;
    expect(footer.properties.table).toEqual(headerTable);
    expect(variants.properties.default.properties.header.properties.table).toEqual(headerTable);
    expect(variants.properties.default.properties.footer.properties.table).toEqual(headerTable);
  });

  it("a table cell's content item schema is the SAME schema as left/center/right's content item (no parallel field schema)", async () => {
    const raw = await loadRawSpec();
    const { header } =
      SchemasSchema.parse(raw).components.schemas.HeaderFooterComposition.properties;
    const cellFieldItem = header.properties.left.properties.content.items;
    const tableCellFieldItem =
      header.properties.table.properties.rows.items.properties.cells.items.properties.content.items;
    expect(tableCellFieldItem).toEqual(cellFieldItem);
  });

  it('validates a realistic table-bearing header/footer config response (positive case)', async () => {
    const body = {
      success: true,
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222222' },
        config: {
          header: {
            table: {
              rows: [
                {
                  cells: [
                    { content: [{ kind: 'literal', text: 'Drawing No.' }] },
                    { content: [{ kind: 'sectionNumber' }], columnSpan: 2 },
                  ],
                },
              ],
              columnWidths: [2000, 4000],
              borders: { enabled: true, widthTwips: 4, color: '000000', style: 'single' },
            },
          },
          footer: {
            table: { rows: [{ cells: [{ content: [{ kind: 'pageNumber' }] }] }] },
          },
        },
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
    };
    await expect(assertResponse('get', ROUTE, 200, body)).resolves.toBeUndefined();
  });

  it('rejects a table with zero rows (rows minItems: 1 enforced, negative case)', async () => {
    const body = {
      success: true,
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222222' },
        config: { header: { table: { rows: [] } } },
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
    };
    await expect(assertResponse('get', ROUTE, 200, body)).rejects.toThrow(/does not match/);
  });
});
