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
import { handleDeleteSpec } from './spec-lifecycle-handlers.js';
import { handleDeletePackage } from './package-handlers.js';
import { handleDeleteProject } from './project-handlers.js';
import { handleSubmittalRegister } from './submittal-register-handler.js';
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

// specs has no LIKE-filterable "name" column (only section/title/source), so — unlike
// projects/clients/libraries/users below — its fixture rows can't be swept by a generic
// FIXTURE_PREFIX%-name DELETE. Every spec id these seed helpers mint is tracked here and
// reclaimed explicitly in afterAll instead.
const trackedSpecIds: string[] = [];

/** delete_spec (withdrawSpec) only withdraws library masters (409s on a project copy), and
 * it's a SOFT tombstone — the row survives with `withdrawn_at` set, so it needs afterAll
 * teardown (tracked above), unlike delete_package's hard delete below. */
async function seedWithdrawableSpecId(): Promise<string> {
  const libraryId = await seedLibraryId();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('05 12 00', $1, $2, $3) RETURNING id`,
    [uniq('withdrawable-spec'), uniq('s'), libraryId]
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('withdrawable spec insert returned no id');
  trackedSpecIds.push(id);
  return id;
}

/** delete_package hard-deletes (`DELETE FROM design_packages`), so the row is gone the
 * moment the driven case invokes it — no tracking needed. Its throwaway parent project is
 * FIXTURE_PREFIX-named, swept by the generic projects DELETE in afterAll regardless. */
async function seedDeletablePackageId(): Promise<string> {
  const projectRes = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [uniq('package-project')]
  );
  const projectId = projectRes.rows[0]?.id;
  if (projectId === undefined) throw new Error('package project insert returned no id');
  const packageRes = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, uniq('package')]
  );
  const id = packageRes.rows[0]?.id;
  if (id === undefined) throw new Error('deletable package insert returned no id');
  return id;
}

/** delete_project soft-deletes (tombstones with deleted_at), but the row is still named
 * FIXTURE_PREFIX-* — the generic projects DELETE in afterAll reclaims it regardless of
 * deleted_at, so no separate tracking is needed here. */
async function seedDeletableProjectId(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [uniq('deletable-project')]
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('deletable project insert returned no id');
  return id;
}

/** submittal_register needs a project with at least one of its own specs assigned
 * (project_specs), mirroring submittal-register.integration.test.ts's project-only seed but
 * extended with a real spec so the driven case exercises the non-empty specIds path. The
 * project is name-swept in afterAll; the spec is tracked (see trackedSpecIds above). */
async function seedSubmittalRegisterFixture(): Promise<{
  readonly projectId: string;
  readonly specId: string;
}> {
  const projectRes = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [uniq('sr-project')]
  );
  const projectId = projectRes.rows[0]?.id;
  if (projectId === undefined) throw new Error('submittal-register project insert returned no id');

  const libraryId = await seedLibraryId();
  const specRes = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('23 05 00', $1, $2, $3) RETURNING id`,
    [uniq('sr-spec'), uniq('s'), libraryId]
  );
  const specId = specRes.rows[0]?.id;
  if (specId === undefined) throw new Error('submittal-register spec insert returned no id');
  trackedSpecIds.push(specId);

  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);

  return { projectId, specId };
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
  {
    op: 'post /projects/{}/submittal-register',
    tool: 'submittal_register',
    status: 200,
    invoke: async () => {
      const fixture = await seedSubmittalRegisterFixture();
      return handleSubmittalRegister({ projectId: fixture.projectId, specIds: [fixture.specId] });
    },
  },
  {
    op: 'delete /specs/{}',
    tool: 'delete_spec',
    status: 200,
    invoke: async () => handleDeleteSpec({ specId: await seedWithdrawableSpecId() }),
  },
  {
    // SCOPE NOTE: INV-6 validates the payload against the op's OpenAPI response schema, which is
    // not `additionalProperties: false` — so an UNDOCUMENTED EXTRA key passes. delete_package is
    // the one driven op where that matters today: REST returns `{ packageId }`
    // (api/packages.ts:deletePackageHandler) and openapi documents exactly that, while
    // handleDeletePackage returns `{ deleted: true, packageId }`. The `deleted` key is a real,
    // PRE-EXISTING REST<->MCP divergence this gate cannot see; driving the op still proves the
    // documented fields are present and correctly typed (a dropped `packageId` fails here), which
    // is what INV-6 claims — no more. Aligning the handler is a production change tracked in #640,
    // deliberately not folded into this test-only PR.
    op: 'delete /packages/{}',
    tool: 'delete_package',
    status: 200,
    invoke: async () => handleDeletePackage({ packageId: await seedDeletablePackageId() }),
  },
  {
    op: 'delete /projects/{}',
    tool: 'delete_project',
    status: 200,
    invoke: async () =>
      handleDeleteProject({
        projectId: await seedDeletableProjectId(),
        deletedBy: uniq('deleter'),
      }),
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
    // Projects first: cascades away project_specs, so the specs it referenced can then be
    // deleted (their project_specs.spec_id FK is RESTRICT, not CASCADE) without ordering games.
    await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]);
    if (trackedSpecIds.length > 0) {
      await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [trackedSpecIds]);
    }
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

  it('INV-6 fixture hygiene: every new seed helper is reclaimed by end of run', async () => {
    // delete_package hard-deletes its own row — assert that self-clean is real, immediately,
    // not just assumed.
    const packageId = await seedDeletablePackageId();
    await handleDeletePackage({ packageId });
    const packageRow = await pool.query('SELECT 1 FROM design_packages WHERE id = $1', [packageId]);
    expect(packageRow.rowCount).toBe(0);

    // delete_spec only tombstones (withdrawn_at) — the row survives, so it must be tracked
    // for explicit afterAll teardown rather than assumed self-cleaning.
    const specId = await seedWithdrawableSpecId();
    expect(trackedSpecIds).toContain(specId);

    // delete_project also only tombstones (deleted_at) — its row survives too, reclaimed by
    // the generic "projects WHERE name LIKE FIXTURE_PREFIX%" sweep in afterAll rather than
    // explicit tracking. Assert the naming invariant that sweep depends on.
    const deletableProjectId = await seedDeletableProjectId();
    const deletableProjectRow = await pool.query<{ name: string }>(
      'SELECT name FROM projects WHERE id = $1',
      [deletableProjectId]
    );
    expect(deletableProjectRow.rows[0]?.name.startsWith(FIXTURE_PREFIX)).toBe(true);

    // submittal_register's throwaway project is swept the same way; its spec is tracked.
    const fixture = await seedSubmittalRegisterFixture();
    const srProjectRow = await pool.query<{ name: string }>(
      'SELECT name FROM projects WHERE id = $1',
      [fixture.projectId]
    );
    expect(srProjectRow.rows[0]?.name.startsWith(FIXTURE_PREFIX)).toBe(true);
    expect(trackedSpecIds).toContain(fixture.specId);
  });
});
