// src/mcp/contract.integration.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSpec, specOperationManifest } from '../test-utils/contract/validate-response.js';
import { registerTools, ALL_TIERS } from './tools.js';
import { OP_TO_TOOL, MCP_UNEXPOSED, MCP_NATIVE } from './contract-map.js';

// REST ops that are never agent actions (asserted, not silently skipped).
const EXEMPT = new Set<string>([
  'get /health',
  'get /openapi.yaml',
  'get /docs',
  'get /mcp',
  'post /mcp',
  'delete /mcp',
]);

function declaredToolNames(): readonly string[] {
  const server = new McpServer({ name: 'contract', version: '0' });
  return registerTools(server, { allowedTiers: ALL_TIERS }); // throws if any tool lacks a tier (INV-3)
}

describe('MCP contract (REST <-> MCP parity)', () => {
  it('INV-1: every user-facing REST op maps to a tool or is explicitly unexposed', async () => {
    const doc = await loadSpec();
    const ops = specOperationManifest(doc).filter((o) => !EXEMPT.has(o));
    const uncovered = ops
      .filter((o) => !OP_TO_TOOL.has(o) && !MCP_UNEXPOSED.has(o))
      .sort((a, b) => a.localeCompare(b));
    expect(uncovered, 'REST ops with no MCP tool and no MCP_UNEXPOSED entry').toEqual([]);
  });

  it('INV-2: every registered tool maps to a real op or is MCP-native (no orphans)', () => {
    const mapped = new Set(OP_TO_TOOL.values());
    const orphans = declaredToolNames()
      .filter((name) => !mapped.has(name) && !MCP_NATIVE.has(name))
      .sort((a, b) => a.localeCompare(b));
    expect(orphans, 'MCP tools that map to nothing (add to OP_TO_TOOL or MCP_NATIVE)').toEqual([]);
  });

  it('INV-2b: every OP_TO_TOOL value is an actually-registered tool (no phantom mappings)', () => {
    // Without this, an op mapped to a misspelled or since-removed tool name (e.g. a
    // burn-down wave renames the tool but leaves the map entry) would still count as
    // "covered" by INV-1 while no tool performs it — the exact silent REST<->MCP drift
    // ADR-044 exists to prevent. declaredToolNames() uses ALL_TIERS, so gated tools count.
    const declared = new Set(declaredToolNames());
    const phantom = [...OP_TO_TOOL.entries()]
      .filter(([, tool]) => !declared.has(tool))
      .map(([op, tool]) => `${op} -> ${tool}`)
      .sort((a, b) => a.localeCompare(b));
    expect(phantom, 'OP_TO_TOOL entries mapping to a non-registered tool').toEqual([]);
  });

  it('INV-3: every registered tool has a declared capability tier', () => {
    // declaredToolNames() throws inside the registrar if any tool is untiered.
    expect(() => declaredToolNames()).not.toThrow();
  });

  it('MCP_UNEXPOSED and OP_TO_TOOL are disjoint and reference real ops', async () => {
    const doc = await loadSpec();
    const real = new Set(specOperationManifest(doc));
    for (const op of OP_TO_TOOL.keys())
      expect(real.has(op), `${op} not in openapi.yaml`).toBe(true);
    for (const op of MCP_UNEXPOSED.keys())
      expect(real.has(op), `${op} not in openapi.yaml`).toBe(true);
    for (const op of OP_TO_TOOL.keys()) expect(MCP_UNEXPOSED.has(op)).toBe(false);
  });
});
