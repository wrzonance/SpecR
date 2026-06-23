// src/mcp/associations.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, createAssociation } from '../db/index.js';
import { handleGetParagraph } from './handlers.js';

let specId: string;
let paragraphId: string;

beforeAll(async () => {
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('09 91 00', 'Painting', 'unknown',
       (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`
  );
  specId = spec.rows[0]!.id;
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'paragraph', 'Provide products.', 1) RETURNING id`,
    [specId]
  );
  paragraphId = para.rows[0]!.id;
  await createAssociation(paragraphId, {
    label: 'Acme 4500 datasheet',
    externalProvider: 'projectwise',
    externalId: 'doc-123',
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
});

describe('MCP get_paragraph surfaces associations', () => {
  it('includes the association in the tool result JSON', async () => {
    const result = await handleGetParagraph({ paragraphId });
    expect('isError' in result).toBe(false);
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as {
      node: { associations?: readonly { label: string }[] };
    };
    expect(parsed.node.associations?.[0]?.label).toBe('Acme 4500 datasheet');
  });
});
