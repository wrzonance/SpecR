import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import { upsertLanguageRuleProfile } from './language-rule-profiles.js';
import { getLanguageFindingsReport } from './language-rule-findings.js';
import { PackageNotFoundError } from './packages.js';

// #411 / ADR-080 — integration coverage for the findings scan engine (task
// 5/8), run against a real Postgres per CLAUDE.md. Pure-function coverage
// (matching engine, D6/D7/D8) lives in language-rule-findings.test.ts instead.

const suffix = randomUUID().slice(0, 8);
const libraryIds: string[] = [];
const projectIds: string[] = [];
const specIds: string[] = [];

async function makeLibrary(name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
    [`${name} (#411) ${suffix}`]
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('makeLibrary: no id');
  libraryIds.push(id);
  return id;
}

async function makeProject(name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${name} (#411) ${suffix}`]
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('makeProject: no id');
  projectIds.push(id);
  return id;
}

interface MakeSpecInput {
  readonly section: string;
  readonly libraryId?: string;
  readonly projectId?: string;
  readonly parentSpecId?: string;
}

async function makeSpec(input: MakeSpecInput): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, project_id, parent_spec_id)
     VALUES ($1, 'Findings Scan Fixture', 'docx', $2, $3, $4) RETURNING id`,
    [input.section, input.libraryId ?? null, input.projectId ?? null, input.parentSpecId ?? null]
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error(`makeSpec: no id for ${input.section}`);
  specIds.push(id);
  return id;
}

async function addProjectSpec(projectId: string, specId: string, position = 1): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}

// loadScannableParagraphs orders by p.position, so inserting every fixture
// paragraph at position 1 would leave intra-spec order up to Postgres. Number
// them in call order per spec instead — deterministic, and it keeps intra-spec
// ordering assertable.
const nextParagraphPosition = new Map<string, number>();

async function addParagraph(
  specId: string,
  text: string,
  opts: { readonly vanish?: boolean; readonly nodeType?: string } = {}
): Promise<void> {
  const position = (nextParagraphPosition.get(specId) ?? 0) + 1;
  nextParagraphPosition.set(specId, position);
  await pool.query(
    `INSERT INTO paragraphs (spec_id, node_type, text, position, vanish)
     VALUES ($1, $2, $3, $4, $5)`,
    [specId, opts.nodeType ?? 'pr1', text, position, opts.vanish ?? false]
  );
}

async function makePackage(projectId: string, name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `${name} (#411) ${suffix}`]
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('makePackage: no id');
  return id;
}

async function addPackageSpec(packageId: string, specId: string, position = 1): Promise<void> {
  await pool.query(
    `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, $3)`,
    [packageId, specId, position]
  );
}

afterAll(async () => {
  // project_specs.spec_id and specs.project_id are each RESTRICT (no cascade
  // either direction), so a project-copy spec that is also linked via
  // project_specs creates a two-table cycle: neither "specs first" nor
  // "projects first" alone is safe. Break it explicitly: drop the
  // project_specs rows first (frees specs.project_id's would-be blocker),
  // then specs (parent+copy together — Postgres defers RESTRICT's
  // same-statement self-reference check to end-of-statement, so a chain
  // deleted in one DELETE never sees its own removed rows as blockers,
  // mirrors language-rule-profiles.integration.test.ts), then projects, then
  // libraries (CASCADEs any remaining language_rule_profiles rows).
  if (specIds.length) {
    await pool.query(`DELETE FROM project_specs WHERE spec_id = ANY($1::uuid[])`, [specIds]);
    // package_specs.spec_id is RESTRICT too, and design_packages only CASCADEs
    // when its project goes — which happens AFTER specs below, so drop the
    // membership rows explicitly or the specs delete is blocked.
    await pool.query(`DELETE FROM package_specs WHERE spec_id = ANY($1::uuid[])`, [specIds]);
  }
  if (specIds.length) await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [specIds]);
  if (projectIds.length) {
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  }
  if (libraryIds.length) {
    await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [libraryIds]);
  }
});

describe('getLanguageFindingsReport (task 5/8)', () => {
  it('2-layer overlapping term — the narrowest (project) layer wins in a real scan', async () => {
    const libraryId = await makeLibrary('Findings Narrowest-Wins Library');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'shall', suggestion: 'authoring-suggestion' }] }
    );
    const masterId = await makeSpec({ section: '09 91 40', libraryId });
    const projectId = await makeProject('Findings Narrowest-Wins Project');
    await upsertLanguageRuleProfile(
      { scope: 'project', ownerId: projectId },
      { bannedTerms: [{ term: 'SHALL', suggestion: 'project-suggestion' }] }
    );
    const copyId = await makeSpec({
      section: '09 91 40',
      projectId,
      parentSpecId: masterId,
    });
    await addProjectSpec(projectId, copyId);
    await addParagraph(copyId, 'The Contractor shall comply with this Section.');

    const report = await getLanguageFindingsReport(projectId, undefined);

    expect(report.configured).toBe(true);
    expect(report.summary.bannedTerm).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({
        type: 'language_term_flagged',
        category: 'bannedTerm',
        term: 'SHALL',
        suggestion: 'project-suggestion',
        specId: copyId,
      }),
    ]);
  });

  it('findings: report order follows project_specs.position, not row-insertion order', async () => {
    const libraryId = await makeLibrary('Findings Ordering Library');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'shall' }] }
    );
    const masterId = await makeSpec({ section: '01 10 00', libraryId });
    const projectId = await makeProject('Findings Ordering Project');

    // Insert the two memberships in the OPPOSITE order to their positions, so
    // a query without ORDER BY has every chance to return insertion order.
    const secondId = await makeSpec({ section: '01 20 00', projectId, parentSpecId: masterId });
    await addProjectSpec(projectId, secondId, 2);
    await addParagraph(secondId, 'The Contractor shall submit the second section.');

    const firstId = await makeSpec({ section: '01 10 00', projectId, parentSpecId: masterId });
    await addProjectSpec(projectId, firstId, 1);
    await addParagraph(firstId, 'The Contractor shall submit the first section.');

    const report = await getLanguageFindingsReport(projectId, undefined);

    expect(report.summary.bannedTerm).toBe(2);
    expect(report.findings.map((f) => f.specId)).toEqual([firstId, secondId]);
  });

  it('vanish/note exclusion — a matching term in a vanished or note paragraph is never flagged', async () => {
    const libraryId = await makeLibrary('Findings Vanish-Note Library');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'shall' }] }
    );
    const specId = await makeSpec({ section: '09 91 41', libraryId });
    const projectId = await makeProject('Findings Vanish-Note Project');
    await addProjectSpec(projectId, specId);
    await addParagraph(specId, 'The Contractor shall comply with this Section.');
    await addParagraph(specId, 'The Contractor shall notify the Owner.', { vanish: true });
    await addParagraph(specId, 'Editor: verify shall usage before issuance.', {
      nodeType: 'note',
    });

    const report = await getLanguageFindingsReport(projectId, undefined);

    expect(report.summary.bannedTerm).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ specId });
  });

  it('missing-phrase detection — a requiredPhrase absent anywhere in the spec is flagged once, whole-spec', async () => {
    const libraryId = await makeLibrary('Findings Missing-Phrase Library');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { requiredPhrases: [{ term: 'furnish and install', suggestion: 'use standard phrasing' }] }
    );
    const specId = await makeSpec({ section: '09 91 42', libraryId });
    const projectId = await makeProject('Findings Missing-Phrase Project');
    await addProjectSpec(projectId, specId);
    await addParagraph(specId, 'Provide painting per manufacturer instructions.');
    await addParagraph(specId, 'Apply a second coat if required by the finish schedule.');

    const report = await getLanguageFindingsReport(projectId, undefined);

    expect(report.configured).toBe(true);
    expect(report.summary.phraseMissing).toBe(1);
    expect(report.findings).toEqual([
      {
        type: 'language_phrase_missing',
        phrase: 'furnish and install',
        suggestion: 'use standard phrasing',
        specId,
        section: '09 91 42',
      },
    ]);
  });

  it('configured: false with an explanatory note when nothing resolves anywhere in the project', async () => {
    const libraryId = await makeLibrary('Findings Unconfigured Library');
    const specId = await makeSpec({ section: '09 91 43', libraryId });
    const projectId = await makeProject('Findings Unconfigured Project');
    await addProjectSpec(projectId, specId);
    await addParagraph(specId, 'The Contractor shall comply with this Section.');

    const report = await getLanguageFindingsReport(projectId, undefined);

    expect(report).toMatchObject({
      projectId,
      packageId: null,
      configured: false,
      findings: [],
    });
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toMatch(/opt-in/);
  });

  it('package scope reads package_specs — only the package’s own specs are scanned', async () => {
    const libraryId = await makeLibrary('Findings Package Library');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'shall' }] }
    );
    const masterId = await makeSpec({ section: '26 05 00', libraryId });
    const projectId = await makeProject('Findings Package Project');

    const inPackageId = await makeSpec({ section: '26 05 00', projectId, parentSpecId: masterId });
    await addProjectSpec(projectId, inPackageId, 1);
    await addParagraph(inPackageId, 'The Contractor shall bond all raceways.');

    const outOfPackageId = await makeSpec({
      section: '26 05 19',
      projectId,
      parentSpecId: masterId,
    });
    await addProjectSpec(projectId, outOfPackageId, 2);
    await addParagraph(outOfPackageId, 'The Contractor shall label all conductors.');

    const packageId = await makePackage(projectId, 'Bid Set A');
    await addPackageSpec(packageId, inPackageId);

    // Same project, two scopes: the project-wide report sees both specs, so a
    // package-scoped report returning one proves it read package_specs rather
    // than falling back to the project's whole TOC.
    const projectReport = await getLanguageFindingsReport(projectId, undefined);
    expect(projectReport.summary.bannedTerm).toBe(2);

    const report = await getLanguageFindingsReport(projectId, packageId);

    expect(report.configured).toBe(true);
    expect(report.packageId).toBe(packageId);
    expect(report.summary.bannedTerm).toBe(1);
    expect(report.findings.map((f) => f.specId)).toEqual([inPackageId]);
  });

  it('a package owned by another project is PackageNotFoundError, not an empty report', async () => {
    const projectId = await makeProject('Findings Package Guard Project');
    const otherProjectId = await makeProject('Findings Package Guard Other');
    const foreignPackageId = await makePackage(otherProjectId, 'Foreign Bid Set');

    // assertScope matches on (id, project_id): a real package id that belongs
    // to a different project must be rejected, not silently scanned as if the
    // caller owned it.
    await expect(getLanguageFindingsReport(projectId, foreignPackageId)).rejects.toBeInstanceOf(
      PackageNotFoundError
    );
  });
});
