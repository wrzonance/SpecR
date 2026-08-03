// src/mcp/length-limit-unit-convention.test.ts
//
// #626 (ADR-088) uniformity gate for the MCP tool surface.
//
// The REST half of #626 is pinned site-by-site in
// src/api/length-limit-unit-convention.test.ts against a hand-authored
// openapi.yaml. The MCP half cannot be pinned that way: a tool's JSON Schema
// is GENERATED from its Zod shape, so a new tool (or a new field on an
// existing one) can publish a fresh `maxLength` without anyone editing a
// contract file. An enumerate-the-known-sites test would silently pass over
// exactly that case — and the issue behind ADR-088 calls a partial fix worse
// than none.
//
// So this asserts the invariant instead of the inventory: walk EVERY
// registered tool's generated JSON Schema and require that every `maxLength`
// it publishes carries UTF16_LENGTH_LIMIT_NOTE in its description. There is no
// exemption list — a new bare `maxLength` fails here by default.
//
// Why it matters on this surface specifically: JSON Schema's `maxLength` is
// defined in Unicode code points, Zod's `.max()`/`z.maxLength()` counts UTF-16
// code units, and an MCP client consumes the generated schema mechanically —
// it has no prose to read unless the description carries it.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { UTF16_LENGTH_LIMIT_NOTE } from '../lib/length-limit-note.js';
import { registerTools } from './tools.js';
import { TOOL_TIER_VALUES } from './capabilities.js';

// There is deliberately NO exemption list here. An earlier revision exempted
// `imageData` as "ASCII-only base64", but that field is validated as a plain
// bounded string with no base64 pattern behind it, so astral text reaches it
// like anywhere else — the exemption was convenient rather than true. A
// name-keyed allowlist would also have silently covered any future unrelated
// field that happened to share the name. Every published bound is documented.

interface LengthField {
  readonly path: string;
  readonly maxLength: number;
  readonly description: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** This node's own `maxLength`, if it declares one. */
function ownLengthField(schema: Record<string, unknown>, path: string): LengthField[] {
  const max = schema['maxLength'];
  if (typeof max !== 'number') return [];
  const description = schema['description'];
  return [
    { path, maxLength: max, description: typeof description === 'string' ? description : '' },
  ];
}

/**
 * Recursively collect every `maxLength` in a generated JSON Schema.
 *
 * Structure-agnostic on purpose: it descends through every object value and
 * array element rather than following the keywords a JSON Schema is *expected*
 * to nest under. An earlier revision walked only properties/items/combinators
 * and was blind to `$defs`/`definitions` — a bound behind a `$ref` (which Zod
 * emits for any schema carrying `.meta({ id })`) would have gone unchecked
 * while the sweep still reported a clean pass.
 */
function collectLengthFields(node: unknown, path: string): LengthField[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => collectLengthFields(item, `${path}[${index}]`));
  }
  if (!isRecord(node)) return [];
  return [
    ...ownLengthField(node, path),
    ...Object.entries(node).flatMap(([key, value]) => collectLengthFields(value, `${path}.${key}`)),
  ];
}

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

describe('MCP tool schemas — every published maxLength documents the ADR-088 unit convention (#626)', () => {
  it('registers tools whose schemas actually publish maxLength bounds (guards against a vacuous sweep)', () => {
    const fields = allPublishedLengthFields();
    expect(
      fields.length,
      'no MCP tool published a maxLength at all — the sweep below would pass vacuously, so this ' +
        'is a harness failure (tool registration or schema generation changed), not a clean bill'
    ).toBeGreaterThan(10);
  });

  it('no tool publishes a maxLength without the UTF-16 note', () => {
    const undocumented = allPublishedLengthFields().filter(
      (field) => !field.description.includes(UTF16_LENGTH_LIMIT_NOTE)
    );

    expect(
      undocumented.map((field) => `${field.path} (maxLength: ${field.maxLength})`),
      'these MCP tool fields publish a JSON Schema maxLength — which the spec defines in Unicode ' +
        'code points — while Zod enforces it in UTF-16 code units, and their description does not ' +
        'say so. Append UTF16_LENGTH_LIMIT_NOTE to the field’s .describe(). Do not add an ' +
        'exemption instead: a bound that is published is a bound a client can be misled by, and ' +
        '"the alphabet looks ASCII" is not enforcement unless a pattern actually constrains it'
    ).toEqual([]);
  });
});
