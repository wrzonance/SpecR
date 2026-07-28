import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  updateParagraphText,
  getSpecPendingSummary,
  getProjectPendingSummary,
  SpecNotFoundError,
  ProjectNotFoundError,
} from '../index.js';
import { createCheckpoint } from './checkpoints.js';

// ADR-052 D9 (issue #380 task 8) — pending-summary.ts against real Postgres:
// DISTINCT-paragraph counting (a paragraph edited by two different pending
// actors still counts once, attributed to whichever edit is latest), sealed
// vs never-sealed scoping, and the specs.project_id-only (never
// project_specs) project-scope enumeration.
//
// `paragraph_versions.content_version` is the POST-write generation
// (resolveHistoryContext resolves it as `preBumpContentVersion + 1`, matching
// what `specs.content_version` becomes once that same write's bump commits)
// — so a checkpoint taken immediately after a write captures a
// `content_version` numerically EQUAL to that write's own row, and
// `content_version > sealed` correctly excludes it while including every
// later write. Confirmed empirically against this DB before writing these
// fixtures, not assumed from the write-path source alone.
//
// Namespace reserved by this file: a dedicated library-scoped spec, a
// dedicated project pair, and their specs/users, labeled
// 'pending-summary-test-<suffix>', cleaned up in afterAll.

const suffix = randomUUID().slice(0, 8);
const label = (name: string): string => `pending-summary-test-${suffix}-${name}`;

let libraryId: string;
let specId: string;
let nodeAId: string;
let nodeBId: string;
let aliceId: string;
let bobId: string;

let neverSealedSpecId: string;
let neverSealedNodeAId: string;
let neverSealedNodeBId: string;

let projectOwnedId: string;
let projectForeignId: string;
let specOwnedId: string;
let specOwnedNodeId: string;
let specCuratedOnlyId: string;

async function insertLibrarySpec(section: string, title: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, 'arcat', $3) RETURNING id`,
    [section, title, libraryId]
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error('pending-summary fixture: failed to create spec');
  return id;
}

async function insertParagraph(
  ownerSpecId: string,
  text: string,
  position: number
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', $2, $3) RETURNING id`,
    [ownerSpecId, text, position]
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error('pending-summary fixture: failed to create paragraph');
  return id;
}

async function insertUser(name: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO users (label) VALUES ($1) RETURNING id`,
    [label(name)]
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error('pending-summary fixture: failed to create user');
  return id;
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
  );
  const lib0 = lib.rows[0];
  if (!lib0) throw new Error('pending-summary fixture: seed library missing');
  libraryId = lib0.id;

  specId = await insertLibrarySpec('99 99 96', label('spec'));
  nodeAId = await insertParagraph(specId, 'Paragraph A original.', 1);
  nodeBId = await insertParagraph(specId, 'Paragraph B original.', 2);
  aliceId = await insertUser('alice');
  bobId = await insertUser('bob');

  neverSealedSpecId = await insertLibrarySpec('99 99 97', label('never-sealed-spec'));
  neverSealedNodeAId = await insertParagraph(neverSealedSpecId, 'Never-sealed A.', 1);
  neverSealedNodeBId = await insertParagraph(neverSealedSpecId, 'Never-sealed B.', 2);

  const ownedProject = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [label('project-owned')]
  );
  projectOwnedId = ownedProject.rows[0]!.id;
  const foreignProject = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [label('project-foreign')]
  );
  projectForeignId = foreignProject.rows[0]!.id;

  const ownedSpec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ('99 99 98', $1, 'arcat', $2) RETURNING id`,
    [label('project-owned-spec'), projectOwnedId]
  );
  specOwnedId = ownedSpec.rows[0]!.id;
  specOwnedNodeId = await insertParagraph(specOwnedId, 'Owned spec paragraph.', 1);

  // Curated into projectForeign via project_specs ONLY (specs.project_id stays
  // NULL / library-scoped) — the exact "never project_specs" trap.
  specCuratedOnlyId = await insertLibrarySpec('99 99 99', label('curated-only-spec'));
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectForeignId,
    specCuratedOnlyId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM project_specs WHERE project_id = ANY($1::uuid[])`, [
    [projectOwnedId, projectForeignId],
  ]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [
    [specId, neverSealedSpecId, specOwnedId, specCuratedOnlyId],
  ]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [
    [projectOwnedId, projectForeignId],
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[aliceId, bobId]]);
});

describe('getSpecPendingSummary (#380 task 8, ADR-052 D9)', () => {
  it('throws SpecNotFoundError for an unknown spec', async () => {
    await expect(getSpecPendingSummary(randomUUID())).rejects.toBeInstanceOf(SpecNotFoundError);
  });

  it('reports every recorded paragraph as pending when the spec has never been checkpointed', async () => {
    await updateParagraphText(
      neverSealedSpecId,
      neverSealedNodeAId,
      'Edited A.',
      undefined,
      label('alice')
    );
    await updateParagraphText(
      neverSealedSpecId,
      neverSealedNodeBId,
      'Edited B.',
      undefined,
      label('alice')
    );

    const summary = await getSpecPendingSummary(neverSealedSpecId);

    expect(summary.sealedByCheckpointId).toBeNull();
    expect(summary.sealedContentVersion).toBeNull();
    expect(summary.changedParagraphCount).toBe(2);
  });

  it('counts DISTINCT pending paragraphs (never proportional to raw op count) and attributes each to its LATEST pending editor', async () => {
    // Seal nodeA's first edit into a checkpoint.
    await updateParagraphText(specId, nodeAId, 'Alice edit 1 (sealed).', undefined, label('alice'));
    const checkpoint = await createCheckpoint(
      { name: label('seal'), scope: 'spec', scopeId: specId, userId: aliceId },
      pool
    );

    // Pending window: TWO edits land on nodeA (alice, then bob) — this must
    // collapse to ONE pending paragraph attributed to bob (the later editor),
    // never two, and alice must not appear for a paragraph bob superseded.
    await updateParagraphText(
      specId,
      nodeAId,
      'Alice edit 2 (pending).',
      undefined,
      label('alice')
    );
    await updateParagraphText(
      specId,
      nodeAId,
      'Bob edit 3 (pending, latest).',
      undefined,
      label('bob')
    );
    // A second, distinct pending paragraph, also bob's.
    await updateParagraphText(specId, nodeBId, 'Bob edit on B (pending).', undefined, label('bob'));

    const summary = await getSpecPendingSummary(specId);

    expect(summary.sealedByCheckpointId).toBe(checkpoint.id);
    expect(summary.sealedContentVersion).toBe(checkpoint.contentVersionMap[specId]);
    expect(summary.changedParagraphCount).toBe(2); // nodeA + nodeB, not 3 raw ops
    expect(summary.actorRollup).toEqual([
      { userId: bobId, actorLabel: label('bob'), changedParagraphCount: 2 },
    ]);
  });
});

describe('getProjectPendingSummary (#380 task 8, ADR-052 D9)', () => {
  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(getProjectPendingSummary(randomUUID())).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
  });

  it('enumerates via specs.project_id only — a project_specs-only curated spec never counts', async () => {
    const summary = await getProjectPendingSummary(projectForeignId);

    expect(summary.changedSpecCount).toBe(0);
    expect(summary.changedParagraphCount).toBe(0);
    expect(summary.perSpec).toEqual([]);
  });

  it('aggregates a directly-owned spec, unaffected by any project_specs curation elsewhere, and echoes packageId', async () => {
    await updateParagraphText(
      specOwnedId,
      specOwnedNodeId,
      'Owned spec pending edit.',
      undefined,
      label('alice')
    );

    const summary = await getProjectPendingSummary(projectOwnedId, 'pkg-1');

    expect(summary.packageId).toBe('pkg-1');
    expect(summary.changedSpecCount).toBe(1);
    expect(summary.changedParagraphCount).toBe(1);
    expect(summary.perSpec.map((s) => s.specId)).toEqual([specOwnedId]);
    expect(summary.actorRollup).toEqual([
      { userId: aliceId, actorLabel: label('alice'), changedParagraphCount: 1 },
    ]);
  });
});
