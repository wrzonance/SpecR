import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { createPackageRevision, getPackageRevision } from './revisions.js';
import { getSpecTree } from './specs.js';

/**
 * Query-layer coverage for #392/ADR-078: `snapshotMemberTrees` is the ONLY
 * writer of `SpecNodeMeta.originParagraphId`. Two invariants pinned here:
 *
 *  1. A frozen node's `meta.originParagraphId` mirrors the live paragraph's
 *     own `origin_paragraph_id` lineage column (migration 018) when set, and
 *     is OMITTED (never a null placeholder) when the paragraph carries none.
 *  2. The live `GET /specs/:id/tree` path (`getSpecTree`) never surfaces the
 *     field, even for the exact same paragraph — proving the embedding is
 *     scoped strictly to the freeze-time write path.
 */

const suffix = randomUUID().slice(0, 8);
let projectId: string;
let originParaId: string;
let targetSpecId: string;
let clonedParaId: string;
let pkgId: string;

beforeAll(async () => {
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`OriginId Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;

  const origin = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ('09 91 26', $1, 'unknown', $2) RETURNING id`,
    [`Origin Spec ${suffix}`, projectId]
  );
  const originSpecId = origin.rows[0]!.id;
  const originPara = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'part', 'GENERAL', 1) RETURNING id`,
    [originSpecId]
  );
  originParaId = originPara.rows[0]!.id;

  const target = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ('09 91 27', $1, 'unknown', $2) RETURNING id`,
    [`Target Spec ${suffix}`, projectId]
  );
  targetSpecId = target.rows[0]!.id;
  // Cloned from the origin paragraph (as a project-copy would set it) — the
  // node embedOriginIds must stamp.
  const clonedPara = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position, origin_paragraph_id)
     VALUES ($1, 'part', 'GENERAL', 1, $2) RETURNING id`,
    [targetSpecId, originParaId]
  );
  clonedParaId = clonedPara.rows[0]!.id;
  // Authored fresh in the target spec — no lineage, so the frozen node must
  // omit the field entirely rather than embed `null`.
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, 'article', '1.1 REFERENCES', 1)`,
    [targetSpecId, clonedParaId]
  );

  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1,$2,1) RETURNING id`,
    [projectId, `OriginId Pkg ${suffix}`]
  );
  pkgId = pkg.rows[0]!.id;
  await pool.query(`INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1,$2,1)`, [
    pkgId,
    targetSpecId,
  ]);
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

describe('snapshotMemberTrees — originParagraphId embedding (#392, ADR-078)', () => {
  it('embeds meta.originParagraphId from the live lineage column, omitted (not null) when absent', async () => {
    const rev = await createPackageRevision(pkgId, { label: `origin-embed ${suffix}` }, pool);
    const full = await getPackageRevision(rev.revisionId, pool);
    const frozen = full?.specs.find((s) => s.specId === targetSpecId);
    expect(frozen).toBeDefined();

    const part = frozen!.tree.parts[0];
    expect(part).toBeDefined();
    expect(part!.id).toBe(clonedParaId);
    expect(part!.meta.originParagraphId).toBe(originParaId);

    const article = part!.children[0];
    expect(article).toBeDefined();
    expect(article!.meta).not.toHaveProperty('originParagraphId');
  });

  it('snapshot: a member spec containing an object node freezes — object_data was missing from the SELECT', async () => {
    // Regression for the exact symptom: snapshotMemberTrees omitted
    // `object_data` from its paragraph SELECT, so buildNodeTree's
    // parseObjectMeta saw `undefined` for every `object`-typed row, failed
    // ObjectMetaSchema, and threw — a package holding any captured table or
    // text box (#300/ADR-072) could never be frozen at all.
    const objectPara = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, object_data)
       VALUES ($1, $2, 'object', '[TABLE]', 2, $3::jsonb) RETURNING id`,
      [
        targetSpecId,
        clonedParaId,
        JSON.stringify({
          kind: 'table',
          floating: false,
          generation: 'drawingml',
          rows: 1,
          columns: 2,
          blob: [
            {
              'w:tbl': [
                { 'w:tblPr': [] },
                { 'w:tblGrid': [{ 'w:gridCol': [{}] }, { 'w:gridCol': [{}] }] },
              ],
            },
          ],
        }),
      ]
    );
    const objectParaId = objectPara.rows[0]!.id;

    try {
      const rev = await createPackageRevision(pkgId, { label: `object-freeze ${suffix}` }, pool);
      const full = await getPackageRevision(rev.revisionId, pool);
      const frozen = full?.specs.find((s) => s.specId === targetSpecId);
      expect(frozen).toBeDefined();

      const objectNode = frozen!.tree.parts[0]?.children.find((c) => c.id === objectParaId);
      expect(objectNode).toBeDefined();
      expect(objectNode!.type).toBe('object');
      // The payload survives the freeze — not merely "did not throw".
      expect(objectNode!.meta.object).toMatchObject({ kind: 'table', generation: 'drawingml' });
    } finally {
      await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [objectParaId]);
    }
  });

  it('never surfaces originParagraphId on the live GET-tree path — freeze-time only', async () => {
    const live = await getSpecTree(targetSpecId);
    expect(live).not.toBeNull();
    const part = live!.tree.parts[0];
    expect(part).toBeDefined();
    expect(part!.id).toBe(clonedParaId);
    // The live path selects the same paragraph — its origin_paragraph_id
    // column is set — yet buildNodeTree/buildNodeMeta never read it.
    expect(part!.meta).not.toHaveProperty('originParagraphId');
  });
});
