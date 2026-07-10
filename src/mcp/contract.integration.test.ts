// src/mcp/contract.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createProject, createClient, pool } from '../db/index.js';
import {
  loadSpec,
  specOperationManifest,
  assertResponse,
} from '../test-utils/contract/validate-response.js';
import { registerTools, ALL_TIERS } from './tools.js';
import {
  OP_TO_TOOL,
  MCP_UNEXPOSED,
  MCP_NATIVE,
  INV5_SHAPE_EXEMPT,
  INV5_READ_PENDING,
} from './contract-map.js';
import { handleListLibraries, handleListProjects } from './handlers.js';
import { handleListTemplates } from './template-handlers.js';
import { handleListConventions } from './convention-handlers.js';
import { handleListRevisionNomenclatureProfiles } from './revision-nomenclature-handlers.js';
import { handleListClients } from './clients-handlers.js';
import type { ToolResult } from './tool-result.js';

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

// ── INV-5 (#403): tool response-shape validation ─────────────────────────────
// A driven case invokes a read tool against seeded data; INV-5 wraps its BARE payload as the REST
// envelope `{ success: true, data }` and reuses assertResponse to validate it against the mapped
// op's OpenAPI response schema. These six handlers return `ok(await listX())`, and each REST route
// returns `{ success: true, data: <same listX()> }`, so the wrapped payload is byte-identical to
// the REST body the REST contract gate already validates — correct by construction.
interface DrivenCase {
  readonly tool: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly invoke: () => Promise<ToolResult>;
}

const INV5_DRIVEN: readonly DrivenCase[] = [
  {
    tool: 'list_projects',
    method: 'get',
    path: '/projects',
    status: 200,
    invoke: handleListProjects,
  },
  {
    tool: 'list_libraries',
    method: 'get',
    path: '/libraries',
    status: 200,
    invoke: handleListLibraries,
  },
  {
    tool: 'list_templates',
    method: 'get',
    path: '/templates',
    status: 200,
    invoke: handleListTemplates,
  },
  {
    tool: 'list_conventions',
    method: 'get',
    path: '/conventions',
    status: 200,
    invoke: handleListConventions,
  },
  {
    tool: 'list_revision_nomenclature_profiles',
    method: 'get',
    path: '/revision-nomenclature-profiles',
    status: 200,
    invoke: handleListRevisionNomenclatureProfiles,
  },
  { tool: 'list_clients', method: 'get', path: '/clients', status: 200, invoke: handleListClients },
];

function parsePayload(res: ToolResult): unknown {
  if ('isError' in res) throw new Error(`tool errored: ${res.content[0]?.text ?? '(no text)'}`);
  return JSON.parse(res.content[0]!.text);
}

/** The read-mapped (GET) tool universe INV-5 must account for — driven, exempt, or pending. */
function readMappedTools(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [op, tool] of OP_TO_TOOL) if (op.startsWith('get ')) out.add(tool);
  return out;
}

describe('MCP contract (REST <-> MCP parity)', () => {
  // `pnpm seed` creates no projects or clients, so list_projects/list_clients would validate an
  // empty `[]` — trivially passing without ever exercising ProjectListItem/ClientSummary. Seed one
  // minimal row of each so INV-5 validates a NON-EMPTY payload with real teeth.
  const inv5Seeded: { projectId?: string; clientId?: string } = {};

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE tier IN ('company','client') LIMIT 1`
    );
    const libId = lib.rows[0]?.id;
    if (!libId) throw new Error('no company/client library seeded — run pnpm seed');
    const project = await createProject(
      { name: `inv5-contract-${Date.now()}`, sourceLibraryIds: [libId] },
      pool
    );
    inv5Seeded.projectId = project.projectId;
    const client = await createClient({ name: `inv5-contract-${Date.now()}` });
    inv5Seeded.clientId = client.id;
  });

  afterAll(async () => {
    if (inv5Seeded.projectId)
      await pool.query('DELETE FROM projects WHERE id = $1', [inv5Seeded.projectId]);
    if (inv5Seeded.clientId)
      await pool.query('DELETE FROM clients WHERE id = $1', [inv5Seeded.clientId]);
  });

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

  it.each(INV5_DRIVEN)(
    'INV-5: $tool output validates against its mapped op response schema',
    async ({ tool, method, path, status, invoke }) => {
      const payload = parsePayload(await invoke());
      // Guard against vacuous coverage: an empty [] validates trivially against an array schema
      // without exercising the item shape. Every driven read is seeded to return >=1 real row.
      expect(
        Array.isArray(payload) && payload.length > 0,
        `${tool} returned an empty payload — INV-5 would validate vacuously`
      ).toBe(true);
      await assertResponse(method, path, status, { success: true, data: payload });
    }
  );

  it('INV-5 completeness: every read-mapped tool is driven, shape-exempt, or pending', () => {
    const driven = new Set(INV5_DRIVEN.map((c) => c.tool));
    const uncovered = [...readMappedTools()]
      .filter((t) => !driven.has(t) && !INV5_SHAPE_EXEMPT.has(t) && !INV5_READ_PENDING.has(t))
      .sort((a, b) => a.localeCompare(b));
    expect(uncovered, 'read tools absent from INV-5 driven/exempt/pending buckets').toEqual([]);
  });

  it('INV-5: shape-exempt + read-pending reference real tools; exemptions carry a reason', () => {
    const declared = new Set(declaredToolNames());
    for (const [tool, reason] of INV5_SHAPE_EXEMPT) {
      expect(declared.has(tool), `${tool} not a registered tool`).toBe(true);
      expect(reason.trim().length, `${tool} exemption needs a reason`).toBeGreaterThan(0);
    }
    for (const tool of INV5_READ_PENDING)
      expect(declared.has(tool), `${tool} not a registered tool`).toBe(true);
  });

  it('INV-5: driven, shape-exempt, and read-pending buckets are disjoint', () => {
    const driven = new Set(INV5_DRIVEN.map((c) => c.tool));
    for (const t of driven) {
      expect(INV5_SHAPE_EXEMPT.has(t), `${t} both driven and shape-exempt`).toBe(false);
      expect(INV5_READ_PENDING.has(t), `${t} both driven and pending`).toBe(false);
    }
    for (const t of INV5_SHAPE_EXEMPT.keys())
      expect(INV5_READ_PENDING.has(t), `${t} both shape-exempt and pending`).toBe(false);
  });
});
