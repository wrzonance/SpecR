// src/mcp/contract-request-parity.integration.test.ts
// INV-4 (#549): every OpenAPI-documented query/body param an operation requires must be
// discoverable somewhere in its mapped MCP tool's inputSchema — a universal request-parameter-
// parity gate over the entire OP_TO_TOOL surface (the previous create_project-only check pinned
// this for exactly one op; this promotes it repo-wide). No DB access — pure static introspection
// against openapi.yaml + the registered tool schemas, so it needs no seeded fixtures.
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, ALL_TIERS } from './tools.js';
import { OP_TO_TOOL, INV4_PARAM_EXEMPT } from './contract-map.js';
import {
  OPS_WITH_OBJECT_LEVEL_RULE,
  SCHEMA_SHARING_EXEMPT,
  SCHEMA_SHARING_PENDING,
} from './contract-schema-sharing-map.js';
import { toolInputKeys, isFullSchemaInstance } from './tool-schema-introspect.js';
import {
  loadSpec,
  operationParamKeys,
  operationPathTemplates,
} from '../test-utils/contract/validate-response.js';
import type { ToolInputSchema } from './tool-registry.js';

function registeredSchemas(): ReadonlyMap<string, ToolInputSchema> {
  const server = new McpServer({ name: 'contract-request-parity', version: '0' });
  return registerTools(server, { allowedTiers: ALL_TIERS }).schemas;
}

describe('INV-4: request-parameter parity (REST op params <-> MCP tool inputSchema)', () => {
  const schemas = registeredSchemas();
  const parityCases = [...OP_TO_TOOL].filter(([op]) => !INV4_PARAM_EXEMPT.has(op));

  it.each(parityCases)(
    '%s -> %s: every documented query/body param is in the tool inputSchema',
    async (op, tool) => {
      const doc = await loadSpec();
      const literalPath = operationPathTemplates(doc).get(op);
      expect(literalPath, `${op} has no matching literal path in openapi.yaml`).toBeDefined();
      const [method] = op.split(' ');
      const { query, body } = operationParamKeys(doc, method!, literalPath!);
      const expected = new Set([...query, ...body]);
      const actual = toolInputKeys(schemas.get(tool));
      const missing = [...expected].filter((key) => !actual.has(key));
      expect(
        missing,
        `${tool} (${op}) is missing REST param(s) [${missing.join(', ')}] — either add them to ` +
          'the tool inputSchema, or add a reasoned INV4_PARAM_EXEMPT entry in contract-map.ts'
      ).toEqual([]);
    }
  );

  it('INV-4 exemption hygiene: every INV4_PARAM_EXEMPT entry keys a real op and carries a reason', () => {
    for (const [op, reason] of INV4_PARAM_EXEMPT) {
      expect(OP_TO_TOOL.has(op), `INV4_PARAM_EXEMPT references unknown op "${op}"`).toBe(true);
      expect(reason.length > 0, `INV4_PARAM_EXEMPT entry for "${op}" has an empty reason`).toBe(
        true
      );
    }
  });
});

// ── Item 5 (#549): schema-instance-sharing gate ──────────────────────────────
// INV-4 above proves every REST param name is *discoverable* in a tool's inputSchema; it says
// nothing about whether an OBJECT-LEVEL `.strict()`/`.check()` rule on the REST body schema
// (cross-field refinements, unknown-key rejection) survives being handed to the MCP SDK. A
// `{ ...Schema.shape }` spread carries every field but silently drops that rule — the SDK
// rebuilds a plain `z.object(shape)` from the raw shape. OPS_WITH_OBJECT_LEVEL_RULE is the
// audited list of ops whose body schema carries such a rule; every entry must land in exactly
// one of three buckets — verified passing (isFullSchemaInstance), SCHEMA_SHARING_EXEMPT
// (verified safe some other way), or SCHEMA_SHARING_PENDING (a real, deferred gap) — never
// silently unaccounted for.
describe('Item 5: schema-instance-sharing (object-level rules survive SDK registration)', () => {
  const schemas = registeredSchemas();
  const checkedCases = [...OPS_WITH_OBJECT_LEVEL_RULE].filter(
    ([op]) => !SCHEMA_SHARING_EXEMPT.has(op) && !SCHEMA_SHARING_PENDING.has(op)
  );

  it.each(checkedCases)(
    '%s -> %s: the object-level rule survives (tool inputSchema is a full schema instance)',
    (op, rule) => {
      const tool = OP_TO_TOOL.get(op);
      expect(tool, `${op} is not in OP_TO_TOOL`).toBeDefined();
      expect(
        isFullSchemaInstance(schemas.get(tool!)),
        `${tool} (${op}) advertises inputSchema as a raw shape, silently dropping its object-` +
          `level rule (${rule}) — either register it via .extend()/the schema instance itself, ` +
          'or add a reasoned SCHEMA_SHARING_EXEMPT/SCHEMA_SHARING_PENDING entry in ' +
          'contract-schema-sharing-map.ts'
      ).toBe(true);
    }
  );

  it('Item 5 completeness: every OPS_WITH_OBJECT_LEVEL_RULE entry is checked, exempt, or pending — never both exempt and pending', () => {
    for (const op of OPS_WITH_OBJECT_LEVEL_RULE.keys()) {
      const inExempt = SCHEMA_SHARING_EXEMPT.has(op);
      const inPending = SCHEMA_SHARING_PENDING.has(op);
      expect(
        inExempt && inPending,
        `"${op}" is in both SCHEMA_SHARING_EXEMPT and SCHEMA_SHARING_PENDING`
      ).toBe(false);
    }
  });

  it('Item 5 hygiene: every SCHEMA_SHARING_EXEMPT entry keys a real object-level-rule op and carries a reason', () => {
    for (const [op, reason] of SCHEMA_SHARING_EXEMPT) {
      expect(
        OPS_WITH_OBJECT_LEVEL_RULE.has(op),
        `SCHEMA_SHARING_EXEMPT references an op with no OPS_WITH_OBJECT_LEVEL_RULE entry: "${op}"`
      ).toBe(true);
      expect(reason.length > 0, `SCHEMA_SHARING_EXEMPT entry for "${op}" has an empty reason`).toBe(
        true
      );
    }
  });

  it('Item 5 hygiene: every SCHEMA_SHARING_PENDING entry keys a real object-level-rule op', () => {
    for (const op of SCHEMA_SHARING_PENDING) {
      expect(
        OPS_WITH_OBJECT_LEVEL_RULE.has(op),
        `SCHEMA_SHARING_PENDING references an op with no OPS_WITH_OBJECT_LEVEL_RULE entry: "${op}"`
      ).toBe(true);
    }
  });

  it('submittal_register stays PENDING (#550) — never silently EXEMPT, never asserted-failing here', () => {
    const op = 'post /projects/{}/submittal-register';
    expect(SCHEMA_SHARING_PENDING.has(op)).toBe(true);
    expect(SCHEMA_SHARING_EXEMPT.has(op)).toBe(false);
  });
});
