import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphWithAncestors } from '../index.js';

const SPEC_ID = 'b0000000-0000-0000-0000-000000000000';
const PART_ID = 'b0000000-0000-0000-0000-000000000001';
const ART_ID = 'b0000000-0000-0000-0000-000000000002';
const PR1_ID = 'b0000000-0000-0000-0000-000000000003';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID, '99 99 00', 'Ancestors Test', 'arcat']
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,NULL,'part','GENERAL',1) ON CONFLICT (id) DO NOTHING`,
    [PART_ID, SPEC_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'article','SCOPE',1) ON CONFLICT (id) DO NOTHING`,
    [ART_ID, SPEC_ID, PART_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'pr1','Test paragraph text.',1) ON CONFLICT (id) DO NOTHING`,
    [PR1_ID, SPEC_ID, ART_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [SPEC_ID]);
});

describe('getParagraphWithAncestors', () => {
  it('returns node and full ancestor chain for a leaf paragraph', async () => {
    const result = await getParagraphWithAncestors(PR1_ID);
    expect(result).not.toBeNull();
    expect(result!.node.id).toBe(PR1_ID);
    expect(result!.node.nodeType).toBe('pr1');
    expect(result!.node.text).toBe('Test paragraph text.');
    expect(result!.ancestors).toHaveLength(2);
    expect(result!.ancestors[0]!.id).toBe(PART_ID); // root first
    expect(result!.ancestors[0]!.nodeType).toBe('part');
    expect(result!.ancestors[1]!.id).toBe(ART_ID);
    expect(result!.ancestors[1]!.nodeType).toBe('article');
  });

  it('returns node with empty ancestors for a root-level paragraph', async () => {
    const result = await getParagraphWithAncestors(PART_ID);
    expect(result).not.toBeNull();
    expect(result!.node.id).toBe(PART_ID);
    expect(result!.ancestors).toHaveLength(0);
  });

  it('returns null for unknown UUID', async () => {
    const result = await getParagraphWithAncestors('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});
