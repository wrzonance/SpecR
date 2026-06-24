import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getOpenCommentsReport } from './open-comments.js';
import { SpecNotFoundError } from './edit-gate.js';
import { ProjectNotFoundError } from './derive.js';
import type { SourceFacts } from '../../ast/index.js';

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

async function newSpec(section: string, title: string): Promise<string> {
  const src = `oc_${suffix}_${String(++specCounter).padStart(2, '0')}`;
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

async function addParagraph(
  specId: string,
  text: string,
  facts: SourceFacts | null
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, source_facts)
     VALUES ($1, $2, NULL, 'pr1', $3, $4, $5::jsonb)`,
    [id, specId, text, ++paraCounter, JSON.stringify(facts ?? {})]
  );
  return id;
}

async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}

const openComment = (author: string, text: string): SourceFacts => ({
  comments: [{ author, text, anchor: [0, 4], closed: false }],
});
const closedComment = (author: string, text: string): SourceFacts => ({
  comments: [{ author, text, anchor: [0, 4], closed: true }],
});
// A comment fact persisted before #262 — the `closed` key is genuinely absent
// (it did not exist yet). Typed without `closed` on purpose to model the stored
// JSONB, then written as raw JSON. The read path must backfill closure from the
// text suffix, so a legacy comment whose text ends in "Closed" reads as closed.
interface LegacyCommentFact {
  readonly author: string;
  readonly text: string;
  readonly anchor: readonly [number, number];
}
async function addLegacyParagraph(
  specId: string,
  text: string,
  comments: readonly LegacyCommentFact[]
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, source_facts)
     VALUES ($1, $2, NULL, 'pr1', $3, $4, $5::jsonb)`,
    [id, specId, text, ++paraCounter, JSON.stringify({ comments })]
  );
  return id;
}

afterAll(async () => {
  for (const id of projectIds) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const id of specIds) await pool.query('DELETE FROM specs WHERE id = $1', [id]);
});

describe('getOpenCommentsReport — spec scope (#262)', () => {
  it('lists exactly the open comment when one is closed and one is open', async () => {
    const specId = await newSpec('07 21 00', 'Thermal Insulation');
    await addParagraph(specId, 'Closed para.', closedComment('Jane', 'Resolved. Closed'));
    const openParaId = await addParagraph(specId, 'Open para.', openComment('Alex', 'Coordinate.'));

    const report = await getOpenCommentsReport({ kind: 'spec', specId });

    expect(report.summary).toEqual({ open: 1, total: 2 });
    expect(report.openComments).toEqual([
      {
        specId,
        specSection: '07 21 00',
        paragraphId: openParaId,
        author: 'Alex',
        text: 'Coordinate.',
        anchor: [0, 4],
      },
    ]);
  });

  it('returns an empty report (no open comments) when all are closed', async () => {
    const specId = await newSpec('09 91 00', 'Painting');
    await addParagraph(specId, 'Para.', closedComment('Jane', 'Done Closed'));

    const report = await getOpenCommentsReport({ kind: 'spec', specId });
    expect(report.openComments).toEqual([]);
    expect(report.summary).toEqual({ open: 0, total: 1 });
  });

  it('open-comments: legacy comment (no `closed` key) ending "Closed" is treated as closed, not open', async () => {
    // Reproduces the upgrade-path bug: a comment persisted before #262 has no
    // `closed` flag. Without read-time backfill it would be reported as open even
    // though its text already records the closure. (Strike-out closure on legacy
    // comments is unrecoverable — strike was never stored — and is not asserted.)
    const specId = await newSpec('09 90 00', 'Coatings');
    await addLegacyParagraph(specId, 'Legacy closed.', [
      { author: 'Owner', text: 'Use approved product. Closed', anchor: [0, 4] },
    ]);
    const openParaId = await addParagraph(specId, 'Open.', openComment('Alex', 'Verify.'));

    const report = await getOpenCommentsReport({ kind: 'spec', specId });

    expect(report.summary).toEqual({ open: 1, total: 2 });
    expect(report.openComments.map((c) => c.paragraphId)).toEqual([openParaId]);
  });

  it('ignores paragraphs with no comment facts', async () => {
    const specId = await newSpec('22 11 00', 'Plumbing');
    await addParagraph(specId, 'Plain para, no facts.', null);
    await addParagraph(specId, 'Open.', openComment('Pat', 'Verify.'));

    const report = await getOpenCommentsReport({ kind: 'spec', specId });
    expect(report.summary).toEqual({ open: 1, total: 1 });
  });

  it('throws SpecNotFoundError for an unknown spec', async () => {
    await expect(getOpenCommentsReport({ kind: 'spec', specId: randomUUID() })).rejects.toThrow(
      SpecNotFoundError
    );
  });
});

describe('getOpenCommentsReport — project scope (#262)', () => {
  it('aggregates open comments across the project specs, sorted by section', async () => {
    const projectId = await newProject('open-comments');
    const specA = await newSpec('26 05 00', 'Electrical Common');
    const specB = await newSpec('08 11 00', 'Doors');
    await addProjectSpec(projectId, specA, 1);
    await addProjectSpec(projectId, specB, 2);
    await addParagraph(specA, 'A open.', openComment('Jane', 'Confirm load.'));
    await addParagraph(specA, 'A closed.', closedComment('Jane', 'Done Closed'));
    await addParagraph(specB, 'B open.', openComment('Alex', 'Confirm finish.'));

    const report = await getOpenCommentsReport({ kind: 'project', projectId });

    expect(report.summary).toEqual({ open: 2, total: 3 });
    // ORDER BY s.section — 08 11 00 precedes 26 05 00.
    expect(report.openComments.map((c) => c.specSection)).toEqual(['08 11 00', '26 05 00']);
    expect(report.openComments.map((c) => c.text)).toEqual(['Confirm finish.', 'Confirm load.']);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(
      getOpenCommentsReport({ kind: 'project', projectId: randomUUID() })
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
