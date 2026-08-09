import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getTextBoxesReport } from './text-boxes.js';
import { SpecNotFoundError } from './edit-gate.js';
import { ProjectNotFoundError } from './derive.js';
import type { ObjectMeta } from '../../ast/index.js';

const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];
let position = 0;

const textBoxMeta = (floating: boolean, generation: ObjectMeta['generation']): ObjectMeta => ({
  kind: 'textBox',
  floating,
  generation,
  blob: [{ 'w:drawing': [] }],
});

async function newSpec(section: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, `Text boxes ${section}`, `tb-${suffix}-${section}`]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}

async function newProject(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`text-boxes-${suffix}`]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('newProject: no id');
  projectIds.push(id);
  return id;
}

async function insertObject(
  specId: string,
  meta: ObjectMeta,
  text: readonly string[],
  positionOffset: number
): Promise<string> {
  const object = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position, object_data)
     VALUES ($1, 'object', '', $2, $3::jsonb) RETURNING id`,
    [specId, positionOffset, JSON.stringify(meta)]
  );
  const objectId = object.rows[0]?.id;
  if (objectId === undefined) throw new Error('insertObject: no object id');
  for (const [index, value] of text.entries()) {
    await pool.query(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, 'objectText', $3, $4)`,
      [specId, objectId, value, positionOffset + index + 1]
    );
  }
  return objectId;
}

afterAll(async () => {
  for (const id of projectIds) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const id of specIds) await pool.query('DELETE FROM specs WHERE id = $1', [id]);
});

describe('getTextBoxesReport — persisted body-object report (#409)', () => {
  it('returns text boxes with typed metadata and ordered interior text, excluding tables', async () => {
    const specId = await newSpec('09 91 00');
    const objectId = await insertObject(
      specId,
      textBoxMeta(true, 'drawingml'),
      ['Route me.', 'Second line.'],
      ++position
    );
    await insertObject(
      specId,
      { ...textBoxMeta(false, 'vml'), kind: 'table', rows: 1, columns: 1 },
      ['table content'],
      ++position
    );

    const report = await getTextBoxesReport({ kind: 'spec', specId });

    expect(report.summary).toEqual({ textBoxes: 1 });
    expect(report.textBoxes).toEqual([
      {
        specId,
        specSection: '09 91 00',
        paragraphId: objectId,
        floating: true,
        generation: 'drawingml',
        interiorText: ['Route me.', 'Second line.'],
      },
    ]);
  });

  it('aggregates project text boxes by section and excludes removed subtrees', async () => {
    const projectId = await newProject();
    const laterSpecId = await newSpec('26 05 00');
    const earlierSpecId = await newSpec('08 11 00');
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1), ($1, $3, 2)`,
      [projectId, laterSpecId, earlierSpecId]
    );
    await insertObject(laterSpecId, textBoxMeta(false, 'vml'), ['later'], ++position);
    const removedId = await insertObject(
      earlierSpecId,
      textBoxMeta(false, 'vml'),
      ['removed'],
      ++position
    );
    await pool.query(`UPDATE paragraphs SET vanish = true WHERE id = $1`, [removedId]);

    const report = await getTextBoxesReport({ kind: 'project', projectId });

    expect(report.textBoxes.map((box) => box.specSection)).toEqual(['26 05 00']);
  });

  it('throws scope-specific not-found errors', async () => {
    await expect(getTextBoxesReport({ kind: 'spec', specId: randomUUID() })).rejects.toThrow(
      SpecNotFoundError
    );
    await expect(getTextBoxesReport({ kind: 'project', projectId: randomUUID() })).rejects.toThrow(
      ProjectNotFoundError
    );
  });

  it('does not invent a callout distinction for persisted text boxes', async () => {
    // KNOWN AMBIGUITY: ADR-072 persists DrawingML/VML text-box classification,
    // but does not distinguish a callout shape from another text box. The
    // report exposes the persisted kind and never guesses a narrower subtype.
    const specId = await newSpec('10 14 00');
    await insertObject(specId, textBoxMeta(false, 'drawingml'), ['Callout content'], ++position);

    const report = await getTextBoxesReport({ kind: 'spec', specId });

    expect(report.textBoxes[0]?.generation).toBe('drawingml');
    expect(report.textBoxes[0]).not.toHaveProperty('callout');
  });
});
