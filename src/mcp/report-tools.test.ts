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

// registerReportTools also wires handleCoordinationReport, handleGetProjectKeynotes,
// and handleGetReferenceGraph, whose modules import ../db/index.js at module scope
// (env.ts exits the process without DATABASE_URL). Mock all four handler modules so
// this stays a pure no-DB unit test — mirrors header-footer-tools.test.ts.
vi.mock('./handlers.js', () => ({ handleCoordinationReport: vi.fn() }));
vi.mock('./reporting-handler.js', () => ({ handleCompareSpecs: vi.fn() }));
vi.mock('./keynotes-handler.js', () => ({ handleGetProjectKeynotes: vi.fn() }));
vi.mock('./reference-graph-handler.js', () => ({ handleGetReferenceGraph: vi.fn() }));

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
