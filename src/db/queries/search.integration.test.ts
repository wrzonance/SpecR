import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';
import { insertTree } from './paragraphs.js';
import { searchParagraphs, listCsiSections } from './search.js';

let searchSpecId: string;

beforeAll(async () => {
  searchSpecId = await createSpec({
    section: '27 10 00',
    title: 'Search Test Spec',
    source: 'arcat',
  });
  await insertTree(
    {
      id: searchSpecId,
      section: '27 10 00',
      title: 'Search Test Spec',
      parts: [
        {
          id: '20000000-0000-0000-0000-000000000001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '20000000-0000-0000-0000-000000000002',
              type: 'article',
              text: 'REFERENCES',
              children: [
                {
                  id: '20000000-0000-0000-0000-000000000003',
                  type: 'pr1',
                  text: 'Fiber optic backbone cabling requirements.',
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
    searchSpecId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [searchSpecId]);
});

describe('searchParagraphs', () => {
  it('returns matching paragraphs', async () => {
    const results = await searchParagraphs('fiber optic');
    const match = results.find((r) => r.specId === searchSpecId);
    expect(match).toBeDefined();
    expect(match!.text).toBe('Fiber optic backbone cabling requirements.');
    expect(match!.nodeType).toBe('pr1');
    expect(match!.specSection).toBe('27 10 00');
  });

  it('returns empty array for no match', async () => {
    const results = await searchParagraphs('xyznonexistentquery12345');
    expect(results).toEqual([]);
  });

  it('filters by division', async () => {
    const results = await searchParagraphs('fiber optic', '27');
    expect(results.some((r) => r.specId === searchSpecId)).toBe(true);

    const noResults = await searchParagraphs('fiber optic', '01');
    expect(noResults.some((r) => r.specId === searchSpecId)).toBe(false);
  });

  it('respects limit', async () => {
    const results = await searchParagraphs('', undefined, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('listCsiSections', () => {
  it('returns sections with inDatabase flag', async () => {
    const sections = await listCsiSections('27');
    const s = sections.find((r) => r.section === '27 10 00');
    expect(s).toBeDefined();
    expect(s!.inDatabase).toBe(true);
  });

  it('returns sections not in DB with inDatabase=false', async () => {
    const sections = await listCsiSections('27');
    const notLoaded = sections.filter((r) => !r.inDatabase);
    expect(notLoaded.length).toBeGreaterThan(0);
  });

  it('returns all divisions when no filter given', async () => {
    const sections = await listCsiSections();
    expect(sections.length).toBeGreaterThan(10);
  });
});
