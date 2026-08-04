// src/mcp/length-limit-unit-convention.test.ts
//
// #642 (ADR-091) uniformity gate for the MCP tool surface — supersedes the
// #626/ADR-088 note-presence sweep this file used to run.
//
// The REST half is pinned site-by-site in
// src/api/length-limit-unit-convention.test.ts against a hand-authored
// openapi.yaml. The MCP half cannot be pinned that way: a tool's JSON Schema
// is GENERATED from its Zod shape, so a new tool (or a new field on an
// existing one) can publish a fresh `maxLength` without anyone editing a
// contract file. An enumerate-the-known-sites test would silently pass over
// exactly that case.
//
// So this asserts the invariant instead of the inventory: walk EVERY
// registered tool's generated JSON Schema and require that every `maxLength`
// it publishes carries the LENGTH_UNIT_META_KEY marker (`x-length-unit:
// unicode-code-point`) — the vendor-extension `.meta()` key only
// `codePointMax` (src/lib/length-limit.ts) can produce. This is a STRONGER
// anti-vacuity device than the old prose-substring check it replaces: the
// old check could be satisfied by copy-pasting a sentence into a
// `.describe()` with no enforcement behind it; this one can only be
// satisfied by actually routing the field through the real helper. There is
// no exemption list — a new bare `maxLength` fails here by default.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { LENGTH_UNIT_META_KEY, CODE_POINT_LENGTH_UNIT } from '../lib/length-limit.js';
import { collectLengthFields, type LengthField } from '../test-utils/contract/length-fields.js';
import { registerTools } from './tools.js';
import { TOOL_TIER_VALUES } from './capabilities.js';

/** Every `maxLength` published across every registered tool's input schema. */
function allPublishedLengthFields(): LengthField[] {
  // Register with ALL tiers so tier-gated tools (destructive ones are off by
  // default per ADR-045) are still inspected — a gated tool's schema is still
  // part of the declared contract.
  const server = new McpServer({ name: 'length-limit-audit', version: '0.0.0' });
  const { schemas } = registerTools(server, { allowedTiers: new Set(TOOL_TIER_VALUES) });

  const fields: LengthField[] = [];
  for (const [toolName, inputSchema] of schemas) {
    // A tool declares either a raw `{ name: zodType }` shape or a whole Zod
    // object schema (see ToolInputSchema in tool-registry.ts) — normalize.
    const asObject =
      typeof inputSchema === 'object' && '_zod' in inputSchema
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape);
    const generated = toJsonSchemaCompat(asObject as never, { io: 'input' } as never);
    fields.push(...collectLengthFields(generated, toolName));
  }
  return fields;
}

describe('MCP tool schemas — every published maxLength enforces Unicode code points (#642)', () => {
  it('registers tools whose schemas actually publish maxLength bounds (guards against a vacuous sweep)', () => {
    const fields = allPublishedLengthFields();
    expect(
      fields.length,
      'no MCP tool published a maxLength at all — the sweep below would pass vacuously, so this ' +
        'is a harness failure (tool registration or schema generation changed), not a clean bill'
    ).toBeGreaterThan(10);
  });

  it('no tool publishes a maxLength without the code-point-unit marker', () => {
    const undocumented = allPublishedLengthFields().filter(
      (field) => field.node[LENGTH_UNIT_META_KEY] !== CODE_POINT_LENGTH_UNIT
    );

    expect(
      undocumented.map((field) => `${field.path} (maxLength: ${field.maxLength})`),
      'these MCP tool fields publish a JSON Schema maxLength without the x-length-unit: ' +
        'unicode-code-point marker — meaning the field was not built via codePointMax ' +
        '(src/lib/length-limit.ts) and is not actually enforced in the unit maxLength means. ' +
        'Route the field through codePointMax; do not add an exemption instead — a bound that ' +
        'is published is a bound a client can be misled by'
    ).toEqual([]);
  });

  // #642 sprint policy item 7 — the known `...Schema.shape` spread trap
  // (spreading a Zod object's `.shape` into another object drops
  // OBJECT-level `.strict()`/`.check()`, but preserves FIELD-level
  // `.refine()`/`.meta()` — confirmed by spike against this toolchain).
  // create_checkpoint's shape spreads CreateCheckpointBodySchema.shape,
  // which carries actorLabel: ActorLabelSchema (src/ast/checkpoint-schemas.ts).
  // This asserts, on the ACTUAL generated tool schema (not by grep or by
  // inference from the general sweep above), that the spread did not lose
  // the bound — the highest-risk `.shape`-spread site in this change.
  it('create_checkpoint.actorLabel survives the CreateCheckpointBodySchema.shape spread', () => {
    const field = allPublishedLengthFields().find(
      (candidate) =>
        candidate.path.startsWith('create_checkpoint') && candidate.path.endsWith('.actorLabel')
    );
    expect(
      field,
      'create_checkpoint no longer publishes a maxLength for actorLabel at all'
    ).toBeDefined();
    expect(field?.node[LENGTH_UNIT_META_KEY]).toBe(CODE_POINT_LENGTH_UNIT);
  });
});
