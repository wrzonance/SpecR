import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../index.js';
import { config } from '../../lib/env.js';
import { getReadinessReport } from './readiness-report.js';
import { SpecNotFoundError } from './edit-gate.js';
import { PackageNotFoundError } from './packages.js';
import type { SourceFacts } from '../../ast/index.js';

// Query-layer coverage for ADR-079's dry-run readiness report: spec scope via
// getSpecTree, package scope via a read-only snapshotMemberTrees transaction.
// Pins the four invariants the barrel-extraction task owns: a vanish-hidden
// note still flags while a vanish-hidden ordinary paragraph doesn't (INV-6),
// the highlight advisory never gates readyForFinal (INV-8), the summary's
// per-kind counts and total stay in lockstep with findings.length (INV-9),
// and a failed package-scope lookup rolls back cleanly (INV-14).

const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];
let specCounter = 0;
let paraCounter = 0;

async function newProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${name}-${suffix}`]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newProject: no id');
  projectIds.push(id);
  return id;
}

async function newPackage(projectId: string, name: string, position: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, `${name}-${suffix}`, position]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newPackage: no id');
  return id;
}

async function newSpec(section: string, title: string): Promise<string> {
  const src = `rr_${suffix}_${String(++specCounter).padStart(2, '0')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, src]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}

async function addPackageSpec(packageId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, $3)`,
    [packageId, specId, position]
  );
}

interface ParaOptions {
  readonly nodeType?: string;
  readonly vanish?: boolean;
  readonly facts?: SourceFacts;
  readonly objectData?: Record<string, unknown>;
}

async function addParagraph(specId: string, text: string, opts: ParaOptions = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO paragraphs
       (id, spec_id, parent_id, node_type, text, position, vanish, source_facts, object_data)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      id,
      specId,
      opts.nodeType ?? 'pr1',
      text,
      ++paraCounter,
      opts.vanish ?? false,
      JSON.stringify(opts.facts ?? {}),
      opts.objectData ? JSON.stringify(opts.objectData) : null,
    ]
  );
  return id;
}

const textBoxObject = { kind: 'textBox', floating: false, generation: 'drawingml', blob: [{}] };

afterAll(async () => {
  // Order matters: package_specs.spec_id is ON DELETE RESTRICT, so the
  // owning project (cascading through design_packages/package_specs) must go
  // before the specs it references.
  for (const id of projectIds) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const id of specIds) await pool.query('DELETE FROM specs WHERE id = $1', [id]);
});

describe('getReadinessReport — spec scope (#406)', () => {
  it('throws SpecNotFoundError for an unknown spec', async () => {
    await expect(getReadinessReport({ kind: 'spec', specId: randomUUID() })).rejects.toThrow(
      SpecNotFoundError
    );
  });

  it('returns a clean, ready report for a spec with no readiness findings', async () => {
    const specId = await newSpec('07 21 00', 'Thermal Insulation — Clean');
    await addParagraph(specId, 'Provide batt insulation per manufacturer instructions.');

    const report = await getReadinessReport({ kind: 'spec', specId });

    expect(report.readyForFinal).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.highlightAdvisory).toEqual([]);
    expect(report.summary).toEqual({
      unresolvedChoiceToken: 0,
      specifierNotePresent: 0,
      openComment: 0,
      bodyObjectPresent: 0,
      total: 0,
    });
  });

  it('flags a vanish-hidden note but not a vanish-hidden ordinary paragraph — INV-6', async () => {
    const specId = await newSpec('09 91 26', 'Painting — Vanish Regression');
    const hiddenNoteId = await addParagraph(specId, 'Coordinate finish schedule with owner.', {
      nodeType: 'note',
      vanish: true,
    });
    await addParagraph(specId, 'Provide <manufacturer> primer.', {
      vanish: true,
      facts: { choiceTokens: [{ kind: 'angle', options: ['A', 'B'], span: [8, 22] }] },
    });

    const report = await getReadinessReport({ kind: 'spec', specId });

    expect(report.findings).toEqual([
      {
        type: 'specifier_note_present',
        nodeId: hiddenNoteId,
        text: 'Coordinate finish schedule with owner.',
        specId,
        specSection: '09 91 26',
      },
    ]);
    expect(report.readyForFinal).toBe(false);
  });

  it('carries the highlight advisory without it affecting readyForFinal — INV-8', async () => {
    const specId = await newSpec('09 96 00', 'High-Performance Coatings');
    const paraId = await addParagraph(specId, 'Select finish per schedule.', {
      facts: { highlights: [{ color: 'yellow', text: 'finish', span: [7, 13] }] },
    });

    const report = await getReadinessReport({ kind: 'spec', specId });

    expect(report.findings).toEqual([]);
    expect(report.readyForFinal).toBe(true);
    expect(report.highlightAdvisory).toEqual([
      {
        specId,
        specSection: '09 96 00',
        finding: {
          nodeId: paraId,
          nodeType: 'pr1',
          text: 'Select finish per schedule.',
          outlinePath: ['09 96 00', 'Select finish per schedule.'],
          highlights: [{ color: 'yellow', text: 'finish', span: [7, 13] }],
        },
      },
    ]);
  });

  it('summary counts every finding kind and total excludes the highlight advisory — INV-9', async () => {
    const specId = await newSpec('08 11 00', 'Metal Doors — Summary');
    await addParagraph(specId, 'Provide <manufacturer> door.', {
      facts: { choiceTokens: [{ kind: 'angle', options: ['A', 'B'], span: [8, 22] }] },
    });
    await addParagraph(specId, 'Note to specifier.', { nodeType: 'note' });
    await addParagraph(specId, 'Verify substrate.', {
      facts: { comments: [{ author: 'Jane', text: 'still open', anchor: [0, 5], closed: false }] },
    });
    await addParagraph(specId, '', { nodeType: 'object', objectData: textBoxObject });
    await addParagraph(specId, 'Select finish per schedule.', {
      facts: { highlights: [{ color: 'yellow', text: 'finish', span: [7, 13] }] },
    });

    const report = await getReadinessReport({ kind: 'spec', specId });

    expect(report.summary).toEqual({
      unresolvedChoiceToken: 1,
      specifierNotePresent: 1,
      openComment: 1,
      bodyObjectPresent: 1,
      total: 4,
    });
    expect(report.findings).toHaveLength(report.summary.total);
    expect(report.highlightAdvisory).toHaveLength(1);
  });
});

describe('getReadinessReport — package scope (#406)', () => {
  it('throws PackageNotFoundError for an unknown package', async () => {
    await expect(getReadinessReport({ kind: 'package', packageId: randomUUID() })).rejects.toThrow(
      PackageNotFoundError
    );
  });

  it('is ready for final when every member spec is clean', async () => {
    const projectId = await newProject('readiness-clean');
    const packageId = await newPackage(projectId, 'Clean Package', 1);
    const specA = await newSpec('26 05 00', 'Electrical Common — Clean');
    const specB = await newSpec('08 11 00', 'Metal Doors — Clean');
    await addPackageSpec(packageId, specA, 1);
    await addPackageSpec(packageId, specB, 2);
    await addParagraph(specA, 'Provide grounding per code.');
    await addParagraph(specB, 'Provide hollow-metal frames.');

    const report = await getReadinessReport({ kind: 'package', packageId });

    expect(report.readyForFinal).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('stamps every finding with the specId/specSection of the member that produced it', async () => {
    const projectId = await newProject('readiness-multi');
    const packageId = await newPackage(projectId, 'Multi Package', 1);
    const specA = await newSpec('26 05 01', 'Electrical Common — Multi');
    const specB = await newSpec('08 11 01', 'Metal Doors — Multi');
    await addPackageSpec(packageId, specA, 1);
    await addPackageSpec(packageId, specB, 2);
    const noteId = await addParagraph(specA, 'Coordinate with owner.', { nodeType: 'note' });
    const commentParaId = await addParagraph(specB, 'Verify substrate.', {
      facts: { comments: [{ author: 'Jane', text: 'still open', anchor: [0, 5], closed: false }] },
    });

    const report = await getReadinessReport({ kind: 'package', packageId });

    expect(report.readyForFinal).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        {
          type: 'specifier_note_present',
          nodeId: noteId,
          text: 'Coordinate with owner.',
          specId: specA,
          specSection: '26 05 01',
        },
        {
          type: 'open_comment',
          nodeId: commentParaId,
          text: 'Verify substrate.',
          author: 'Jane',
          specId: specB,
          specSection: '08 11 01',
        },
      ])
    );
    expect(report.summary.total).toBe(2);
  });

  it('reports a captured text box across the package instead of throwing (Codex review finding, #406)', async () => {
    // Regression for snapshotMemberTrees omitting object_data from its
    // paragraph SELECT: buildNodeTree's parseObjectMeta rejects the resulting
    // `undefined` for an `object`-typed row, which previously surfaced as an
    // unconditional throw out of getReadinessReport for ANY package
    // containing a captured table/text box — never a `body_object_present`
    // finding. The spec-scope path (getSpecTree) already selected object_data
    // and never had this gap; only the package-scope snapshot path did.
    const projectId = await newProject('readiness-object');
    const packageId = await newPackage(projectId, 'Object Package', 1);
    const specId = await newSpec('08 11 02', 'Metal Doors — Object');
    await addPackageSpec(packageId, specId, 1);
    // 'Text Box' matches what the DOCX parser actually stores for an object
    // node's text (body-object-attach.ts's toObjectNode) — snapshotMemberTrees
    // validates every member tree against SpecTreeSchema, which requires a
    // non-empty text, unlike getSpecTree's spec-scope path.
    const objectId = await addParagraph(specId, 'Text Box', {
      nodeType: 'object',
      objectData: textBoxObject,
    });

    const report = await getReadinessReport({ kind: 'package', packageId });

    expect(report.readyForFinal).toBe(false);
    expect(report.findings).toEqual([
      {
        type: 'body_object_present',
        nodeId: objectId,
        text: 'Text Box',
        objectKind: 'textBox',
        specId,
        specSection: '08 11 02',
      },
    ]);
  });
});

describe('getReadinessReport — package-scope transaction safety (INV-14)', () => {
  it('rolls back cleanly on PackageNotFoundError, leaving the connection reusable', async () => {
    const soloPool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
    try {
      await expect(
        getReadinessReport({ kind: 'package', packageId: randomUUID() }, soloPool)
      ).rejects.toThrow(PackageNotFoundError);

      const projectId = await newProject('readiness-rollback');
      const packageId = await newPackage(projectId, 'Rollback Package', 1);
      const specId = await newSpec('09 91 27', 'Painting — Rollback');
      await addPackageSpec(packageId, specId, 1);
      await addParagraph(specId, 'Provide finish coat.');

      // Reuses the SAME single connection that just failed: if the prior
      // REPEATABLE READ transaction wasn't rolled back, this call stays
      // pinned to a snapshot taken before the package/spec/paragraph above
      // existed, and would wrongly report the package missing or empty.
      const report = await getReadinessReport({ kind: 'package', packageId }, soloPool);
      expect(report.readyForFinal).toBe(true);
    } finally {
      await soloPool.end();
    }
  });
});

describe('getReadinessReport — spec-scope db injection (review finding, #406)', () => {
  it('routes spec-scope reads through the injected db, not the module-level pool', async () => {
    const specId = await newSpec('09 91 29', 'Painting — DB Injection');
    await addParagraph(specId, 'Provide finish coat.');

    // A dedicated pool distinct from the module-level `pool` singleton.
    // getReadinessReport's spec-scope path (readSpecMember -> getSpecTree)
    // must issue its queries through THIS pool when it's passed as the `db`
    // argument — not silently fall through to the module-level pool, which
    // would make this spy see zero calls despite the report resolving
    // successfully off the shared connection.
    const injectedPool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
    const querySpy = vi.spyOn(injectedPool, 'query');
    try {
      const report = await getReadinessReport({ kind: 'spec', specId }, injectedPool);
      expect(report.readyForFinal).toBe(true);
      expect(querySpy).toHaveBeenCalled();
    } finally {
      await injectedPool.end();
    }
  });
});
