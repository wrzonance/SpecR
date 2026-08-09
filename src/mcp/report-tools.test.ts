// src/mcp/report-tools.test.ts
//
// Pins that compare_specs' MCP input schema stays in lockstep with the
// polymorphic CompareSource contract in src/reporting/types.ts (#392,
// ADR-078). report-tools.ts hand-duplicates the sources shape rather than
// importing CompareSourceSchema (pre-existing manual-duplication pattern —
// ZodRawShape can't host a cross-field superRefine the way CompareRequestSchema
// does), so nothing but a test catches the two definitions drifting apart. The
// fixture ids and behavioral vectors mirror src/reporting/types.test.ts's
// CompareRequestSchema suite exactly, so both schemas are proven against the
// same inputs. A registrar fake records {description, inputSchema} without
// touching capabilities.ts tiers or the DB.
import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';
import { loadRawSpec, getValidator } from '../test-utils/contract/validate-response.js';

// registerReportTools also wires handleCoordinationReport, handleGetProjectKeynotes,
// and handleGetReferenceGraph, whose modules import ../db/index.js at module scope
// (env.ts exits the process without DATABASE_URL). Mock all four handler modules so
// this stays a pure no-DB unit test — mirrors header-footer-tools.test.ts.
vi.mock('./handlers.js', () => ({ handleCoordinationReport: vi.fn() }));
vi.mock('./reporting-handler.js', () => ({ handleCompareSpecs: vi.fn() }));
vi.mock('./keynotes-handler.js', () => ({ handleGetProjectKeynotes: vi.fn() }));
vi.mock('./reference-graph-handler.js', () => ({ handleGetReferenceGraph: vi.fn() }));
vi.mock('./text-boxes-handler.js', () => ({ handleTextBoxesReport: vi.fn() }));

import { registerReportTools } from './report-tools.js';
import type { ToolRegistrar } from './tool-registry.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const REV1 = '44444444-4444-4444-8444-444444444444';
const REV2 = '55555555-5555-4555-8555-555555555555';

interface Recorded {
  readonly description: string;
  readonly inputSchema: unknown;
}

function fakeRegistrar(): { registrar: ToolRegistrar; recorded: Map<string, Recorded> } {
  const recorded = new Map<string, Recorded>();
  const registrar: ToolRegistrar = {
    declared: [],
    schemas: new Map(),
    register(name, config) {
      recorded.set(name, { description: config.description, inputSchema: config.inputSchema });
    },
  };
  return { registrar, recorded };
}

function compareSpecsConfig(): Recorded {
  const { registrar, recorded } = fakeRegistrar();
  registerReportTools(registrar);
  const config = recorded.get('compare_specs');
  if (config === undefined) throw new Error('compare_specs was not registered');
  return config;
}

function sourcesSchema(): z.ZodTypeAny {
  const shape = compareSpecsConfig().inputSchema as { sources?: z.ZodTypeAny };
  const schema = shape.sources;
  if (schema === undefined) throw new Error('compare_specs registered no sources schema');
  return schema;
}

describe('compare_specs sources schema — polymorphic CompareSource (#392)', () => {
  it('accepts two distinct live (bare-uuid) sources', () => {
    expect(sourcesSchema().safeParse([A, B]).success).toBe(true);
  });

  it('rejects two identical live sources', () => {
    expect(sourcesSchema().safeParse([A, A]).success).toBe(false);
  });

  it('accepts a live source paired with a frozen source object', () => {
    expect(sourcesSchema().safeParse([A, { revisionId: REV1, specId: B }]).success).toBe(true);
  });

  it('accepts two frozen source objects for different specs', () => {
    const parsed = sourcesSchema().safeParse([
      { revisionId: REV1, specId: A },
      { revisionId: REV2, specId: B },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('rejects a frozen source object missing specId', () => {
    expect(sourcesSchema().safeParse([A, { revisionId: REV1 }]).success).toBe(false);
  });

  it('rejects a frozen source object with an extra, unrecognized property (mirrors .strict())', () => {
    const parsed = sourcesSchema().safeParse([A, { revisionId: REV1, specId: B, extra: 'nope' }]);
    expect(parsed.success).toBe(false);
  });

  it('rejects a source that is neither a bare uuid nor a frozen-source object', () => {
    expect(sourcesSchema().safeParse([A, 'not-a-uuid']).success).toBe(false);
    expect(sourcesSchema().safeParse([A, 42]).success).toBe(false);
  });

  it('rejects fewer than 2 sources', () => {
    expect(sourcesSchema().safeParse([A]).success).toBe(false);
  });

  it('rejects more than 2 sources', () => {
    expect(sourcesSchema().safeParse([A, B, C]).success).toBe(false);
  });
});

describe('compare_specs sources schema — canonical-key distinctness, not raw-value Set (#392)', () => {
  it('rejects two structurally-identical frozen source objects (same revisionId + specId)', () => {
    const parsed = sourcesSchema().safeParse([
      { revisionId: REV1, specId: A },
      { revisionId: REV1, specId: A },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('accepts a live source paired with a frozen source of the SAME underlying spec', () => {
    expect(sourcesSchema().safeParse([A, { revisionId: REV1, specId: A }]).success).toBe(true);
  });

  it('accepts the same spec frozen at two different revisions', () => {
    const parsed = sourcesSchema().safeParse([
      { revisionId: REV1, specId: A },
      { revisionId: REV2, specId: A },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe('compare_specs description — documents frozen sources and the baseline-ambiguity gap (#392)', () => {
  it('mentions revisionId (frozen/revision comparison support)', () => {
    expect(compareSpecsConfig().description).toContain('revisionId');
  });

  it('notes the baseline-ambiguity behavior explicitly', () => {
    expect(compareSpecsConfig().description).toMatch(/ambiguous/i);
  });
});

describe('text_boxes_report registration (#409)', () => {
  it('registers the scoped report with its MCP description and input shape', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerReportTools(registrar);
    const config = recorded.get('text_boxes_report');

    expect(config).toBeDefined();
    expect(config?.description).toContain('Tables are excluded');
    expect(config?.inputSchema).toHaveProperty('specId');
    expect(config?.inputSchema).toHaveProperty('projectId');
  });
});

// ── openapi.yaml lockstep (#392, ADR-078) ────────────────────────────────────
//
// The MCP sources shape above is hand-duplicated (see file header); so is
// openapi.yaml's CompareSource/ComparisonColumn (there is no shared schema
// object between the two authoring surfaces). Nothing but a test catches
// either one drifting from the other, so this cross-checks BOTH against the
// same fixture vectors used above, not just against each other structurally —
// a bug that changed both surfaces identically-but-wrongly would still be
// caught because each vector's expectation is pinned independently.

interface RawSchema {
  oneOf?: readonly RawSchema[];
  type?: string;
  format?: string;
  required?: readonly string[];
  properties?: Readonly<Record<string, RawSchema>>;
  items?: RawSchema;
  additionalProperties?: boolean;
  description?: string;
  $ref?: string;
  [key: string]: unknown;
}

interface RawOperation {
  description?: string;
}

interface RawSpecDoc {
  components: { schemas: Readonly<Record<string, RawSchema>> };
  paths: Readonly<Record<string, Readonly<Record<string, RawOperation>>>>;
}

async function rawSpec(): Promise<RawSpecDoc> {
  return (await loadRawSpec()) as RawSpecDoc;
}

async function componentSchema(name: string): Promise<RawSchema> {
  const schema = (await rawSpec()).components.schemas[name];
  if (schema === undefined) throw new Error(`${name} component missing from openapi.yaml (#392)`);
  return schema;
}

function sortedAlpha(values: readonly string[]): readonly string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** CompareSource's oneOf, narrowed to its two documented variants (live uuid,
 *  frozen object) — throws with a clear message rather than letting a
 *  malformed spec surface as a confusing `undefined` matcher failure below. */
function frozenVariantsOf(schema: RawSchema): readonly [RawSchema, RawSchema] {
  const variants = schema.oneOf;
  const [live, frozen] = variants ?? [];
  if (variants?.length !== 2 || live === undefined || frozen === undefined) {
    throw new Error('CompareSource must be documented as a oneOf of exactly two variants');
  }
  return [live, frozen];
}

describe('openapi.yaml CompareSource — named oneOf, strict frozen variant (#392, ADR-078)', () => {
  it('is a oneOf of exactly a live-spec uuid and a strict {revisionId, specId} object', async () => {
    const [live, frozen] = frozenVariantsOf(await componentSchema('CompareSource'));
    expect(live).toMatchObject({ type: 'string', format: 'uuid' });
    expect(frozen.type).toBe('object');
    expect(frozen.additionalProperties).toBe(false);
    expect(sortedAlpha(frozen.required ?? [])).toEqual(['revisionId', 'specId']);
    expect(frozen.properties?.['revisionId']).toMatchObject({ type: 'string', format: 'uuid' });
    expect(frozen.properties?.['specId']).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('CompareRequest.sources documents items against the named CompareSource schema', async () => {
    const compareRequest = await componentSchema('CompareRequest');
    expect(compareRequest.properties?.['sources']?.items).toEqual({
      $ref: '#/components/schemas/CompareSource',
    });
  });
});

interface SourceVector {
  readonly name: string;
  readonly value: unknown;
  readonly expected: boolean;
}

const SOURCE_VECTORS: readonly SourceVector[] = [
  { name: 'a live spec uuid', value: B, expected: true },
  { name: 'a non-uuid string', value: 'not-a-uuid', expected: false },
  { name: 'a number', value: 42, expected: false },
  { name: 'an empty object', value: {}, expected: false },
  {
    name: 'a frozen object with revisionId + specId',
    value: { revisionId: REV1, specId: B },
    expected: true,
  },
  { name: 'a frozen object missing specId', value: { revisionId: REV1 }, expected: false },
  { name: 'a frozen object missing revisionId', value: { specId: B }, expected: false },
  {
    name: 'a frozen object with an extra, unrecognized property',
    value: { revisionId: REV1, specId: B, extra: 'nope' },
    expected: false,
  },
];

describe('CompareSource — MCP zod schema and openapi.yaml schema agree on every vector (#392)', () => {
  it.each(SOURCE_VECTORS)(
    '$name -> accepted=$expected on both surfaces',
    async ({ value, expected }) => {
      const validate = getValidator(await componentSchema('CompareSource'));
      expect(validate(value), 'openapi.yaml CompareSource').toBe(expected);
      expect(sourcesSchema().safeParse([A, value]).success, 'MCP sources schema').toBe(expected);
    }
  );
});

describe('openapi.yaml ComparisonColumn documents the additive revision fields (#392, ADR-078)', () => {
  it('keeps specId/section/title required and adds revisionId/revisionLabel as optional strings', async () => {
    const schema = await componentSchema('ComparisonColumn');
    expect(sortedAlpha(schema.required ?? [])).toEqual(['section', 'specId', 'title']);
    expect(schema.required ?? []).not.toContain('revisionId');
    expect(schema.required ?? []).not.toContain('revisionLabel');
    expect(schema.properties?.['revisionId']).toMatchObject({ type: 'string', format: 'uuid' });
    expect(schema.properties?.['revisionLabel']).toMatchObject({ type: 'string' });
  });
});

describe('openapi.yaml post /reports/compare documents frozen sources and baseline ambiguity (#392)', () => {
  it('mentions revisionId and the ambiguous-baseline 422 behavior', async () => {
    const op = (await rawSpec()).paths['/reports/compare']?.['post'];
    if (op === undefined) throw new Error('post /reports/compare missing from openapi.yaml');
    expect(op.description ?? '').toContain('revisionId');
    expect(op.description ?? '').toMatch(/ambiguous/i);
  });
});
