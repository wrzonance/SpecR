import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, addSectionToProject, createPackage, setPackageSpecs } from '../db/index.js';
import {
  handleIssuePackageRevision,
  handleGetRevision,
  handleListPackageRevisions,
} from './package-revision-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';
const suffix = randomUUID().slice(0, 8);
const createdProjects: string[] = [];
const createdLibraries: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function insertLibrary(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [`w2c ${suffix} ${randomUUID().slice(0, 6)}`]
  );
  const id = r.rows[0]!.id;
  createdLibraries.push(id);
  return id;
}
async function insertMaster(libraryId: string, section: string): Promise<void> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, `w2c ${section}`, libraryId]
  );
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, NULL, 'part', 'GENERAL', 0)`,
    [r.rows[0]!.id]
  );
}

// A master with a `note` node — assessNode (readiness-review.ts) unconditionally yields a
// `specifier_note_present` finding for it, giving the ADR-079 gate tests below a real blocker.
async function insertMasterWithNote(libraryId: string, section: string): Promise<void> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, `w2c ${section}`, libraryId]
  );
  const specId = r.rows[0]!.id;
  const part = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, NULL, 'part', 'GENERAL', 0) RETURNING id`,
    [specId]
  );
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, 'note', 'Confirm topcoat sheen with owner.', 0)`,
    [specId, part.rows[0]!.id]
  );
}

// A project + a design package holding one member spec — returns the packageId.
async function packageWithMember(section: string): Promise<string> {
  const lib = await insertLibrary();
  await insertMaster(lib, section);
  const pr = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`w2c project ${randomUUID().slice(0, 8)}`]
  );
  const projectId = pr.rows[0]!.id;
  createdProjects.push(projectId);
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, lib]
  );
  const added = await addSectionToProject(projectId, section, pool);
  const pkg = await createPackage(projectId, `pkg ${randomUUID().slice(0, 6)}`, pool);
  await setPackageSpecs(pkg.packageId, [added.specId], pool);
  return pkg.packageId;
}

// A project + design package with two members: one carrying a blocking specifier note, one
// clean — the ADR-079 gate tests below need a mixed-membership package.
async function packageWithNoteAndCleanMembers(
  noteSection: string,
  cleanSection: string
): Promise<string> {
  const lib = await insertLibrary();
  await insertMasterWithNote(lib, noteSection);
  await insertMaster(lib, cleanSection);
  const pr = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`w2c project ${randomUUID().slice(0, 8)}`]
  );
  const projectId = pr.rows[0]!.id;
  createdProjects.push(projectId);
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, lib]
  );
  const addedNote = await addSectionToProject(projectId, noteSection, pool);
  const addedClean = await addSectionToProject(projectId, cleanSection, pool);
  const pkg = await createPackage(projectId, `pkg ${randomUUID().slice(0, 6)}`, pool);
  await setPackageSpecs(pkg.packageId, [addedNote.specId, addedClean.specId], pool);
  return pkg.packageId;
}

afterAll(async () => {
  // design_packages CASCADEs package_specs + package_revisions + revision snapshots.
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM spec_references WHERE source_spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1))',
    [createdProjects]
  );
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1))',
    [createdProjects]
  );
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM project_sources WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE library_id = ANY($1))',
    [createdLibraries]
  );
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1)', [createdLibraries]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1)', [createdLibraries]);
});

interface RevisionSummary {
  revisionId: string;
  type: string;
  specCount: number;
  parentRevisionId: string | null;
  baseRevisionId: string | null;
}
interface RevisionWithTrees {
  revisionId: string;
  specs: unknown[];
  parentRevisionId: string | null;
  baseRevisionId: string | null;
}

describe('package revision MCP tools', () => {
  it('issues a structured revision and reads back its frozen trees', async () => {
    const packageId = await packageWithMember('03 30 00');
    const issued = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    expect(isToolError(issued)).toBe(false);
    const summary = parse<RevisionSummary>(issued);
    expect(summary.type).toBe('addendum');
    expect(summary.specCount).toBe(1);

    const got = await handleGetRevision({ revisionId: summary.revisionId });
    expect(isToolError(got)).toBe(false);
    expect(parse<RevisionWithTrees>(got).specs.length).toBe(1);
  });

  it('rejects a duplicate revision (same package + label)', async () => {
    const packageId = await packageWithMember('07 21 16');
    const first = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
    });
    expect(isToolError(first)).toBe(false);
    const dup = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
    });
    expect(isToolError(dup)).toBe(true);
  });

  it('issue_package_revision rejects unknown package, unknown type, and bad input', async () => {
    // unknown package
    expect(
      isToolError(
        await handleIssuePackageRevision({
          packageId: MISSING,
          type: 'addendum',
          attributes: { number: 1 },
        })
      )
    ).toBe(true);
    // type not in the project's revision nomenclature
    const packageId = await packageWithMember('09 91 00');
    expect(
      isToolError(await handleIssuePackageRevision({ packageId, type: 'not-a-real-type' }))
    ).toBe(true);
    // missing required `type`
    expect(isToolError(await handleIssuePackageRevision({ packageId }))).toBe(true);
    // strict: an unknown/misspelled top-level field is rejected, not silently stripped
    // (parity with the REST route, whose union body is .strict())
    expect(
      isToolError(await handleIssuePackageRevision({ packageId, type: 'addendum', typ0: 'oops' }))
    ).toBe(true);
  });

  it('issue_package_revision rejects a malformed parentRevisionId (ADR-066 #389)', async () => {
    const packageId = await packageWithMember('08 71 00');
    const res = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
      parentRevisionId: 'not-a-uuid',
    });
    expect(isToolError(res)).toBe(true);
  });

  it('issue_package_revision persists a same-package baseRevisionId and rejects invalid bases', async () => {
    const packageId = await packageWithMember('08 73 00');
    const otherPackageId = await packageWithMember('08 74 00');
    const base = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    const baseId = parse<RevisionSummary>(base).revisionId;
    const target = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
      baseRevisionId: baseId,
    });
    expect(parse<RevisionSummary>(target).baseRevisionId).toBe(baseId);
    expect(
      isToolError(
        await handleIssuePackageRevision({
          packageId,
          type: 'addendum',
          attributes: { number: 3 },
          baseRevisionId: MISSING,
        })
      )
    ).toBe(true);
    const foreign = await handleIssuePackageRevision({
      packageId: otherPackageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    expect(
      isToolError(
        await handleIssuePackageRevision({
          packageId,
          type: 'addendum',
          attributes: { number: 4 },
          baseRevisionId: parse<RevisionSummary>(foreign).revisionId,
        })
      )
    ).toBe(true);
  });

  it('issue_package_revision accepts a well-formed parentRevisionId and echoes it back', async () => {
    const packageId = await packageWithMember('08 80 00');
    const root = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    expect(isToolError(root)).toBe(false);
    const rootId = parse<RevisionSummary>(root).revisionId;
    const child = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
      parentRevisionId: rootId,
    });
    expect(isToolError(child)).toBe(false);
    expect(parse<RevisionSummary>(child).parentRevisionId).toBe(rootId);
  });

  it('issue_package_revision rejects a nonexistent parentRevisionId with its message (ADR-066 #389)', async () => {
    const packageId = await packageWithMember('08 90 00');
    const res = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
      parentRevisionId: MISSING,
    });
    expect(isToolError(res)).toBe(true);
    expect(res.content[0]!.text).toContain('not found');
  });

  it('issue_package_revision rejects a parentRevisionId from a different package (ADR-066 #389)', async () => {
    const packageId = await packageWithMember('09 30 00');
    const otherPackageId = await packageWithMember('09 51 00');
    const foreign = await handleIssuePackageRevision({
      packageId: otherPackageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    expect(isToolError(foreign)).toBe(false);
    const foreignId = parse<RevisionSummary>(foreign).revisionId;
    const res = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
      parentRevisionId: foreignId,
    });
    expect(isToolError(res)).toBe(true);
    expect(res.content[0]!.text).toContain('different package');
  });

  it('issue_package_revision rejects a parentRevisionId that already has a parent (ADR-066 #389)', async () => {
    const packageId = await packageWithMember('09 65 00');
    const root = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    expect(isToolError(root)).toBe(false);
    const rootId = parse<RevisionSummary>(root).revisionId;
    const child = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
      parentRevisionId: rootId,
    });
    expect(isToolError(child)).toBe(false);
    const childId = parse<RevisionSummary>(child).revisionId;
    const grandchild = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 3 },
      parentRevisionId: childId,
    });
    expect(isToolError(grandchild)).toBe(true);
    expect(grandchild.content[0]!.text).toContain('nesting depth');
  });

  it('get_revision echoes parentRevisionId: null by default, present as a key (ADR-066 #389)', async () => {
    const packageId = await packageWithMember('06 10 00');
    const issued = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    const revisionId = parse<RevisionSummary>(issued).revisionId;
    const got = await handleGetRevision({ revisionId });
    const summary = parse<RevisionWithTrees>(got);
    expect(summary).toHaveProperty('parentRevisionId');
    expect(summary.parentRevisionId).toBeNull();
  });

  it('get_revision and list_package_revisions echo a non-null parentRevisionId (ADR-066 #389)', async () => {
    const packageId = await packageWithMember('06 20 00');
    const root = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    const rootId = parse<RevisionSummary>(root).revisionId;
    const child = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
      parentRevisionId: rootId,
    });
    const childId = parse<RevisionSummary>(child).revisionId;

    const got = await handleGetRevision({ revisionId: childId });
    expect(parse<RevisionWithTrees>(got).parentRevisionId).toBe(rootId);

    const list = parse<RevisionSummary[]>(await handleListPackageRevisions({ packageId }));
    const childSummary = list.find((r) => r.revisionId === childId);
    expect(childSummary).toHaveProperty('parentRevisionId');
    expect(childSummary?.parentRevisionId).toBe(rootId);
  });

  it('get_revision and list_package_revisions echo baseRevisionId', async () => {
    const packageId = await packageWithMember('06 25 00');
    const base = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
    });
    const baseId = parse<RevisionSummary>(base).revisionId;
    const target = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 2 },
      baseRevisionId: baseId,
    });
    const targetId = parse<RevisionSummary>(target).revisionId;
    expect(
      parse<RevisionWithTrees>(await handleGetRevision({ revisionId: targetId })).baseRevisionId
    ).toBe(baseId);
    const list = parse<RevisionSummary[]>(await handleListPackageRevisions({ packageId }));
    expect(list.find((revision) => revision.revisionId === targetId)?.baseRevisionId).toBe(baseId);
  });

  it('get_revision rejects a bad UUID and an unknown id', async () => {
    expect(isToolError(await handleGetRevision({ revisionId: 'nope' }))).toBe(true);
    expect(isToolError(await handleGetRevision({ revisionId: MISSING }))).toBe(true);
  });

  it('list_package_revisions returns issued summaries; empty array before any issuance', async () => {
    const packageId = await packageWithMember('05 50 00');
    const before = await handleListPackageRevisions({ packageId });
    expect(isToolError(before)).toBe(false);
    expect(parse<RevisionSummary[]>(before).length).toBe(0);

    await handleIssuePackageRevision({ packageId, type: 'addendum', attributes: { number: 1 } });
    const after = await handleListPackageRevisions({ packageId });
    expect(isToolError(after)).toBe(false);
    const list = parse<RevisionSummary[]>(after);
    expect(list.length).toBe(1);
    expect(list[0]!.type).toBe('addendum');
    expect(list[0]!.specCount).toBe(1);
    expect(list[0]).toHaveProperty('parentRevisionId');
    expect(list[0]!.parentRevisionId).toBeNull();
  });

  it('list_package_revisions rejects an unknown package and a bad UUID', async () => {
    expect(isToolError(await handleListPackageRevisions({ packageId: MISSING }))).toBe(true);
    expect(isToolError(await handleListPackageRevisions({ packageId: 'nope' }))).toBe(true);
  });
});

// ADR-079 (#406): issue_package_revision's `mode`/`overrideReadinessGate` fields need zero
// schema edits — IssuePackageRevisionShape already spreads StructuredCreateRevisionBodySchema's
// .shape — but the gate's actual block/override behavior, and how it interacts with
// baseRevisionId, was never exercised through this MCP boundary. isUnprocessableRevisionInputError
// already includes ReadinessBlockedError (revision-input-errors.ts), so this confirms that wiring
// end to end rather than driving new production code.
describe('package revision MCP tools — issuance-readiness gate (ADR-079, #406)', () => {
  it('mode: final blocks issuance, routed through its own branch — never the generic catch-all (INV-13)', async () => {
    const packageId = await packageWithNoteAndCleanMembers('12 01 00', '12 02 00');
    const result = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
      mode: 'final',
    });
    expect(isToolError(result)).toBe(true);
    // Proves isUnprocessableRevisionInputError's ReadinessBlockedError branch fired and
    // returned the error's own message (assertReadyForFinal's raw text, unlike the
    // API layer's enforceReadinessGate which appends a readiness-report pointer) —
    // not internalError's generic "Internal error — issue_package_revision failed".
    expect(result.content[0]!.text).toBe(
      'final issuance blocked: 1 readiness finding(s) outstanding'
    );
  });

  it('mode: final + overrideReadinessGate issues the revision despite the outstanding note', async () => {
    const packageId = await packageWithNoteAndCleanMembers('12 03 00', '12 04 00');
    const result = await handleIssuePackageRevision({
      packageId,
      type: 'addendum',
      attributes: { number: 1 },
      mode: 'final',
      overrideReadinessGate: true,
    });
    expect(isToolError(result)).toBe(false);
    expect(parse<RevisionSummary>(result).specCount).toBe(2);
  });

  it(
    "addendum-type issuance gates EVERY current member spec, not just a 'changed' one — " +
      "contrast with generate.ts's changed-only scope for POST /revisions/:id/generate " +
      '(ADR-079 decision 15) — INV-12',
    async () => {
      const packageId = await packageWithNoteAndCleanMembers('12 05 00', '12 06 00');
      // A clean base revision first — mode omitted, never gated (INV-1).
      const base = await handleIssuePackageRevision({
        packageId,
        type: 'addendum',
        attributes: { number: 1 },
      });
      expect(isToolError(base)).toBe(false);
      const baseRevisionId = parse<RevisionSummary>(base).revisionId;

      // createPackageRevision's snapshotMemberTrees has no "changed since base" concept —
      // it re-snapshots the package's FULL current membership on every issuance, unlike
      // generate.ts's addendumRevisionContextFor (which scopes the gate to changedSpecs
      // only). The note-carrying member — already present, unissued, in the base revision
      // above — still blocks this addendum.
      const addendum = await handleIssuePackageRevision({
        packageId,
        type: 'addendum',
        attributes: { number: 2 },
        baseRevisionId,
        mode: 'final',
      });
      expect(isToolError(addendum)).toBe(true);
      expect(addendum.content[0]!.text).toContain('1 readiness finding(s) outstanding');
    }
  );
});
