// src/mcp/tools.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, ALL_TIERS } from './tools.js';
import { TOOL_TIERS } from './capabilities.js';

describe('registerTools', () => {
  it('captures a schema for every declared tool independent of tier gating', () => {
    // Two servers, two tier restrictions: 'read' only vs every tier. Schema
    // capture must be identical either way — introspection (contract tests)
    // needs to see every tool's input shape regardless of which tiers a given
    // MCP_ALLOWED_TIERS runtime config happens to admit.
    const restricted = registerTools(new McpServer({ name: 'restricted', version: '0' }), {
      allowedTiers: new Set(['read']),
    });
    const full = registerTools(new McpServer({ name: 'full', version: '0' }), {
      allowedTiers: ALL_TIERS,
    });

    expect(restricted.names).toEqual(full.names);
    const sortedKeys = (map: ReadonlyMap<string, unknown>): string[] =>
      [...map.keys()].sort((a, b) => a.localeCompare(b));
    expect(sortedKeys(restricted.schemas)).toEqual(sortedKeys(full.schemas));

    // The invariant is only meaningful if at least one gated-off (non-'read')
    // tool actually has a captured schema — otherwise the assertion above
    // would pass vacuously for an empty set.
    const gatedToolWithSchema = restricted.names.find(
      (name) => TOOL_TIERS.get(name) !== 'read' && restricted.schemas.has(name)
    );
    expect(gatedToolWithSchema).toBeDefined();
  });
});
