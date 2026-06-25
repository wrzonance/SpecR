import type { Pool } from 'pg';
import { DatabaseError } from '../errors.js';
import { deriveArticleRole } from '../../ast/index.js';

interface Queryable {
  query: Pool['query'];
}

export interface ClassifiedRef {
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly targetType: 'section' | 'standard';
  readonly value: string;
  readonly ancestorRole: 'related-sections' | 'references' | 'other';
}

interface ClassifiedRefRow {
  readonly source_spec_id: string;
  readonly source_spec_section: string;
  readonly target_type: 'section' | 'standard';
  readonly value: string;
  readonly article_text: string | null;
}

// For every section/standard ref whose source spec is in `specIds`, find the
// heading text of the NEAREST ancestor `article` paragraph (depth-0 = the ref's
// own paragraph). DISTINCT ON keeps the closest article per ref. `value` is the
// section number (section refs) or standard_code (standard refs); rows with a
// null comparison value are excluded — they carry no set membership.
const CLASSIFY_SQL = `
  WITH RECURSIVE refs AS (
    SELECT sr.id AS ref_id, sr.source_spec_id, s.section AS source_spec_section,
           sr.target_type,
           COALESCE(sr.target_spec_section, sr.standard_code) AS value,
           sr.source_paragraph_id
    FROM spec_references sr
    JOIN specs s ON s.id = sr.source_spec_id
    WHERE sr.source_spec_id = ANY($1::uuid[])
      AND sr.target_type IN ('section', 'standard')
      AND COALESCE(sr.target_spec_section, sr.standard_code) IS NOT NULL
  ),
  ancestry AS (
    SELECT r.ref_id, p.id, p.parent_id, p.node_type, p.text, 0 AS depth
    FROM refs r JOIN paragraphs p ON p.id = r.source_paragraph_id
    UNION ALL
    -- depth cap is a cycle guard: paragraphs is application-built and acyclic,
    -- but a corrupt parent_id loop would otherwise recurse unbounded. CSI trees
    -- are only a handful deep, so 100 is far above any legitimate chain.
    SELECT a.ref_id, p.id, p.parent_id, p.node_type, p.text, a.depth + 1
    FROM ancestry a JOIN paragraphs p ON p.id = a.parent_id
    WHERE a.depth < 100
  ),
  nearest_article AS (
    SELECT DISTINCT ON (ref_id) ref_id, text AS article_text
    FROM ancestry
    WHERE node_type = 'article'
    ORDER BY ref_id, depth ASC
  )
  SELECT r.source_spec_id, r.source_spec_section, r.target_type, r.value,
         na.article_text
  FROM refs r
  LEFT JOIN nearest_article na ON na.ref_id = r.ref_id
`;

function resolveRole(articleText: string | null): ClassifiedRef['ancestorRole'] {
  if (articleText === null) return 'other';
  const role = deriveArticleRole(articleText);
  return role === 'related-sections' || role === 'references' ? role : 'other';
}

export async function classifyScopedRefs(
  specIds: readonly string[],
  db: Queryable
): Promise<readonly ClassifiedRef[]> {
  if (specIds.length === 0) return [];
  try {
    const result = await db.query<ClassifiedRefRow>(CLASSIFY_SQL, [specIds]);
    return result.rows.map((row) => ({
      sourceSpecId: row.source_spec_id,
      sourceSpecSection: row.source_spec_section,
      targetType: row.target_type,
      value: row.value,
      ancestorRole: resolveRole(row.article_text),
    }));
  } catch (err) {
    throw new DatabaseError('classifyScopedRefs: query failed', { cause: err });
  }
}

export interface ReferenceConsistencyFinding {
  readonly type:
    | 'related_listed_not_cited'
    | 'related_cited_not_listed'
    | 'standard_cited_not_listed';
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly value: string;
}

// Mutable accumulators: the Sets are filled in place by `place()` and never
// escape `buildReferenceConsistencyFindings`, so they are deliberately not
// `readonly` — only the spec section, which is fixed at creation, is.
interface SpecBuckets {
  readonly sourceSpecSection: string;
  listedSections: Set<string>;
  citedSections: Set<string>;
  listedStandards: Set<string>;
  citedStandards: Set<string>;
}

function emptyBuckets(sourceSpecSection: string): SpecBuckets {
  return {
    sourceSpecSection,
    listedSections: new Set(),
    citedSections: new Set(),
    listedStandards: new Set(),
    citedStandards: new Set(),
  };
}

function bucketOf(maps: Map<string, SpecBuckets>, ref: ClassifiedRef): SpecBuckets {
  const existing = maps.get(ref.sourceSpecId);
  if (existing !== undefined) return existing;
  const fresh = emptyBuckets(ref.sourceSpecSection);
  maps.set(ref.sourceSpecId, fresh);
  return fresh;
}

function place(b: SpecBuckets, ref: ClassifiedRef): void {
  if (ref.targetType === 'section') {
    (ref.ancestorRole === 'related-sections' ? b.listedSections : b.citedSections).add(ref.value);
  } else {
    (ref.ancestorRole === 'references' ? b.listedStandards : b.citedStandards).add(ref.value);
  }
}

function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((v) => !b.has(v)).sort((x, y) => x.localeCompare(y));
}

function findingsForSpec(specId: string, b: SpecBuckets): ReferenceConsistencyFinding[] {
  const base = { sourceSpecId: specId, sourceSpecSection: b.sourceSpecSection };
  return [
    ...difference(b.listedSections, b.citedSections).map(
      (value): ReferenceConsistencyFinding => ({ type: 'related_listed_not_cited', ...base, value })
    ),
    ...difference(b.citedSections, b.listedSections).map(
      (value): ReferenceConsistencyFinding => ({ type: 'related_cited_not_listed', ...base, value })
    ),
    ...difference(b.citedStandards, b.listedStandards).map(
      (value): ReferenceConsistencyFinding => ({
        type: 'standard_cited_not_listed',
        ...base,
        value,
      })
    ),
  ];
}

export function buildReferenceConsistencyFindings(
  classified: readonly ClassifiedRef[]
): readonly ReferenceConsistencyFinding[] {
  const bySpec = new Map<string, SpecBuckets>();
  for (const ref of classified) place(bucketOf(bySpec, ref), ref);
  return [...bySpec.entries()]
    .sort(([, a], [, b]) => a.sourceSpecSection.localeCompare(b.sourceSpecSection))
    .flatMap(([specId, b]) => findingsForSpec(specId, b));
}
