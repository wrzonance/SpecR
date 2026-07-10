import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';
import { insertTree } from './paragraphs.js';
import { searchParagraphs, listSpecSections } from './search.js';

let searchSpecId: string;

// A long filler run so the SCATTERED paragraph's cover (the span holding all
// query lexemes) is large — ts_rank_cd then scores it below the TIGHT paragraph.
const FILLER =
  'the contractor shall coordinate the work with adjacent trades and verify all ' +
  'field conditions before proceeding with the installation of any of the following items';

const TIGHT = 'Firestopping at conduit penetrations shall be installed per tested UL systems.';
// The trailing ~^~ is a globally-unique punctuation marker: a punctuation-only
// query yields an empty tsquery, so only the ILIKE fallback can match it — and it
// appears nowhere else in the shared test DB, keeping that assertion deterministic.
const SCATTERED = `Firestopping is required throughout the project. ${FILLER}. Route each conduit run as shown on the drawings. ${FILLER}. Seal all remaining wall penetrations after inspection ~^~.`;
const PRODUCTS_HIT = 'Firestop sealant products for conduit penetrations at each rated opening.';

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
          id: '30000000-0000-0000-0000-000000000001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '30000000-0000-0000-0000-000000000002',
              type: 'article',
              text: 'REFERENCES',
              children: [
                {
                  id: '30000000-0000-0000-0000-000000000010',
                  type: 'pr1',
                  text: 'Fiber optic backbone cabling requirements.',
                  children: [],
                  meta: {},
                },
                {
                  id: '30000000-0000-0000-0000-000000000011',
                  type: 'pr1',
                  text: TIGHT,
                  children: [],
                  meta: {},
                },
                {
                  id: '30000000-0000-0000-0000-000000000012',
                  type: 'pr1',
                  text: SCATTERED,
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
        {
          id: '30000000-0000-0000-0000-000000000003',
          type: 'part',
          text: 'PRODUCTS',
          children: [
            {
              id: '30000000-0000-0000-0000-000000000004',
              type: 'article',
              text: 'MATERIALS',
              children: [
                {
                  id: '30000000-0000-0000-0000-000000000020',
                  type: 'pr1',
                  text: PRODUCTS_HIT,
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

// Results restricted to the fixture spec, preserving rank order.
async function search(query: string, options = {}) {
  const rows = await searchParagraphs(query, { ...options, limit: 100 });
  return rows.filter((r) => r.specId === searchSpecId);
}

describe('searchParagraphs (full-text)', () => {
  it('returns ranked hits with a highlighted snippet and numeric rank', async () => {
    const results = await search('fiber optic');
    const match = results.find((r) => r.paragraphId === '30000000-0000-0000-0000-000000000010');
    expect(match).toBeDefined();
    expect(match!.nodeType).toBe('pr1');
    expect(match!.specSection).toBe('27 10 00');
    expect(match!.rank).toBeGreaterThan(0);
    // ts_headline wraps matched lexemes in <mark>…</mark>.
    expect(match!.snippet).toContain('<mark>');
  });

  it('matches on stemmed terms (recall the ILIKE scan lacked)', async () => {
    // "penetration" (singular) stems to the same lexeme as "penetrations".
    const results = await search('conduit penetration');
    const ids = results.map((r) => r.paragraphId);
    expect(ids).toContain('30000000-0000-0000-0000-000000000011');
  });

  it('ranks a tight cluster above the same terms scattered across a long paragraph', async () => {
    const results = await search('firestopping conduit penetrations');
    const ids = results.map((r) => r.paragraphId);
    const tightAt = ids.indexOf('30000000-0000-0000-0000-000000000011');
    const scatteredAt = ids.indexOf('30000000-0000-0000-0000-000000000012');
    expect(tightAt).toBeGreaterThanOrEqual(0);
    expect(scatteredAt).toBeGreaterThanOrEqual(0);
    expect(tightAt).toBeLessThan(scatteredAt);
  });

  it('filters by division', async () => {
    expect((await search('firestopping', { division: '27' })).length).toBeGreaterThan(0);
    expect((await search('firestopping', { division: '01' })).length).toBe(0);
  });

  it('filters by CSI part — PRODUCTS (part 2) excludes GENERAL (part 1)', async () => {
    const products = await search('conduit', { part: 2 });
    const ids = products.map((r) => r.paragraphId);
    expect(ids).toContain('30000000-0000-0000-0000-000000000020');
    expect(ids).not.toContain('30000000-0000-0000-0000-000000000011');

    const general = await search('conduit', { part: 1 });
    const generalIds = general.map((r) => r.paragraphId);
    expect(generalIds).toContain('30000000-0000-0000-0000-000000000011');
    expect(generalIds).not.toContain('30000000-0000-0000-0000-000000000020');
  });

  it('filters by nodeType', async () => {
    const results = await search('firestopping', { nodeType: 'pr1' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.nodeType === 'pr1')).toBe(true);
  });

  it('returns an empty array for a blank query', async () => {
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
  });

  it('returns an empty array for a genuine no-match', async () => {
    expect(await search('xyznonexistentquery12345')).toEqual([]);
  });

  it('falls back to ILIKE substring for a degenerate (no-lexeme) query', async () => {
    // A punctuation-only query produces an empty tsquery, so the ILIKE branch is
    // the only thing that can match the literal ~^~ marker in the SCATTERED text.
    const results = await search('~^~');
    const match = results.find((r) => r.paragraphId === '30000000-0000-0000-0000-000000000012');
    expect(match).toBeDefined();
    // The fallback path carries no ts_rank score.
    expect(match!.rank).toBe(0);
  });
});

describe('listSpecSections', () => {
  it('returns sections with inDatabase flag', async () => {
    const sections = await listSpecSections('27');
    const s = sections.find((r) => r.section === '27 10 00');
    expect(s).toBeDefined();
    expect(s!.inDatabase).toBe(true);
  });

  it('returns sections not in DB with inDatabase=false', async () => {
    const sections = await listSpecSections('27');
    const notLoaded = sections.filter((r) => !r.inDatabase);
    expect(notLoaded.length).toBeGreaterThan(0);
  });

  it('returns all divisions when no filter given', async () => {
    const sections = await listSpecSections();
    expect(sections.length).toBeGreaterThan(10);
  });
});
