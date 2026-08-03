// src/mcp/contract-write-response.integration.test.ts
// INV-6 (#549): response-shape validation for write-mapped (POST/PUT/PATCH/DELETE) tools. INV-5
// validates only the read-mapped (GET) tool universe, leaving every write tool with no response
// gate at all — a silently dropped or malformed field on a write response has nothing here to
// catch it. INV-6 closes that hole with the same driven/exempt/pending posture INV-5 uses: a
// driven case invokes a write tool against a fresh row and validates its BARE payload (wrapped as
// the REST envelope `{ success: true, data }`) against the mapped op's OpenAPI response schema —
// correct by construction for tools built on `ok(await dbFn())`, whose underlying db function is
// the exact one the REST route also calls.
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../db/index.js';
import {
  loadSpec,
  operationPathTemplates,
  successJsonOps,
  assertResponse,
} from '../test-utils/contract/validate-response.js';
import { OP_TO_TOOL } from './contract-map.js';
import {
  INV6_WRITE_EXEMPT,
  INV6_WRITE_PENDING,
  INV6_WRITE_PENDING_BASELINE,
} from './contract-write-response-map.js';
import { handleCreateProject } from './create-project-handler.js';
import { handleCreateClient } from './clients-handlers.js';
import { handleResolveUser } from './users-handlers.js';
import { handleCreateClientLibrary } from './library-management-handlers.js';
import type { ToolResult } from './tool-result.js';

const WRITE_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete']);
const FIXTURE_PREFIX = 'inv6-mcp-test-';

interface DrivenCase {
  readonly op: string;
  readonly tool: string;
  readonly status: number;
  readonly invoke: () => Promise<ToolResult>;
}

let seq = 0;
function uniq(part: string): string {
  seq += 1;
  return `${FIXTURE_PREFIX}${part}-${seq}`;
}

function parsePayload(res: ToolResult): unknown {
  if ('isError' in res) throw new Error(`tool errored: ${res.content[0]?.text ?? '(no text)'}`);
  return JSON.parse(res.content[0]!.text);
}

async function seedLibraryId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE tier IN ('company','client') LIMIT 1`
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no company/client library seeded — run pnpm seed');
  return id;
}

const INV6_DRIVEN: readonly DrivenCase[] = [
  {
    op: 'post /projects',
    tool: 'create_project',
    status: 201,
    invoke: async () =>
      handleCreateProject({ name: uniq('project'), sourceLibraryIds: [await seedLibraryId()] }),
  },
  {
    op: 'post /clients',
    tool: 'create_client',
    status: 201,
    invoke: () => handleCreateClient({ name: uniq('client') }),
  },
  {
    op: 'post /users',
    tool: 'resolve_user',
    status: 200,
    invoke: () => handleResolveUser({ label: uniq('user') }),
  },
  {
    op: 'post /libraries/clients',
    tool: 'create_client_library',
    status: 201,
    invoke: () => handleCreateClientLibrary({ name: uniq('lib') }),
  },
];

/** The write-mapped (POST/PUT/PATCH/DELETE) tool universe INV-6 must account for, restricted to
 * ops whose success response is real JSON — binary egress (`post /specs/{}/generate`) and other
 * non-JSON 2xx bodies have nothing for `assertResponse` to validate, so they are structurally out
 * of scope rather than needing an exemption entry (mirrors `assertResponse`'s own no-op for a
 * missing JSON schema). */
async function writeMappedJsonOps(): Promise<ReadonlySet<string>> {
  const doc = await loadSpec();
  const jsonOps = new Set(successJsonOps(doc));
  const out = new Set<string>();
  for (const op of OP_TO_TOOL.keys()) {
    const [method] = op.split(' ');
    if (method !== undefined && WRITE_METHODS.has(method) && jsonOps.has(op)) out.add(op);
  }
  return out;
}

describe('INV-6: response-shape validation for write-mapped tools', () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]);
    await pool.query(`DELETE FROM clients WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]);
    await pool.query(`DELETE FROM libraries WHERE name LIKE $1 AND tier = 'client'`, [
      `${FIXTURE_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM users WHERE label LIKE $1`, [`${FIXTURE_PREFIX}%`]);
  });

  it.each(INV6_DRIVEN)(
    'INV-6: $op -> $tool output validates against its mapped op response schema',
    async ({ op, tool, status, invoke }) => {
      const doc = await loadSpec();
      const literalPath = operationPathTemplates(doc).get(op);
      expect(
        literalPath,
        `${op} (${tool}) has no matching literal path in openapi.yaml`
      ).toBeDefined();
      const [method] = op.split(' ');
      const payload = parsePayload(await invoke());
      await assertResponse(method!, literalPath!, status, { success: true, data: payload });
    }
  );

  it('INV-6 completeness: every write-mapped JSON op is driven, exempt, or pending', async () => {
    const inScope = await writeMappedJsonOps();
    const driven = new Set(INV6_DRIVEN.map((c) => c.op));
    const uncovered = [...inScope]
      .filter((op) => !driven.has(op) && !INV6_WRITE_EXEMPT.has(op) && !INV6_WRITE_PENDING.has(op))
      .sort((a, b) => a.localeCompare(b));
    expect(
      uncovered,
      'write-mapped JSON ops absent from INV-6 driven/exempt/pending buckets'
    ).toEqual([]);
  });

  it('INV-6: exempt + pending reference real write-mapped JSON ops; exemptions carry a reason', async () => {
    const inScope = await writeMappedJsonOps();
    for (const [op, reason] of INV6_WRITE_EXEMPT) {
      expect(inScope.has(op), `${op} not a write-mapped JSON op`).toBe(true);
      expect(reason.trim().length, `${op} exemption needs a reason`).toBeGreaterThan(0);
    }
    for (const op of INV6_WRITE_PENDING) {
      expect(inScope.has(op), `${op} not a write-mapped JSON op`).toBe(true);
    }
  });

  it('INV-6: driven, exempt, and pending buckets are disjoint', () => {
    const driven = new Set(INV6_DRIVEN.map((c) => c.op));
    for (const op of driven) {
      expect(INV6_WRITE_EXEMPT.has(op), `${op} both driven and exempt`).toBe(false);
      expect(INV6_WRITE_PENDING.has(op), `${op} both driven and pending`).toBe(false);
    }
    for (const op of INV6_WRITE_EXEMPT.keys()) {
      expect(INV6_WRITE_PENDING.has(op), `${op} both exempt and pending`).toBe(false);
    }
  });

  it('INV-6 ratchet: write-pending burn-down never grows', () => {
    expect(INV6_WRITE_PENDING.size).toBeLessThanOrEqual(INV6_WRITE_PENDING_BASELINE);
  });
});
