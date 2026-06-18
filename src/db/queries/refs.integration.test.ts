import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import {
  findProjectSpecIdsBySection,
  getInboundReferences,
  getOutboundReferences,
} from './refs.js';
import { listProjects } from './projects.js';

const suffix = randomUUID().slice(0, 8);
const source = `r162_${suffix}`;
const projectIds: string[] = [];
const specIds: string[] = [];

let projectA: string;
let projectB: string;
let sourceA1: string;
let sourceA2: string;
let sourceA1Alt: string;
let sourceB: string;
let targetA: string;

async function insertProject(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO projects (name) VALUES ($1) RETURNING id',
    [name]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('insertProject returned no id');
  projectIds.push(id);
  return id;
}

async function insertSpec(section: string, title: string, specSource: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, specSource]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`insertSpec returned no id for ${section}`);
  specIds.push(id);
  return id;
}

async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query('INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,$3)', [
    projectId,
    specId,
    position,
  ]);
}

async function insertRef(
  sourceSpecId: string,
  targetSection: string,
  referenceText: string,
  targetSpecId: string | null
): Promise<void> {
  const paragraph = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'pr1', $2, 1) RETURNING id`,
    [sourceSpecId, referenceText]
  );
  const paragraphId = paragraph.rows[0]?.id;
  if (paragraphId === undefined) throw new Error('insert paragraph returned no id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, reference_text, is_broken)
     VALUES ($1, $2, 'section', $3, $4, $5, $6)`,
    [sourceSpecId, paragraphId, targetSection, targetSpecId, referenceText, targetSpecId === null]
  );
}

beforeAll(async () => {
  projectA = await insertProject(`Ref Traversal A ${suffix}`);
  projectB = await insertProject(`Ref Traversal B ${suffix}`);
  targetA = await insertSpec('09 91 00', 'Painting', `${source}_t`);
  sourceA1 = await insertSpec('03 30 00', 'Concrete A', `${source}_a1`);
  sourceA2 = await insertSpec('04 20 00', 'Masonry A', `${source}_a2`);
  sourceA1Alt = await insertSpec('03 30 00', 'Concrete A Alt', `${source}_a3`);
  sourceB = await insertSpec('05 12 00', 'Steel B', `${source}_b1`);

  await addProjectSpec(projectA, sourceA1, 1);
  await addProjectSpec(projectA, sourceA2, 2);
  await addProjectSpec(projectA, sourceA1Alt, 3);
  await addProjectSpec(projectA, targetA, 4);
  await addProjectSpec(projectB, sourceB, 1);

  await insertRef(sourceA1, '09 91 00', 'A1 cites painting', targetA);
  await insertRef(sourceA2, '09 91 00', 'A2 cites painting', targetA);
  await insertRef(sourceA1Alt, '09 91 00', 'A1 alt cites painting', targetA);
  await insertRef(sourceB, '09 91 00', 'B cites painting', targetA);
  await insertRef(sourceA1, '08 88 88', 'A1 cites unloaded section', null);
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
});

describe('project-scoped reference traversal', () => {
  it('inbound returns only in-project specs citing a target section', async () => {
    const refs = await getInboundReferences('09 91 00', projectA, pool);
    expect(refs).toHaveLength(3);
    expect(refs.map((ref) => ref.sourceSpecId)).toEqual(
      expect.arrayContaining([sourceA1, sourceA1Alt, sourceA2])
    );
    expect(refs.every((ref) => ref.sourceSpecId !== sourceB)).toBe(true);
  });

  it('inbound returns refs even when the target section is not ingested', async () => {
    const refs = await getInboundReferences('08 88 88', projectA, pool);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sourceSpecId).toBe(sourceA1);
    expect(refs[0]?.isResolved).toBe(false);
    expect(refs[0]?.isBroken).toBe(true);
  });

  it('outbound returns a spec refs only when the spec is in the project', async () => {
    const refs = await getOutboundReferences(sourceA1, projectA, pool);
    expect(refs.map((ref) => ref.referenceText)).toEqual(
      expect.arrayContaining(['A1 cites painting', 'A1 cites unloaded section'])
    );
    await expect(getOutboundReferences(sourceA1, projectB, pool)).resolves.toEqual([]);
  });

  it('returns identical result sets on repeated calls', async () => {
    const first = await getInboundReferences('09 91 00', projectA, pool);
    const second = await getInboundReferences('09 91 00', projectA, pool);
    expect(second).toEqual(first);
  });

  it('returns empty arrays for a valid project + section with no edges', async () => {
    await expect(getInboundReferences('07 77 77', projectA, pool)).resolves.toEqual([]);
    await expect(getOutboundReferences(targetA, projectA, pool)).resolves.toEqual([]);
  });

  it('findProjectSpecIdsBySection keeps multi-source sections distinct', async () => {
    const ids = await findProjectSpecIdsBySection('03 30 00', projectA, pool);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(ids).toEqual(expect.arrayContaining([sourceA1, sourceA1Alt]));
  });

  it('listProjects returns id and name for projects', async () => {
    const projects = await listProjects(pool);
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: projectA, name: `Ref Traversal A ${suffix}` }),
        expect.objectContaining({ id: projectB, name: `Ref Traversal B ${suffix}` }),
      ])
    );
  });
});
