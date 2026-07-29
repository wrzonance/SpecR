import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { createPackageRevision } from './revisions.js';
import { getFrozenComparisonSource } from './reporting.js';

/**
 * Query-layer coverage for `getFrozenComparisonSource` (#392, ADR-078): a
 * dedicated JOIN rather than a `getPackageRevision` reuse. Pins the null
 * contract precisely — null iff the revision doesn't exist OR exists but the
 * given specId was never one of its frozen members — plus the happy path
 * returning the frozen tree and the revision's raw label.
 */

const suffix = randomUUID().slice(0, 8);
let projectId: string;
let specId: string;
let pkgId: string;
let revisionId: string;
let revisionLabel: string;

beforeAll(async () => {
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`FrozenSource Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;

  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ('09 91 26', $1, 'unknown', $2) RETURNING id`,
    [`FrozenSource Spec ${suffix}`, projectId]
  );
  specId = spec.rows[0]!.id;
  await pool.query(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'part', 'GENERAL', 1)`,
    [specId]
  );

  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1,$2,1) RETURNING id`,
    [projectId, `FrozenSource Pkg ${suffix}`]
  );
  pkgId = pkg.rows[0]!.id;
  await pool.query(`INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1,$2,1)`, [
    pkgId,
    specId,
  ]);

  revisionLabel = `frozen-source ${suffix}`;
  const rev = await createPackageRevision(pkgId, { label: revisionLabel }, pool);
  revisionId = rev.revisionId;
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

describe('getFrozenComparisonSource', () => {
  it('returns the frozen tree and the revision label for a real member spec', async () => {
    const source = await getFrozenComparisonSource(revisionId, specId, pool);
    expect(source).not.toBeNull();
    expect(source!.revisionLabel).toBe(revisionLabel);
    expect(source!.tree.id).toBe(specId);
    expect(source!.tree.parts).toHaveLength(1);
  });

  it('returns null for a revision id that does not exist', async () => {
    const source = await getFrozenComparisonSource(randomUUID(), specId, pool);
    expect(source).toBeNull();
  });

  it('returns null for a real revision whose specId was never a frozen member', async () => {
    const source = await getFrozenComparisonSource(revisionId, randomUUID(), pool);
    expect(source).toBeNull();
  });
});
