import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  createAssociation,
  listAssociationsForParagraph,
  listAssociationsForSpec,
  deleteAssociation,
  AssociationParagraphNotFoundError,
} from './associations.js';
import { getSpecTree } from './specs.js';
import { getParagraphWithAncestors } from './paragraphs.js';

let specId: string;
let paragraphId: string;

async function seedSpecWithParagraph(): Promise<{ specId: string; paragraphId: string }> {
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('09 91 00', 'Painting', 'unknown', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`
  );
  const sId = spec.rows[0]!.id;
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'paragraph', 'Provide products as scheduled.', 1) RETURNING id`,
    [sId]
  );
  return { specId: sId, paragraphId: para.rows[0]!.id };
}

beforeAll(async () => {
  const seeded = await seedSpecWithParagraph();
  specId = seeded.specId;
  paragraphId = seeded.paragraphId;
});
afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
});
afterEach(async () => {
  await pool.query(`DELETE FROM paragraph_associations WHERE paragraph_id = $1`, [paragraphId]);
});

describe('paragraph_associations query layer', () => {
  it('creates and reads back a DMS-connector association', async () => {
    const created = await createAssociation(paragraphId, {
      label: 'Acme 4500 datasheet',
      externalProvider: 'projectwise',
      externalId: 'doc-123',
      externalMetadata: { revision: 'C' },
    });
    expect(created.label).toBe('Acme 4500 datasheet');
    expect(created.externalProvider).toBe('projectwise');
    expect(created.externalId).toBe('doc-123');
    expect(created.url).toBeUndefined();
    expect(created.externalMetadata).toEqual({ revision: 'C' });

    const list = await listAssociationsForParagraph(paragraphId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);
  });

  it('creates a url-only association', async () => {
    const created = await createAssociation(paragraphId, {
      label: 'Public cut sheet',
      url: 'https://example.com/sheet.pdf',
      contentHash: 'a'.repeat(64),
    });
    expect(created.url).toBe('https://example.com/sheet.pdf');
    expect(created.contentHash).toBe('a'.repeat(64));
    expect(created.externalProvider).toBeUndefined();
  });

  it('groups associations by paragraph for a spec', async () => {
    await createAssociation(paragraphId, { label: 'one', url: 'https://e.com/1.pdf' });
    const map = await listAssociationsForSpec(specId);
    expect(map.get(paragraphId)).toHaveLength(1);
  });

  it('throws AssociationParagraphNotFoundError for a missing paragraph', async () => {
    await expect(
      createAssociation('00000000-0000-0000-0000-000000000000', {
        label: 'x',
        url: 'https://e.com/x.pdf',
      })
    ).rejects.toBeInstanceOf(AssociationParagraphNotFoundError);
  });

  it('deleteAssociation returns true on hit, false on miss', async () => {
    const a = await createAssociation(paragraphId, { label: 'd', url: 'https://e.com/d.pdf' });
    expect(await deleteAssociation(paragraphId, a.id)).toBe(true);
    expect(await deleteAssociation(paragraphId, a.id)).toBe(false);
  });

  it('groups associations by paragraph for a spec — label is preserved', async () => {
    await createAssociation(paragraphId, { label: 'one', url: 'https://e.com/1.pdf' });
    const map = await listAssociationsForSpec(specId);
    expect(map.get(paragraphId)).toHaveLength(1);
    expect(map.get(paragraphId)?.[0]?.label).toBe('one');
  });
});

describe('associations surface in reads', () => {
  it('getSpecTree attaches meta.associations to the owning node', async () => {
    const a = await createAssociation(paragraphId, {
      label: 'tree link',
      url: 'https://example.com/t.pdf',
    });
    const result = await getSpecTree(specId);
    const node = result!.tree.parts.find((n) => n.id === paragraphId);
    expect(node?.meta.associations).toHaveLength(1);
    expect(node?.meta.associations?.[0]?.id).toBe(a.id);
  });

  it('getParagraphWithAncestors attaches associations to the node', async () => {
    const a = await createAssociation(paragraphId, {
      label: 'para link',
      url: 'https://example.com/p.pdf',
    });
    const result = await getParagraphWithAncestors(paragraphId);
    expect(result?.node.associations).toHaveLength(1);
    expect(result?.node.associations?.[0]?.id).toBe(a.id);
  });
});
