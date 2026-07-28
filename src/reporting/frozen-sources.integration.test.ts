import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  createPackageRevision,
  getComparisonParagraphs,
  getFrozenComparisonSource,
} from '../db/index.js';
import { buildComparisonReport } from './report.js';
import { flattenSpecTree } from './frozen-tree.js';
import { computeStructuralKeys } from './structure.js';
import { SpecNotFoundError } from './error.js';
import type { ComparisonReport } from './types.js';

/**
 * Acceptance suite for #392/ADR-078 — pins the GitHub issue's own "Acceptance"
 * bullets in one place, calling `buildComparisonReport` DIRECTLY (the shared
 * orchestrator `POST /reports/compare` and the `compare_specs` MCP tool both
 * delegate to) rather than over HTTP. This complements, not duplicates, the
 * per-task coverage already committed:
 *  - reporting.integration.test.ts pins the HTTP/schema-boundary behavior
 *    (status codes, request validation) for a same-package revision pair.
 *  - db/queries/reporting.integration.test.ts pins getFrozenComparisonSource's
 *    null contract at the query layer.
 * This file adds the two scenarios neither of those exercises — a genuinely
 * cross-lineage frozen pair (structural fallback) and a pre-#392-style
 * snapshot missing `meta.originParagraphId` (must degrade, not throw) — and
 * re-pins the shared invariants (origin alignment, column provenance,
 * determinism, 404 messages naming both ids) at this direct-call boundary.
 */

const suffix = randomUUID().slice(0, 8);

interface RevisionRef {
  readonly revisionId: string;
  readonly label: string;
}

// ── raw-SQL fixture helpers (tests must not depend on the code under test for setup) ──

async function insertProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  if (!r.rows[0]) throw new Error('insertProject failed');
  return r.rows[0].id;
}

async function insertProjectSpec(
  projectId: string,
  section: string,
  title: string
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, projectId]
  );
  if (!r.rows[0]) throw new Error('insertProjectSpec failed');
  return r.rows[0].id;
}

async function insertPara(
  specId: string,
  parentId: string | null,
  nodeType: string,
  text: string,
  position: number,
  originId: string | null = null
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, origin_paragraph_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [specId, parentId, nodeType, text, position, originId]
  );
  if (!r.rows[0]) throw new Error('insertPara failed');
  return r.rows[0].id;
}

async function insertPackage(projectId: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, name]
  );
  if (!r.rows[0]) throw new Error('insertPackage failed');
  return r.rows[0].id;
}

async function addPackageMember(packageId: string, specId: string): Promise<void> {
  await pool.query(`INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, 1)`, [
    packageId,
    specId,
  ]);
}

async function freezeRevision(packageId: string, label: string): Promise<RevisionRef> {
  const rev = await createPackageRevision(packageId, { label }, pool);
  return { revisionId: rev.revisionId, label: rev.label };
}

async function cleanupProject(projectId: string): Promise<void> {
  await pool.query('DELETE FROM design_packages WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
}

/** Deletes `meta.originParagraphId` from a frozen snapshot's sole root node,
 *  simulating a snapshot frozen by pre-#392 code (which never wrote the
 *  field, even for genuinely-cloned lineage) — ADR-078 D6: existing
 *  snapshots are not backfilled. */
async function stripOriginParagraphId(revisionId: string, specId: string): Promise<void> {
  await pool.query(
    `UPDATE package_revision_specs
     SET tree = jsonb_set(tree, '{parts,0,meta}', (tree #> '{parts,0,meta}') - 'originParagraphId')
     WHERE revision_id = $1 AND spec_id = $2`,
    [revisionId, specId]
  );
}

function cellText(row: ComparisonReport['rows'][number], index: number): string | undefined {
  const cell = row.cells[index];
  return cell?.present ? cell.text : undefined;
}

// ── same-package: origin align, column provenance, mixed pair, determinism ──

describe('frozen comparison sources — same-package acceptance (#392, ADR-078)', () => {
  let projectId: string;
  let specId: string;
  let revA: RevisionRef;
  let revB: RevisionRef;

  beforeAll(async () => {
    projectId = await insertProject(`SamePkg Proj ${suffix}`);
    specId = await insertProjectSpec(projectId, '23 05 00', `SamePkg Spec ${suffix}`);
    const part = await insertPara(specId, null, 'part', 'PART 1 GENERAL', 1);
    const article = await insertPara(specId, part, 'article', 'SUMMARY', 1);
    const clauseId = await insertPara(specId, article, 'pr1', 'Original frozen clause.', 1);

    const packageId = await insertPackage(projectId, `SamePkg Pkg ${suffix}`);
    await addPackageMember(packageId, specId);
    revA = await freezeRevision(packageId, `same-pkg-a-${suffix}`);

    // Edit the frozen clause and add a new one — revB's snapshot captures
    // both changes; revA's stays exactly as first issued.
    await pool.query(`UPDATE paragraphs SET text = 'EDITED frozen clause.' WHERE id = $1`, [
      clauseId,
    ]);
    await insertPara(specId, article, 'pr1', 'Added frozen clause.', 2);
    revB = await freezeRevision(packageId, `same-pkg-b-${suffix}`);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('aligns two same-package frozen revisions by the shared raw paragraph id (alignedBy: origin)', async () => {
    const report = await buildComparisonReport([
      { revisionId: revA.revisionId, specId },
      { revisionId: revB.revisionId, specId },
    ]);
    expect(report.alignedBy).toBe('origin');

    const edited = report.rows.find((r) => cellText(r, 0) === 'Original frozen clause.');
    expect(edited && cellText(edited, 1)).toBe('EDITED frozen clause.');

    const added = report.rows.find((r) => cellText(r, 1) === 'Added frozen clause.');
    expect(added?.cells[0]?.present).toBe(false);
  });

  it('every ComparisonColumn from a frozen source carries revisionId + revisionLabel; a live column carries neither', async () => {
    const report = await buildComparisonReport([specId, { revisionId: revA.revisionId, specId }]);
    const [liveCol, frozenCol] = report.columns;
    expect(liveCol?.revisionId).toBeUndefined();
    expect(liveCol?.revisionLabel).toBeUndefined();
    expect(frozenCol?.revisionId).toBe(revA.revisionId);
    expect(frozenCol?.revisionLabel).toBe(revA.label);
  });

  it('a live spec vs. its own earlier-frozen revision works (live-vs-frozen mixed pair) — the "since we issued" workflow', async () => {
    const report = await buildComparisonReport([specId, { revisionId: revA.revisionId, specId }]);
    // The live spec now carries revB's edits; revA predates them.
    const edited = report.rows.find((r) => cellText(r, 1) === 'Original frozen clause.');
    expect(edited && cellText(edited, 0)).toBe('EDITED frozen clause.');
    const addedSinceIssuance = report.rows.find((r) => cellText(r, 0) === 'Added frozen clause.');
    expect(addedSinceIssuance?.cells[1]?.present).toBe(false);
  });

  it('two identical requests return byte-identical reports (determinism regression)', async () => {
    const sources = [
      { revisionId: revA.revisionId, specId },
      { revisionId: revB.revisionId, specId },
    ];
    const first = await buildComparisonReport(sources);
    const second = await buildComparisonReport(sources);
    expect(second).toEqual(first);
  });

  it('include=differences narrows rows while summary stays full-matrix — parity with the live-source engine', async () => {
    const sources = [
      { revisionId: revA.revisionId, specId },
      { revisionId: revB.revisionId, specId },
    ];
    const full = await buildComparisonReport(sources);
    const diff = await buildComparisonReport(sources, { include: 'differences' });
    expect(diff.summary).toEqual(full.summary);
    expect(diff.rows.length).toBe(full.summary.differing);
    expect(diff.rows.length).toBeLessThan(full.rows.length);
  });

  it('rejects, naming both ids, when a frozen source’s revision does not exist', async () => {
    const badRevisionId = randomUUID();
    const sources = [specId, { revisionId: badRevisionId, specId }];
    await expect(buildComparisonReport(sources)).rejects.toBeInstanceOf(SpecNotFoundError);
    await expect(buildComparisonReport(sources)).rejects.toThrow(
      `revisionId=${badRevisionId}, specId=${specId}`
    );
  });

  it('rejects, naming both ids, when a frozen source’s specId was never a member of the revision', async () => {
    const badSpecId = randomUUID();
    const sources = [specId, { revisionId: revA.revisionId, specId: badSpecId }];
    await expect(buildComparisonReport(sources)).rejects.toBeInstanceOf(SpecNotFoundError);
    await expect(buildComparisonReport(sources)).rejects.toThrow(
      `revisionId=${revA.revisionId}, specId=${badSpecId}`
    );
  });

  // #392 review finding: the compare_specs MCP tool description documents
  // that an ambiguous baseline — one matching more than one source's
  // underlying specId, e.g. the same spec frozen at two different revisions —
  // "silently uses the first matching source in request order" rather than
  // rejecting (unlike the REST endpoint's CompareRequestSchema, which rejects
  // it at the 422 boundary). Prior coverage only regex-matched that
  // description string (report-tools.test.ts); nothing called
  // buildComparisonReport itself — what the MCP tool actually delegates to —
  // with a genuinely ambiguous baseline to confirm the runtime behavior
  // matches the documented claim. revA and revB both share `specId` here, so
  // `baseline: specId` matches both.
  it('an ambiguous baseline (matches both revA and revB, which share specId) silently resolves to the FIRST source in request order — the compare_specs MCP-tool behavior', async () => {
    const sources = [
      { revisionId: revA.revisionId, specId },
      { revisionId: revB.revisionId, specId },
    ];
    const report = await buildComparisonReport(sources, { baseline: specId });

    expect(report.baseline).toBeDefined();
    const matrixRow = report.rows.find((r) => cellText(r, 0) === 'Original frozen clause.');
    expect(matrixRow).toBeDefined();
    const lensRow = report.baseline?.rows.find((r) => r.originId === matrixRow?.originId);
    expect(lensRow?.states[0]).toBe('baseline'); // revA (first request-order match) is the baseline column
    expect(lensRow?.states[1]).not.toBe('baseline'); // revB (second match) is reframed relative to it, never re-chosen
  });
});

// ── cross-lineage: independently-authored specs of the same section ────────

describe('frozen comparison sources — cross-lineage acceptance (#392, ADR-078)', () => {
  let projectA: string;
  let projectB: string;
  let specA: string;
  let specB: string;
  let revA: RevisionRef;
  let revB: RevisionRef;
  const SECTION = '07 21 00';

  beforeAll(async () => {
    // Two DIFFERENT projects, not two specs in one project — `specs_section_
    // project_unique` forbids the same section twice under one project_id,
    // and a genuinely cross-lineage pair needs two independent lineages.
    projectA = await insertProject(`CrossLineage A ${suffix}`);
    projectB = await insertProject(`CrossLineage B ${suffix}`);
    specA = await insertProjectSpec(projectA, SECTION, `CrossLineage A ${suffix}`);
    specB = await insertProjectSpec(projectB, SECTION, `CrossLineage B ${suffix}`);

    const partA = await insertPara(specA, null, 'part', 'PART 1 GENERAL', 1);
    const artA = await insertPara(specA, partA, 'article', 'SUMMARY', 1);
    await insertPara(specA, artA, 'pr1', 'Section includes thermal insulation.', 1);
    await insertPara(specA, artA, 'pr1', 'Comply with referenced standards.', 2);

    const partB = await insertPara(specB, null, 'part', 'PART 1 GENERAL', 1);
    const artB = await insertPara(specB, partB, 'article', 'SUMMARY', 1);
    await insertPara(specB, artB, 'pr1', 'Section includes thermal insulation.', 1);
    await insertPara(specB, artB, 'pr1', 'Comply with referenced standards AS AMENDED.', 2);
    await insertPara(specB, artB, 'pr1', 'Submit product data.', 3);

    const pkgA = await insertPackage(projectA, `CrossLineage Pkg A ${suffix}`);
    await addPackageMember(pkgA, specA);
    revA = await freezeRevision(pkgA, `cross-a-${suffix}`);

    const pkgB = await insertPackage(projectB, `CrossLineage Pkg B ${suffix}`);
    await addPackageMember(pkgB, specB);
    revB = await freezeRevision(pkgB, `cross-b-${suffix}`);
  });

  afterAll(async () => {
    await cleanupProject(projectA);
    await cleanupProject(projectB);
  });

  it('falls back to structural alignment for independently-authored frozen specs of the same section', async () => {
    const report = await buildComparisonReport([
      { revisionId: revA.revisionId, specId: specA },
      { revisionId: revB.revisionId, specId: specB },
    ]);
    expect(report.alignedBy).toBe('structure');

    const part = report.rows.find((r) => cellText(r, 0) === 'PART 1 GENERAL');
    expect(part?.cells[1]?.present).toBe(true);

    const edited = report.rows.find((r) => cellText(r, 0) === 'Comply with referenced standards.');
    expect(edited && cellText(edited, 1)).toBe('Comply with referenced standards AS AMENDED.');

    const extra = report.rows.find((r) => cellText(r, 1) === 'Submit product data.');
    expect(extra?.cells[0]?.present).toBe(false);

    // Both columns are frozen — both must carry provenance.
    for (const column of report.columns) {
      expect(column.revisionId).toBeDefined();
      expect(column.revisionLabel).toBeDefined();
    }
  });
});

// ── pre-#392 snapshot: no meta.originParagraphId — graceful degrade ────────

describe('frozen comparison sources — pre-#392 snapshot degrade (#392, ADR-078 D6)', () => {
  let projectId: string;
  let targetSpecId: string;
  let revOld: RevisionRef;
  let revNew: RevisionRef;

  beforeAll(async () => {
    projectId = await insertProject(`Legacy Snapshot Proj ${suffix}`);
    const originSpecId = await insertProjectSpec(projectId, '09 21 00', `Legacy Origin ${suffix}`);
    const originParaId = await insertPara(originSpecId, null, 'part', 'GENERAL', 1);

    targetSpecId = await insertProjectSpec(projectId, '09 21 01', `Legacy Target ${suffix}`);
    // Cloned lineage (as a real project-copy would carry) — under today's
    // code this WOULD get meta.originParagraphId embedded at freeze time.
    const targetParaId = await insertPara(targetSpecId, null, 'part', 'GENERAL', 1, originParaId);

    const packageId = await insertPackage(projectId, `Legacy Pkg ${suffix}`);
    await addPackageMember(packageId, targetSpecId);
    revOld = await freezeRevision(packageId, `legacy-old-${suffix}`);
    // Strip on EVERY historical revision, not just this one — a real
    // pre-#392 package never wrote the field for any of its issuances, so a
    // single stripped revision (leaving a later one embedded) would produce
    // MISMATCHED origin keys (target-id vs. origin-spec-id) instead of the
    // shared-absence this scenario means to pin.
    await stripOriginParagraphId(revOld.revisionId, targetSpecId);

    await pool.query(`UPDATE paragraphs SET text = 'EDITED after freeze.' WHERE id = $1`, [
      targetParaId,
    ]);
    revNew = await freezeRevision(packageId, `legacy-new-${suffix}`);
    await stripOriginParagraphId(revNew.revisionId, targetSpecId);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('both simulated legacy snapshots genuinely lack meta.originParagraphId', async () => {
    const { rows } = await pool.query<{ meta: Record<string, unknown> | null }>(
      `SELECT tree #> '{parts,0,meta}' AS meta FROM package_revision_specs
       WHERE revision_id = ANY($1::uuid[]) AND spec_id = $2`,
      [[revOld.revisionId, revNew.revisionId], targetSpecId]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.meta).not.toHaveProperty('originParagraphId');
    }
  });

  it('still validates and aligns by raw paragraph id when an older snapshot lacks meta.originParagraphId', async () => {
    const report = await buildComparisonReport([
      { revisionId: revOld.revisionId, specId: targetSpecId },
      { revisionId: revNew.revisionId, specId: targetSpecId },
    ]);
    expect(report.alignedBy).toBe('origin');
    const row = report.rows.find((r) => cellText(r, 0) === 'GENERAL');
    expect(row && cellText(row, 1)).toBe('EDITED after freeze.');
  });
});

// ── MIXED legacy + new-format snapshots of the SAME spec (#392 review finding) ─
//
// The suite above deliberately strips meta.originParagraphId from BOTH
// revisions, explicitly to avoid this exact scenario (see its comment). This
// suite exercises what actually happens the day #392 ships: every revision
// frozen BEFORE deploy permanently lacks the field (no backfill, ADR-078 D6
// non-goal), while every revision frozen AFTER deploy carries it. A target
// spec with even one locally-authored paragraph (the common case — that's
// what editing a project copy IS) triggers `sharesCrossSourceOrigin` to
// resolve `auto` to 'origin' via that local paragraph's own-id match, and
// origin-keying a lineage-carrying paragraph then mismatches: the legacy side
// keys on its own id (field absent), the new side keys on its master's id
// (field present) — silently showing an unedited cloned paragraph as
// removed-then-added instead of unchanged.
describe('frozen comparison sources — MIXED legacy/new-format same-spec pair (#392 review finding)', () => {
  let projectId: string;
  let targetSpecId: string;
  let revLegacy: RevisionRef;
  let revCurrent: RevisionRef;
  let clonedParaId: string;
  let localParaId: string;

  beforeAll(async () => {
    projectId = await insertProject(`MixedFormat Proj ${suffix}`);
    const originSpecId = await insertProjectSpec(
      projectId,
      '09 22 00',
      `MixedFormat Origin ${suffix}`
    );
    const originParaId = await insertPara(originSpecId, null, 'part', 'GENERAL', 1);

    targetSpecId = await insertProjectSpec(projectId, '09 22 01', `MixedFormat Target ${suffix}`);
    // A cloned (lineage-carrying) paragraph AND a locally-authored one —
    // exactly what a real edited project-copy spec looks like.
    clonedParaId = await insertPara(targetSpecId, null, 'part', 'GENERAL', 1, originParaId);
    localParaId = await insertPara(targetSpecId, null, 'part', 'Project-specific clause.', 2);

    const packageId = await insertPackage(projectId, `MixedFormat Pkg ${suffix}`);
    await addPackageMember(packageId, targetSpecId);

    // revLegacy simulates a revision frozen BEFORE #392 shipped — strip the
    // field, permanently and irrecoverably (no backfill).
    revLegacy = await freezeRevision(packageId, `mixed-legacy-${suffix}`);
    await stripOriginParagraphId(revLegacy.revisionId, targetSpecId);

    // revCurrent is a fresh freeze AFTER #392 ships — left untouched, so the
    // cloned paragraph's meta.originParagraphId is embedded normally. Neither
    // paragraph's text changed between freezes.
    revCurrent = await freezeRevision(packageId, `mixed-current-${suffix}`);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('revLegacy lacks meta.originParagraphId; revCurrent carries it — the genuine mixed pair', async () => {
    const { rows } = await pool.query<{ revisionId: string; meta: Record<string, unknown> | null }>(
      `SELECT revision_id AS "revisionId", tree #> '{parts,0,meta}' AS meta
       FROM package_revision_specs
       WHERE revision_id = ANY($1::uuid[]) AND spec_id = $2`,
      [[revLegacy.revisionId, revCurrent.revisionId], targetSpecId]
    );
    const legacyMeta = rows.find((r) => r.revisionId === revLegacy.revisionId)?.meta;
    const currentMeta = rows.find((r) => r.revisionId === revCurrent.revisionId)?.meta;
    expect(legacyMeta).not.toHaveProperty('originParagraphId');
    expect(currentMeta).toHaveProperty('originParagraphId');
  });

  it('an unedited cloned paragraph aligns as unchanged across a legacy/current pair, not removed-then-added', async () => {
    const report = await buildComparisonReport([
      { revisionId: revLegacy.revisionId, specId: targetSpecId },
      { revisionId: revCurrent.revisionId, specId: targetSpecId },
    ]);
    expect(report.alignedBy).toBe('origin');

    // Exactly 2 rows (cloned + local paragraph), not 3 — a 3rd row would mean
    // the cloned paragraph split into a false removed/added pair.
    expect(report.rows).toHaveLength(2);

    const clonedRow = report.rows.find((r) => cellText(r, 0) === 'GENERAL');
    expect(clonedRow).toBeDefined();
    expect(clonedRow?.cells[0]).toMatchObject({ present: true, paragraphUuid: clonedParaId });
    expect(clonedRow?.cells[1]).toMatchObject({ present: true, paragraphUuid: clonedParaId });

    const localRow = report.rows.find((r) => cellText(r, 0) === 'Project-specific clause.');
    expect(localRow).toBeDefined();
    expect(localRow?.cells[1]).toMatchObject({
      present: true,
      paragraphUuid: localParaId,
      text: 'Project-specific clause.',
    });

    // Grounded: summary reports the pair as fully identical, not differing.
    expect(report.summary.differing).toBe(0);
  });
});

// ── flattenSpecTree <-> live-loader parity, against the REAL loaders ───────

// #392 review finding: frozen-tree.test.ts's "flattenSpecTree <-> synthetic
// live-loader-shaped rows" suite pins that computeStructuralKeys agrees
// between the two flatten paths using a hand-authored stand-in for
// `getComparisonParagraphs` — never the real query. That only proves
// computeStructuralKeys is invariant to differing `position` conventions
// (already true of the pure aligner); it does not prove flattenSpecTree's
// DFS sibling order and buildNodeTree's
// (shared by GET /specs/:id/tree AND the freeze path)/getComparisonParagraphs'
// sibling order actually agree for a real, unedited spec. This suite freezes
// a real spec and calls the two REAL loaders — getComparisonParagraphs
// (src/db/queries/reporting.ts) for the live side, getFrozenComparisonSource
// + flattenSpecTree for the frozen side — against the SAME spec, so a future
// divergence in buildNodeTree's or getComparisonParagraphs' sibling tie-break
// would actually fail a test instead of leaving this invariant unpinned.
describe('flattenSpecTree <-> live-loader parity — real loaders, same spec (#392 review)', () => {
  let projectId: string;
  let specId: string;
  let rev: RevisionRef;

  beforeAll(async () => {
    projectId = await insertProject(`StructParity Proj ${suffix}`);
    specId = await insertProjectSpec(projectId, '11 11 11', `StructParity Spec ${suffix}`);
    const part1 = await insertPara(specId, null, 'part', 'PART 1 GENERAL', 1);
    const artA = await insertPara(specId, part1, 'article', 'SUMMARY', 1);
    await insertPara(specId, artA, 'pr1', 'Clause A1.', 1);
    await insertPara(specId, artA, 'pr1', 'Clause A2.', 2);
    await insertPara(specId, part1, 'article', 'REFERENCES', 2);
    const part2 = await insertPara(specId, null, 'part', 'PART 2 PRODUCTS', 2);
    await insertPara(specId, part2, 'article', 'MATERIALS', 1);

    const packageId = await insertPackage(projectId, `StructParity Pkg ${suffix}`);
    await addPackageMember(packageId, specId);
    rev = await freezeRevision(packageId, `struct-parity-${suffix}`);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('computeStructuralKeys produces the SAME node-id -> structural-address map from getComparisonParagraphs (live) and flattenSpecTree (frozen) for the SAME unedited spec', async () => {
    const liveRows = await getComparisonParagraphs([specId]);
    const frozen = await getFrozenComparisonSource(rev.revisionId, specId);
    if (frozen === null) throw new Error('expected a frozen comparison source to exist');
    const frozenRows = flattenSpecTree(frozen.tree, specId);

    const liveKeys = computeStructuralKeys(liveRows);
    const frozenKeys = computeStructuralKeys(frozenRows);

    expect(frozenKeys.size).toBe(liveKeys.size);
    for (const [id, liveAddress] of liveKeys) {
      expect(frozenKeys.get(id)).toBe(liveAddress);
    }
  });

  it('forcing alignment: "structure" on a live spec vs. its own unedited freeze fully aligns every row (production-path parity)', async () => {
    const report = await buildComparisonReport([specId, { revisionId: rev.revisionId, specId }], {
      alignment: 'structure',
    });
    expect(report.alignedBy).toBe('structure');
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.summary.differing).toBe(0);
    for (const row of report.rows) {
      expect(row.cells[0]?.present).toBe(true);
      expect(row.cells[1]?.present).toBe(true);
      expect(cellText(row, 0)).toBe(cellText(row, 1));
    }
  });
});
