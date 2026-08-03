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
// it publishes either carries UTF16_LENGTH_LIMIT_NOTE in its description, or
// names a field on the documented ASCII-only exclusion list (where the UTF-16
// count and the Unicode code-point count are provably identical, so there is
// no divergence to document). A new bare `maxLength` fails here by default.
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

/**
 * Field names whose alphabet is ASCII-only, so `.length` (UTF-16 units) and
 * `[...str].length` (code points) are always numerically identical and there
 * is nothing for ADR-088 to document. Keep this list minimal and justified —
 * adding a name here is how a real divergence would get hidden.
 */
const ASCII_ONLY_FIELDS: ReadonlySet<string> = new Set([
  // base64 payload, RFC 4648 alphabet (ADR-069 byte cap)
  'imageData',
]);

interface LengthField {
  readonly path: string;
  readonly maxLength: number;
  readonly description: string;
  readonly fieldName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** This node's own `maxLength`, if it declares one. */
function ownLengthField(
  schema: Record<string, unknown>,
  path: string,
  fieldName: string
): LengthField[] {
  const max = schema['maxLength'];
  if (typeof max !== 'number') return [];
  const description = schema['description'];
  return [
    {
      path,
      maxLength: max,
      description: typeof description === 'string' ? description : '',
      fieldName,
    },
  ];
}

/** Named object properties — each descends under its own field name. */
function childrenOfProperties(schema: Record<string, unknown>, path: string): LengthField[] {
  const properties = schema['properties'];
  if (!isRecord(properties)) return [];
  return Object.entries(properties).flatMap(([key, value]) =>
    collectLengthFields(value, `${path}.${key}`, key)
  );
}

/** Array/record element schemas — the field name carries through unchanged. */
function childrenOfContainers(
  schema: Record<string, unknown>,
  path: string,
  fieldName: string
): LengthField[] {
  return (['items', 'additionalProperties'] as const)
    .map((key) => schema[key])
    .filter(isRecord)
    .flatMap((value) => collectLengthFields(value, `${path}[]`, fieldName));
}

/** anyOf/oneOf/allOf branches — likewise keep the field name. */
function childrenOfCombinators(
  schema: Record<string, unknown>,
  path: string,
  fieldName: string
): LengthField[] {
  return (['anyOf', 'oneOf', 'allOf'] as const).flatMap((key) => {
    const branches = schema[key];
    if (!Array.isArray(branches)) return [];
    return branches.flatMap((branch: unknown, index: number) =>
      collectLengthFields(branch, `${path}/${key}${index}`, fieldName)
    );
  });
}

/** Recursively collect every `maxLength` in a generated JSON Schema. */
function collectLengthFields(node: unknown, path: string, fieldName: string): LengthField[] {
  if (!isRecord(node)) return [];
  return [
    ...ownLengthField(node, path, fieldName),
    ...childrenOfProperties(node, path),
    ...childrenOfContainers(node, path, fieldName),
    ...childrenOfCombinators(node, path, fieldName),
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
    fields.push(...collectLengthFields(generated, toolName, toolName));
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

  it('no tool publishes a maxLength without either the UTF-16 note or an ASCII-only exemption', () => {
    const undocumented = allPublishedLengthFields().filter(
      (field) =>
        !ASCII_ONLY_FIELDS.has(field.fieldName) &&
        !field.description.includes(UTF16_LENGTH_LIMIT_NOTE)
    );

    expect(
      undocumented.map((field) => `${field.path} (maxLength: ${field.maxLength})`),
      'these MCP tool fields publish a JSON Schema maxLength — which the spec defines in Unicode ' +
        'code points — while Zod enforces it in UTF-16 code units, and their description does not ' +
        'say so. Append UTF16_LENGTH_LIMIT_NOTE to the field’s .describe(), or, if the field’s ' +
        'alphabet is provably ASCII-only, add it to ASCII_ONLY_FIELDS above with a justification'
    ).toEqual([]);
  });
});
