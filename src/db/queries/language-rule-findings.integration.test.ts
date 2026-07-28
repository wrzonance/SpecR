import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import { upsertLanguageRuleProfile } from './language-rule-profiles.js';
import { getLanguageFindingsReport } from './language-rule-findings.js';

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

async function addProjectSpec(projectId: string, specId: string): Promise<void> {
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
}

async function addParagraph(
  specId: string,
  text: string,
  opts: { readonly vanish?: boolean; readonly nodeType?: string } = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO paragraphs (spec_id, node_type, text, position, vanish)
     VALUES ($1, $2, $3, 1, $4)`,
    [specId, opts.nodeType ?? 'pr1', text, opts.vanish ?? false]
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
});
