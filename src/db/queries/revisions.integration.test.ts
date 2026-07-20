import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import {
  createPackageRevision,
  getPackageRevision,
  RevisionParentValidationError,
  RevisionComparisonError,
} from './revisions.js';
import { listPackageRevisions } from './revision-list.js';

/** Query-layer coverage for ADR-066 parent_revision_id: this file pins the
 *  createPackageRevision / getPackageRevision / listPackageRevisions
 *  boundary directly (no REST/MCP surface — those aren't wired to
 *  parentRevisionId yet). Two invariants: every RevisionSummary /
 *  RevisionWithTrees carries parentRevisionId as a key (never an absent
 *  field), and a package_revisions row's parentRevisionId is immutable once
 *  written — later, unrelated writes to the same package never perturb it. */

const suffix = randomUUID().slice(0, 8);
let projectId: string;
let pkgA: string;
let pkgB: string;

beforeAll(async () => {
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`RevParent Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1,$2,1) RETURNING id`,
    [projectId, `RevParent Pkg A ${suffix}`]
  );
  pkgA = a.rows[0]!.id;
  const b = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1,$2,2) RETURNING id`,
    [projectId, `RevParent Pkg B ${suffix}`]
  );
  pkgB = b.rows[0]!.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

describe('createPackageRevision — parentRevisionId', () => {
  it('RevisionSummary always carries parentRevisionId as a key — null when omitted', async () => {
    const rev = await createPackageRevision(pkgA, { label: `root ${suffix}` }, pool);
    expect(rev).toHaveProperty('parentRevisionId');
    expect(rev.parentRevisionId).toBeNull();
  });

  it('echoes a valid same-package root parent', async () => {
    const root = await createPackageRevision(pkgA, { label: `root2 ${suffix}` }, pool);
    const child = await createPackageRevision(
      pkgA,
      { label: `child ${suffix}`, parentRevisionId: root.revisionId },
      pool
    );
    expect(child.parentRevisionId).toBe(root.revisionId);
  });

  it('rejects a nonexistent parent', async () => {
    await expect(
      createPackageRevision(pkgA, { label: `x ${suffix}`, parentRevisionId: randomUUID() }, pool)
    ).rejects.toBeInstanceOf(RevisionParentValidationError);
  });

  it('rejects a parent belonging to a different package', async () => {
    const otherRoot = await createPackageRevision(pkgB, { label: `other-root ${suffix}` }, pool);
    await expect(
      createPackageRevision(
        pkgA,
        { label: `cross ${suffix}`, parentRevisionId: otherRoot.revisionId },
        pool
      )
    ).rejects.toBeInstanceOf(RevisionParentValidationError);
  });

  it('rejects nesting depth > 1 — a parent must itself be a root revision', async () => {
    const root = await createPackageRevision(pkgA, { label: `deep-root ${suffix}` }, pool);
    const child = await createPackageRevision(
      pkgA,
      { label: `deep-child ${suffix}`, parentRevisionId: root.revisionId },
      pool
    );
    await expect(
      createPackageRevision(
        pkgA,
        { label: `deep-grandchild ${suffix}`, parentRevisionId: child.revisionId },
        pool
      )
    ).rejects.toBeInstanceOf(RevisionParentValidationError);
  });
});

describe('createPackageRevision — baseRevisionId', () => {
  it('persists and echoes a same-package comparison base on every read surface', async () => {
    const base = await createPackageRevision(pkgA, { label: `base ${suffix}` }, pool);
    const target = await createPackageRevision(
      pkgA,
      { label: `target ${suffix}`, baseRevisionId: base.revisionId },
      pool
    );
    expect(target.baseRevisionId).toBe(base.revisionId);
    expect((await getPackageRevision(target.revisionId, pool))?.baseRevisionId).toBe(
      base.revisionId
    );
    const list = await listPackageRevisions(pkgA, pool);
    expect(list?.find((item) => item.revisionId === target.revisionId)?.baseRevisionId).toBe(
      base.revisionId
    );
  });

  it('always emits baseRevisionId: null when no comparison base was declared', async () => {
    const revision = await createPackageRevision(pkgA, { label: `no-base ${suffix}` }, pool);
    expect(revision).toHaveProperty('baseRevisionId');
    expect(revision.baseRevisionId).toBeNull();
  });

  it('rejects nonexistent and cross-package comparison bases', async () => {
    await expect(
      createPackageRevision(
        pkgA,
        { label: `missing-base ${suffix}`, baseRevisionId: randomUUID() },
        pool
      )
    ).rejects.toBeInstanceOf(RevisionComparisonError);
    const foreign = await createPackageRevision(pkgB, { label: `foreign-base ${suffix}` }, pool);
    await expect(
      createPackageRevision(
        pkgA,
        { label: `cross-base ${suffix}`, baseRevisionId: foreign.revisionId },
        pool
      )
    ).rejects.toBeInstanceOf(RevisionComparisonError);
  });
});

describe('parentRevisionId — read surfaces & immutability', () => {
  it('getPackageRevision echoes parentRevisionId', async () => {
    const root = await createPackageRevision(pkgA, { label: `read-root ${suffix}` }, pool);
    const child = await createPackageRevision(
      pkgA,
      { label: `read-child ${suffix}`, parentRevisionId: root.revisionId },
      pool
    );
    const fetched = await getPackageRevision(child.revisionId, pool);
    expect(fetched).toHaveProperty('parentRevisionId');
    expect(fetched?.parentRevisionId).toBe(root.revisionId);
  });

  it('listPackageRevisions echoes parentRevisionId for every summary', async () => {
    const root = await createPackageRevision(pkgA, { label: `list-root ${suffix}` }, pool);
    const child = await createPackageRevision(
      pkgA,
      { label: `list-child ${suffix}`, parentRevisionId: root.revisionId },
      pool
    );
    const list = await listPackageRevisions(pkgA, pool);
    const rootSummary = list?.find((r) => r.revisionId === root.revisionId);
    const childSummary = list?.find((r) => r.revisionId === child.revisionId);
    expect(rootSummary).toHaveProperty('parentRevisionId');
    expect(rootSummary?.parentRevisionId).toBeNull();
    expect(childSummary?.parentRevisionId).toBe(root.revisionId);
  });

  it('package_revisions rows are immutable post-creation: parentRevisionId is stable across reads and later writes to the same package', async () => {
    const root = await createPackageRevision(pkgA, { label: `immut-root ${suffix}` }, pool);
    const child = await createPackageRevision(
      pkgA,
      { label: `immut-child ${suffix}`, parentRevisionId: root.revisionId },
      pool
    );
    // A later, unrelated issuance on the SAME package must not perturb the
    // already-frozen child's parentRevisionId.
    await createPackageRevision(pkgA, { label: `immut-sibling ${suffix}` }, pool);
    const reread = await getPackageRevision(child.revisionId, pool);
    expect(reread?.parentRevisionId).toBe(root.revisionId);
  });
});
