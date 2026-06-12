import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getSpecLineage } from './lineage.js';

const ORIGIN_META = {
  filename: 'lineage-fixture.sec',
  sha256: 'a'.repeat(64),
  loader: 'test:lineage-fixture',
};

let companyLibId: string;
let clientLibId: string;
let projectId: string;
let rootSpecId: string;
let clientSpecId: string;
let projectSpecId: string;
let bareSpecId: string;

async function insertLibrary(tier: string, name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, name]
  );
  const row = res.rows[0];
  if (!row) throw new Error('library insert failed');
  return row.id;
}

beforeAll(async () => {
  companyLibId = await insertLibrary('company', 'Lineage Co Master (#97)');
  clientLibId = await insertLibrary('client', 'Lineage Client Master (#97)');
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('Lineage Project (#97)') RETURNING id`
  );
  const projRow = proj.rows[0];
  if (!projRow) throw new Error('project insert failed');
  projectId = projRow.id;

  // Root: ingested company master, drifted to content_version 5.
  const root = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ('27 21 97', 'Lineage Root', 'docx', $1, 5, $2::jsonb) RETURNING id`,
    [companyLibId, JSON.stringify(ORIGIN_META)]
  );
  rootSpecId = root.rows[0]?.id ?? '';

  // Client master copy cloned at parent content_version 3; parent is now at 5.
  const client = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, parent_spec_id,
                        origin_version, content_version, origin_meta)
     VALUES ('27 21 97', 'Lineage Client Copy', 'docx', $1, $2, 3, 2, $3::jsonb) RETURNING id`,
    [clientLibId, rootSpecId, JSON.stringify(ORIGIN_META)]
  );
  clientSpecId = client.rows[0]?.id ?? '';

  // Project copy cloned at client content_version 1; client is now at 2.
  const projSpec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id, parent_spec_id,
                        origin_version, content_version, origin_meta)
     VALUES ('27 21 97', 'Lineage Project Copy', 'docx', $1, $2, 1, 4, $3::jsonb) RETURNING id`,
    [projectId, clientSpecId, JSON.stringify(ORIGIN_META)]
  );
  projectSpecId = projSpec.rows[0]?.id ?? '';

  // Bare master: never ingested from a file, no lineage.
  const bare = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 22 97', 'Lineage Bare Master', 'docx', $1) RETURNING id`,
    [companyLibId]
  );
  bareSpecId = bare.rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [
    [projectSpecId, clientSpecId, rootSpecId, bareSpecId].filter(Boolean),
  ]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [
    [companyLibId, clientLibId],
  ]);
});

describe('getSpecLineage (integration)', () => {
  it('three-hop chain (company → client → project) reports scope, name, versions, behindBy', async () => {
    const lineage = await getSpecLineage(projectSpecId);
    expect(lineage).not.toBeNull();
    expect(lineage?.chain).toHaveLength(3);

    const [leaf, mid, root] = lineage?.chain ?? [];
    expect(leaf).toEqual({
      specId: projectSpecId,
      scope: 'project',
      name: 'Lineage Project (#97)',
      contentVersion: 4,
      originVersion: 1,
      behindBy: 1, // client copy is at 2, cloned at 1
    });
    expect(mid).toEqual({
      specId: clientSpecId,
      scope: 'library',
      name: 'Lineage Client Master (#97)',
      contentVersion: 2,
      originVersion: 3,
      behindBy: 2, // root is at 5, cloned at 3
    });
    expect(root).toEqual({
      specId: rootSpecId,
      scope: 'library',
      name: 'Lineage Co Master (#97)',
      contentVersion: 5,
      originVersion: null,
      behindBy: null,
    });
  });

  it('ingested-root spec returns origin_meta as the chain origin', async () => {
    const lineage = await getSpecLineage(rootSpecId);
    expect(lineage?.chain).toHaveLength(1);
    expect(lineage?.chain[0]?.behindBy).toBeNull();
    expect(lineage?.originMeta).toEqual(ORIGIN_META);
  });

  it('derived spec also surfaces the root origin_meta', async () => {
    const lineage = await getSpecLineage(projectSpecId);
    expect(lineage?.originMeta).toEqual(ORIGIN_META);
  });

  it('spec with no lineage and no ingest provenance returns single hop, null originMeta', async () => {
    const lineage = await getSpecLineage(bareSpecId);
    expect(lineage?.chain).toHaveLength(1);
    expect(lineage?.originMeta).toBeNull();
  });

  it('returns null for unknown spec id', async () => {
    const lineage = await getSpecLineage('00000000-0000-0000-0000-000000000000');
    expect(lineage).toBeNull();
  });
});
