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
import { toolInputKeys } from './tool-schema-introspect.js';
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
