import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, createSpec, insertTree } from '../db/index.js';
import { handleSearchLibrary } from './handlers.js';
import { ANCHORS_META_KEY, type McpAnchor } from './anchors.js';

// A token no other loaded paragraph contains, so the search hit is ours alone.
const UNIQUE = 'zzqquuxfocus';
const PARA_ID = '20000000-0000-0000-0000-0000000000f2';
let specId: string;

beforeAll(async () => {
  specId = await createSpec({
    section: '27 15 00',
    title: 'Focus Anchor Test Spec',
    source: 'arcat',
  });
  await insertTree(
    {
      id: specId,
      section: '27 15 00',
      title: 'Focus Anchor Test Spec',
      parts: [
        {
          id: '20000000-0000-0000-0000-0000000000f1',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '20000000-0000-0000-0000-0000000000fa',
              type: 'article',
              text: 'SUMMARY',
              children: [
                {
                  id: PARA_ID,
                  type: 'pr1',
                  text: `Requirement mentioning ${UNIQUE} cabling.`,
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    },
    specId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
});

describe('handleSearchLibrary — _meta anchors (focus channel)', () => {
  it('attaches a navigation anchor for the matching hit under _meta', async () => {
    const result = await handleSearchLibrary({ query: UNIQUE, division: undefined, limit: 10 });
    expect('isError' in result).toBe(false);
    const anchors = (result as { _meta?: Record<string, unknown> })._meta?.[ANCHORS_META_KEY] as
      McpAnchor[] | undefined;
    expect(anchors).toBeDefined();
    const mine = anchors!.find((a) => a.specId === specId);
    expect(mine).toEqual({ section: '27 15 00', specId, paragraphId: PARA_ID });
    // Regression guard: the text content is still the full JSON payload.
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('paragraphId');
  });
});
