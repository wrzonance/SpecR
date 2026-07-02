import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import {
  classifyScopedRefs,
  buildReferenceConsistencyFindings,
  type ClassifiedRef,
} from './article-refs.js';

const suffix = randomUUID().slice(0, 8);
const specIds: string[] = [];
let specCounter = 0;

async function newSpec(section: string, title: string): Promise<string> {
  const src = `ar_${suffix}_${String(++specCounter).padStart(2, '0')}`;
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

// Insert an article heading paragraph; returns its id so children attach via parent_id.
async function newArticle(specId: string, headingText: string, position: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'article', $2, $3) RETURNING id`,
    [specId, headingText, position]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newArticle: no id');
  return id;
}

// Insert a body paragraph (optionally under an article) + a matching spec_references row.
async function addRef(args: {
  specId: string;
  parentId: string | null;
  text: string;
  targetType: 'section' | 'standard';
  value: string; // canonical section or standard_code
}): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, $2, 'pr1', $3, 1) RETURNING id`,
    [args.specId, args.parentId, args.text]
  );
  const paragraphId = p.rows[0]?.id;
  if (paragraphId === undefined) throw new Error('addRef: no paragraph id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, standard_code, reference_text)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      args.specId,
      paragraphId,
      args.targetType,
      args.targetType === 'section' ? args.value : null,
      args.targetType === 'standard' ? args.value : null,
      args.text,
    ]
  );
}

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [specIds]);
});

describe('classifyScopedRefs', () => {
  it('tags a ref under a Related Sections article as related-sections, and a body ref as other', async () => {
    const spec = await newSpec('08 11 13', 'Hollow Metal Doors');
    const related = await newArticle(spec, '1.1 RELATED SECTIONS', 1);
    await addRef({
      specId: spec,
      parentId: related,
      text: 'Section 07 84 00',
      targetType: 'section',
      value: '07 84 00',
    });
    await addRef({
      specId: spec,
      parentId: null,
      text: 'Coordinate with Section 26 05 33',
      targetType: 'section',
      value: '26 05 33',
    });

    const classified = await classifyScopedRefs([spec], pool);

    const byValue = new Map(classified.map((c) => [c.value, c.ancestorRole]));
    expect(byValue.get('07 84 00')).toBe('related-sections');
    expect(byValue.get('26 05 33')).toBe('other');
  });

  it('tags a standard ref under a References article as references', async () => {
    const spec = await newSpec('07 84 00', 'Firestopping');
    const refsArticle = await newArticle(spec, '1.02 REFERENCES', 1);
    await addRef({
      specId: spec,
      parentId: refsArticle,
      text: 'ASTM E814',
      targetType: 'standard',
      value: 'ASTM E814',
    });
    await addRef({
      specId: spec,
      parentId: null,
      text: 'Test per ASTM E119',
      targetType: 'standard',
      value: 'ASTM E119',
    });

    const classified = await classifyScopedRefs([spec], pool);

    const byValue = new Map(classified.map((c) => [c.value, c.ancestorRole]));
    expect(byValue.get('ASTM E814')).toBe('references');
    expect(byValue.get('ASTM E119')).toBe('other');
  });

  it('does not borrow an article role across specs: a parent_id into another spec is ignored', async () => {
    // specA owns a RELATED SECTIONS article. specB has a ref whose paragraph's
    // parent_id points INTO specA's article. The ancestry walk must stay within
    // specB, so the ref classifies as 'other' — not 'related-sections'.
    const specA = await newSpec('08 11 13', 'Hollow Metal Doors');
    const specAArticle = await newArticle(specA, '1.1 RELATED SECTIONS', 1);
    const specB = await newSpec('09 21 16', 'Gypsum Board');
    await addRef({
      specId: specB,
      parentId: specAArticle,
      text: 'Section 07 84 00',
      targetType: 'section',
      value: '07 84 00',
    });

    const classified = await classifyScopedRefs([specB], pool);

    expect(classified.map((c) => [c.value, c.ancestorRole])).toEqual([['07 84 00', 'other']]);
  });

  it('returns an empty array for an empty spec set without querying', async () => {
    expect(await classifyScopedRefs([], pool)).toEqual([]);
  });
});

describe('buildReferenceConsistencyFindings', () => {
  const spec = (overrides: Partial<ClassifiedRef>): ClassifiedRef => ({
    sourceSpecId: 's1',
    sourceSpecSection: '08 11 13',
    sourceParagraphId: 'p1',
    targetType: 'section',
    value: '00 00 00',
    ancestorRole: 'other',
    ...overrides,
  });

  it('A3: a section listed under Related Sections but never cited elsewhere', () => {
    const findings = buildReferenceConsistencyFindings([
      spec({ value: '07 84 00', ancestorRole: 'related-sections' }),
    ]);
    expect(findings).toEqual([
      {
        type: 'related_listed_not_cited',
        sourceSpecId: 's1',
        sourceSpecSection: '08 11 13',
        sourceParagraphId: 'p1',
        value: '07 84 00',
      },
    ]);
  });

  it('A2: a section cited in the body but absent from Related Sections', () => {
    const findings = buildReferenceConsistencyFindings([
      spec({ value: '26 05 33', ancestorRole: 'other' }),
    ]);
    expect(findings).toEqual([
      {
        type: 'related_cited_not_listed',
        sourceSpecId: 's1',
        sourceSpecSection: '08 11 13',
        sourceParagraphId: 'p1',
        value: '26 05 33',
      },
    ]);
  });

  it('listed AND cited elsewhere yields no A2/A3 finding (the healthy case)', () => {
    const findings = buildReferenceConsistencyFindings([
      spec({ value: '07 84 00', ancestorRole: 'related-sections' }),
      spec({ value: '07 84 00', ancestorRole: 'other' }),
    ]);
    expect(findings.filter((f) => f.type.startsWith('related_'))).toEqual([]);
  });

  it('B2: a standard cited in the body but absent from References', () => {
    const findings = buildReferenceConsistencyFindings([
      spec({ targetType: 'standard', value: 'ASTM E814', ancestorRole: 'other' }),
    ]);
    expect(findings).toEqual([
      {
        type: 'standard_cited_not_listed',
        sourceSpecId: 's1',
        sourceSpecSection: '08 11 13',
        sourceParagraphId: 'p1',
        value: 'ASTM E814',
      },
    ]);
  });

  it('B1 non-goal: a standard listed under References but not cited yields nothing', () => {
    const findings = buildReferenceConsistencyFindings([
      spec({ targetType: 'standard', value: 'ASTM E814', ancestorRole: 'references' }),
    ]);
    expect(findings).toEqual([]);
  });

  it('isolates per spec: a section listed in spec A does not satisfy a citation in spec B', () => {
    const findings = buildReferenceConsistencyFindings([
      {
        sourceSpecId: 'A',
        sourceSpecSection: '08 11 13',
        sourceParagraphId: 'pA',
        targetType: 'section',
        value: '07 84 00',
        ancestorRole: 'related-sections',
      },
      {
        sourceSpecId: 'B',
        sourceSpecSection: '09 21 16',
        sourceParagraphId: 'pB',
        targetType: 'section',
        value: '07 84 00',
        ancestorRole: 'other',
      },
    ]);
    const types = findings
      .map((f) => `${f.sourceSpecId}:${f.type}`)
      .sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(['A:related_listed_not_cited', 'B:related_cited_not_listed']);
  });
});
