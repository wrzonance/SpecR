# Article↔Body Reference Consistency (Related Sections / References) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three deterministic coordination findings — `related_listed_not_cited` (A3), `related_cited_not_listed` (A2), `standard_cited_not_listed` (B2) — that reconcile each spec's role-tagged Related Sections / References articles against the refs cited in the rest of its body.

**Architecture:** A new query helper (`src/db/queries/article-refs.ts`) classifies every section/standard ref in a project's specs as either *listed* (its source paragraph sits inside a `related-sections` or `references` article) or *cited-elsewhere* (anywhere else in the same spec), using a single recursive CTE that walks `paragraphs.parent_id` to the nearest ancestor `article` and derives its role with `deriveArticleRole`. `coordination.ts` consumes that classification to emit the three set-difference findings, alongside the existing three. The Finding union, summary, openapi schema, and MCP/REST surfaces extend in lockstep.

**Tech Stack:** TypeScript/Node 22 (ESM, `.js` relative imports), Express, Zod v4, PostgreSQL (`pg`), vitest (unit + integration projects).

## Global Constraints

- ESM project: relative imports use `.js`; type-only imports use `import type`.
- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400 (file cap), `no-console` = error, `@typescript-eslint/no-explicit-any` = error. No non-null `!` outside tests, no `as unknown as`.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`.
- Module boundaries HARD: import only from a sibling's `index.ts` barrel, never internals. Within `src/db/queries/` sibling files import each other directly (existing pattern — `coordination.ts` already imports `./project-refs.js`, `./required-sections.js`).
- Typed errors chain `cause`. DB layer throws `DatabaseError` (from `../errors.js` / re-exported by `../index.js`). Validate external input with Zod, chaining `ZodError`.
- No `console.*` in `src/` — use `src/lib/logger.ts` if logging is needed (none is here).
- `openapi.yaml` is the CI-enforced contract (`src/api/contract.integration.test.ts`): the three new Finding types and the three new summary counts MUST be added in the SAME PR, with descriptions matching behavior.
- MCP tools never throw — return `{ isError: true, content: [...] }`. The existing `handleCoordinationReport` already satisfies this and needs no change (it serializes whatever `getCoordinationReport` returns).
- Regression tests named for the symptom. Conventional Commits, scope = module changed. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Non-goal (do NOT implement):** B1 "standard listed under References but not cited" — a listed-but-uncited standard yields NOTHING.

## Domain facts (verified against the codebase — read before starting)

- **Refs** live in `spec_references` (migration 008). Relevant columns: `id`, `source_spec_id`, `source_paragraph_id` (NOT NULL, FK → paragraphs), `target_type` (`'section'` | `'standard'`), `target_spec_section` (canonical `"NN NN NN"` for section refs, else NULL), `standard_code` (e.g. `"ASTM E814"` for standard refs, else NULL), `reference_text`.
- **Paragraphs** (migration 003) form a tree via `parent_id` (nullable, FK → paragraphs, ON DELETE CASCADE). `node_type` is a `varchar(20)`; an article heading row has `node_type='article'` and its listed items are descendant rows whose `parent_id` chain leads back to it. `text` holds the heading/body text.
- **Article role** is DERIVED, never stored: `deriveArticleRole(text: string): ArticleRole | undefined` (exported from `../../ast/index.js`). Roles of interest: `'related-sections'`, `'references'`. It tolerates a leading CSI number prefix ("1.1 REFERENCES" → role `references`).
- **Section-number canonical form**: refs already store `target_spec_section` in canonical `"NN NN NN"` form (extraction normalizes via `parseSectionNumberCandidate(..., 'strong')`). So A2/A3 set comparison is a plain string compare on `target_spec_section`. **Listed** Related-Sections entries are themselves section refs (the extractor runs over the whole tree, including inside articles), so they ALSO appear in `spec_references` with `target_type='section'` and a canonical `target_spec_section`. No re-parsing of article prose is needed.
- **Standard canonical form**: `standard_code` (e.g. `"ASTM E814"`) — compare as-is (the extractor produces a normalized `ORG <id>` form). B2 compares the set of `standard_code` cited outside the References article against the set listed inside it.
- **Scope**: `getCoordinationReport(projectId, packageId?)` already resolves the in-scope spec set via `readPresent` (project_specs or package_specs). The new query must restrict to the SAME spec set. Findings are per-spec (a defect is "this spec lists/cites X").
- The report runs inside a `REPEATABLE READ, READ ONLY` transaction; the new query takes the same `Queryable` (`{ query: Pool['query'] }`) client so it joins the snapshot.

## Algorithm (the heart of the feature)

For each in-scope spec, classify each of its refs by the role of the nearest ancestor `article` of its `source_paragraph_id`:

- **listedSections(spec)** = `{ target_spec_section }` of section refs whose ancestor article role is `related-sections`.
- **citedSectionsElsewhere(spec)** = `{ target_spec_section }` of section refs whose ancestor article role is NOT `related-sections` (i.e. body, or under any other article, or no article ancestor).
- **listedStandards(spec)** = `{ standard_code }` of standard refs whose ancestor article role is `references`.
- **citedStandardsElsewhere(spec)** = `{ standard_code }` of standard refs whose ancestor article role is NOT `references`.

Then per spec:
- **A3 `related_listed_not_cited`** = listedSections − citedSectionsElsewhere.
- **A2 `related_cited_not_listed`** = citedSectionsElsewhere − listedSections.
- **B2 `standard_cited_not_listed`** = citedStandardsElsewhere − listedStandards.

Role resolution uses a recursive CTE walking `parent_id` up from each ref's paragraph. Because `deriveArticleRole` is TypeScript (not reproducible in SQL without duplicating the rule table), the query returns each article ancestor's **heading text** and `node_type`, and the TS layer maps text→role with `deriveArticleRole`. To keep it bounded and simple: the query returns, for every ref in scope, the chain of ancestor article headings; TS picks the nearest article ancestor and derives its role. (A paragraph has at most one article ancestor in CSI structure — Part → Article → paragraph — but we take the *nearest* article defensively.)

---

## File Structure

- **Create** `src/db/queries/article-refs.ts` — the classification query + pure set-difference finding builders. One responsibility: turn a project/package scope into the four ref-sets per spec and the three new findings. Target < 200 lines.
- **Create** `src/db/queries/article-refs.integration.test.ts` — integration tests for the query against real Postgres (fixtures with article + child paragraphs + spec_references rows).
- **Modify** `src/db/queries/coordination.ts` — extend the `Finding` union (+3 variants), `CoordinationSummary` (+3 counts), wire the new findings + summary counts into `buildFindings`/`summarize`/`getCoordinationReport`.
- **Modify** `src/db/queries/coordination.integration.test.ts` — add the three #259 verification-case tests + a regression for "package-scoped specs only".
- **Modify** `openapi.yaml` — add `FindingRelatedListedNotCited`, `FindingRelatedCitedNotListed`, `FindingStandardCitedNotListed` schemas, extend the `CoordinationFinding` oneOf+discriminator, extend `CoordinationSummary` with the three new integer counts, and extend the path/MCP-tool description to mention the new findings.
- **Modify** `src/db/index.ts` — re-export the new public types from `article-refs.ts` if any are needed across the barrel (only if a type escapes `coordination.ts`; likely none — keep `article-refs.ts` internals private and only export through `coordination.ts`'s `Finding`).
- **Modify** `src/mcp/tools.ts` — extend the `coordination_report` tool description string to mention the three reference-consistency findings (keep behavior identical; the tool already serializes the full report).

---

### Task 1: Ref-classification query — listed vs cited-elsewhere, per spec

**Files:**
- Create: `src/db/queries/article-refs.ts`
- Test: `src/db/queries/article-refs.integration.test.ts`

**Interfaces:**
- Consumes: `deriveArticleRole` from `../../ast/index.js`; `DatabaseError` from `../errors.js`; `Pool` type from `pg`.
- Produces (the names later tasks rely on):
  ```typescript
  interface Queryable { query: Pool['query']; }

  // One classified ref row, after TS resolves the ancestor-article role.
  export interface ClassifiedRef {
    readonly sourceSpecId: string;
    readonly sourceSpecSection: string;
    readonly targetType: 'section' | 'standard';
    readonly value: string;          // target_spec_section (section) | standard_code (standard)
    readonly ancestorRole: 'related-sections' | 'references' | 'other';
  }

  export async function classifyScopedRefs(
    specIds: readonly string[],
    db: Queryable
  ): Promise<readonly ClassifiedRef[]>;
  ```

The query: given the in-scope `specIds`, return every section/standard ref with its source spec's section and the heading text of its nearest ancestor `article`. The recursive CTE walks `parent_id` from each ref's `source_paragraph_id`; we keep the FIRST (`depth ASC`) article ancestor per ref. TS then derives the role; refs whose nearest article ancestor is `related-sections`/`references` get that role, all others get `'other'`.

- [ ] **Step 1: Write the failing test**

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import { classifyScopedRefs } from './article-refs.js';

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
    await addRef({ specId: spec, parentId: related, text: 'Section 07 84 00', targetType: 'section', value: '07 84 00' });
    await addRef({ specId: spec, parentId: null, text: 'Coordinate with Section 26 05 33', targetType: 'section', value: '26 05 33' });

    const classified = await classifyScopedRefs([spec], pool);

    const byValue = new Map(classified.map((c) => [c.value, c.ancestorRole]));
    expect(byValue.get('07 84 00')).toBe('related-sections');
    expect(byValue.get('26 05 33')).toBe('other');
  });

  it('tags a standard ref under a References article as references', async () => {
    const spec = await newSpec('07 84 00', 'Firestopping');
    const refsArticle = await newArticle(spec, '1.02 REFERENCES', 1);
    await addRef({ specId: spec, parentId: refsArticle, text: 'ASTM E814', targetType: 'standard', value: 'ASTM E814' });
    await addRef({ specId: spec, parentId: null, text: 'Test per ASTM E119', targetType: 'standard', value: 'ASTM E119' });

    const classified = await classifyScopedRefs([spec], pool);

    const byValue = new Map(classified.map((c) => [c.value, c.ancestorRole]));
    expect(byValue.get('ASTM E814')).toBe('references');
    expect(byValue.get('ASTM E119')).toBe('other');
  });

  it('returns an empty array for an empty spec set without querying', async () => {
    expect(await classifyScopedRefs([], pool)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/db/queries/article-refs.integration.test.ts`
Expected: FAIL — cannot resolve `./article-refs.js` (module not found).

- [ ] **Step 3: Write minimal implementation**

```typescript
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
    SELECT a.ref_id, p.id, p.parent_id, p.node_type, p.text, a.depth + 1
    FROM ancestry a JOIN paragraphs p ON p.id = a.parent_id
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/db/queries/article-refs.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/article-refs.ts src/db/queries/article-refs.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): classify spec refs by ancestor-article role (related-sections/references)

Recursive CTE walks paragraphs.parent_id to each ref's nearest ancestor
article; TS derives the role via deriveArticleRole. Foundation for #259
article<->body reference-consistency findings.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure finding builders — the three set differences

**Files:**
- Modify: `src/db/queries/article-refs.ts`
- Test: `src/db/queries/article-refs.integration.test.ts` (add a pure-function unit block — runs in the integration project but needs no DB; acceptable, or place in a sibling `.test.ts` — keep in the integration file for cohesion since `ClassifiedRef` lives here).

**Interfaces:**
- Consumes: `ClassifiedRef` (Task 1).
- Produces:
  ```typescript
  export interface ReferenceConsistencyFinding {
    readonly type:
      | 'related_listed_not_cited'
      | 'related_cited_not_listed'
      | 'standard_cited_not_listed';
    readonly sourceSpecId: string;
    readonly sourceSpecSection: string;
    readonly value: string; // the section number (A2/A3) or standard_code (B2)
  }

  export function buildReferenceConsistencyFindings(
    classified: readonly ClassifiedRef[]
  ): readonly ReferenceConsistencyFinding[];
  ```

Per spec: A3 = listedSections − citedElsewhereSections; A2 = citedElsewhereSections − listedSections; B2 = citedElsewhereStandards − listedStandards. Deterministic order: by source section, then finding type, then value.

- [ ] **Step 1: Write the failing test** (append to `article-refs.integration.test.ts`)

```typescript
import { buildReferenceConsistencyFindings, type ClassifiedRef } from './article-refs.js';

describe('buildReferenceConsistencyFindings', () => {
  const spec = (overrides: Partial<ClassifiedRef>): ClassifiedRef => ({
    sourceSpecId: 's1',
    sourceSpecSection: '08 11 13',
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
      { type: 'related_listed_not_cited', sourceSpecId: 's1', sourceSpecSection: '08 11 13', value: '07 84 00' },
    ]);
  });

  it('A2: a section cited in the body but absent from Related Sections', () => {
    const findings = buildReferenceConsistencyFindings([
      spec({ value: '26 05 33', ancestorRole: 'other' }),
    ]);
    expect(findings).toEqual([
      { type: 'related_cited_not_listed', sourceSpecId: 's1', sourceSpecSection: '08 11 13', value: '26 05 33' },
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
      { type: 'standard_cited_not_listed', sourceSpecId: 's1', sourceSpecSection: '08 11 13', value: 'ASTM E814' },
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
      { sourceSpecId: 'A', sourceSpecSection: '08 11 13', targetType: 'section', value: '07 84 00', ancestorRole: 'related-sections' },
      { sourceSpecId: 'B', sourceSpecSection: '09 21 16', targetType: 'section', value: '07 84 00', ancestorRole: 'other' },
    ]);
    const types = findings.map((f) => `${f.sourceSpecId}:${f.type}`).sort();
    expect(types).toEqual(['A:related_listed_not_cited', 'B:related_cited_not_listed']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/db/queries/article-refs.integration.test.ts`
Expected: FAIL — `buildReferenceConsistencyFindings` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `article-refs.ts`)

```typescript
export interface ReferenceConsistencyFinding {
  readonly type:
    | 'related_listed_not_cited'
    | 'related_cited_not_listed'
    | 'standard_cited_not_listed';
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly value: string;
}

interface SpecBuckets {
  sourceSpecSection: string;
  readonly listedSections: Set<string>;
  readonly citedSections: Set<string>;
  readonly listedStandards: Set<string>;
  readonly citedStandards: Set<string>;
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
  return [...a].filter((v) => !b.has(v)).sort();
}

function findingsForSpec(
  specId: string,
  b: SpecBuckets
): ReferenceConsistencyFinding[] {
  const base = { sourceSpecId: specId, sourceSpecSection: b.sourceSpecSection };
  return [
    ...difference(b.listedSections, b.citedSections).map(
      (value): ReferenceConsistencyFinding => ({ type: 'related_listed_not_cited', ...base, value })
    ),
    ...difference(b.citedSections, b.listedSections).map(
      (value): ReferenceConsistencyFinding => ({ type: 'related_cited_not_listed', ...base, value })
    ),
    ...difference(b.citedStandards, b.listedStandards).map(
      (value): ReferenceConsistencyFinding => ({ type: 'standard_cited_not_listed', ...base, value })
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/db/queries/article-refs.integration.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Lint + verify file budget**

Run: `pnpm lint`
Expected: clean. Confirm `article-refs.ts` is under 400 lines (it will be ~150).

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/article-refs.ts src/db/queries/article-refs.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): set-difference builders for article<->body reference findings

Per spec: A3 listed-not-cited, A2 cited-not-listed (sections); B2
standard-cited-not-listed. B1 (listed-not-cited standard) is a deliberate
non-goal and yields nothing. Pinned with per-spec isolation + healthy-case
regression tests. (#259)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the three findings into `getCoordinationReport`

**Files:**
- Modify: `src/db/queries/coordination.ts`
- Test: `src/db/queries/coordination.integration.test.ts`

**Interfaces:**
- Consumes: `classifyScopedRefs`, `buildReferenceConsistencyFindings`, `ReferenceConsistencyFinding` from `./article-refs.js`.
- Produces: extended `Finding` union (+3 variants below), extended `CoordinationSummary` (+`relatedListedNotCited`, `relatedCitedNotListed`, `standardCitedNotListed`), unchanged `getCoordinationReport` signature.

New `Finding` variants (added to the union in `coordination.ts`):
```typescript
  | {
      readonly type: 'related_listed_not_cited';
      readonly sourceSpecId: string;
      readonly sourceSpecSection: string;
      readonly section: string;
    }
  | {
      readonly type: 'related_cited_not_listed';
      readonly sourceSpecId: string;
      readonly sourceSpecSection: string;
      readonly section: string;
    }
  | {
      readonly type: 'standard_cited_not_listed';
      readonly sourceSpecId: string;
      readonly sourceSpecSection: string;
      readonly standardCode: string;
    };
```
(The `ReferenceConsistencyFinding.value` maps to `section` for A2/A3 and `standardCode` for B2 — a small adapter in `coordination.ts` keeps the public Finding fields self-describing, matching `dangling_ref`'s `targetSpecSection` style.)

- [ ] **Step 1: Write the failing test** (append the three #259 verification cases to `coordination.integration.test.ts`)

Add a helper near the existing `addRef` (which only handles section refs at the body root). Add `newArticle` + a role-aware `addRefUnder`:

```typescript
async function newArticle(specId: string, headingText: string, position: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'article', $2, $3) RETURNING id`,
    [specId, headingText, position]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newArticle: no id');
  return id;
}

// Body/article ref with explicit target_type + parent. value = canonical section or standard_code.
async function addClassifiedRef(args: {
  specId: string;
  parentId: string | null;
  text: string;
  targetType: 'section' | 'standard';
  value: string;
}): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, $2, 'pr1', $3, 1) RETURNING id`,
    [args.specId, args.parentId, args.text]
  );
  const pid = p.rows[0]?.id;
  if (pid === undefined) throw new Error('addClassifiedRef: no paragraph id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, standard_code, reference_text)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      args.specId,
      pid,
      args.targetType,
      args.targetType === 'section' ? args.value : null,
      args.targetType === 'standard' ? args.value : null,
      args.text,
    ]
  );
}
```

Tests:

```typescript
it('#259 A3: lists 07 84 00 under Related Sections but never cites it → related_listed_not_cited', async () => {
  const projectId = await newProject('coord-a3');
  const spec = await newSpec('08 11 13', 'Hollow Metal Doors');
  await addProjectSpec(projectId, spec, 1);
  const related = await newArticle(spec, '1.1 RELATED SECTIONS', 1);
  await addClassifiedRef({ specId: spec, parentId: related, text: 'Section 07 84 00', targetType: 'section', value: '07 84 00' });

  const report = await getCoordinationReport(projectId, undefined);
  const f = ofType(report.findings, 'related_listed_not_cited');
  expect(f.map((x) => x.section)).toEqual(['07 84 00']);
  expect(f[0]?.sourceSpecSection).toBe('08 11 13');
  expect(report.summary.relatedListedNotCited).toBe(1);
});

it('#259 A2: cites Section 26 05 33 in the body with no Related Sections entry → related_cited_not_listed', async () => {
  const projectId = await newProject('coord-a2');
  const spec = await newSpec('26 27 26', 'Wiring Devices');
  await addProjectSpec(projectId, spec, 1);
  await addClassifiedRef({ specId: spec, parentId: null, text: 'Coordinate with Section 26 05 33', targetType: 'section', value: '26 05 33' });

  const report = await getCoordinationReport(projectId, undefined);
  const f = ofType(report.findings, 'related_cited_not_listed');
  expect(f.map((x) => x.section)).toEqual(['26 05 33']);
  expect(report.summary.relatedCitedNotListed).toBe(1);
});

it('#259 B2: cites ASTM E814 in the body with no References entry → standard_cited_not_listed; a listed-but-uncited standard yields nothing', async () => {
  const projectId = await newProject('coord-b2');
  const spec = await newSpec('07 84 00', 'Firestopping');
  await addProjectSpec(projectId, spec, 1);
  const refsArticle = await newArticle(spec, '1.02 REFERENCES', 1);
  // listed-but-uncited (B1 non-goal): MUST yield nothing
  await addClassifiedRef({ specId: spec, parentId: refsArticle, text: 'ASTM E119', targetType: 'standard', value: 'ASTM E119' });
  // cited-but-unlisted (B2): the finding
  await addClassifiedRef({ specId: spec, parentId: null, text: 'Seal per ASTM E814', targetType: 'standard', value: 'ASTM E814' });

  const report = await getCoordinationReport(projectId, undefined);
  const f = ofType(report.findings, 'standard_cited_not_listed');
  expect(f.map((x) => x.standardCode)).toEqual(['ASTM E814']);
  expect(report.summary.standardCitedNotListed).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/db/queries/coordination.integration.test.ts`
Expected: FAIL — `ofType(..., 'related_listed_not_cited')` is not assignable / summary fields undefined (the union/summary don't include them yet).

- [ ] **Step 3: Write minimal implementation** in `coordination.ts`

3a. Add the import:
```typescript
import {
  classifyScopedRefs,
  buildReferenceConsistencyFindings,
  type ReferenceConsistencyFinding,
} from './article-refs.js';
```

3b. Extend the `Finding` union with the three variants shown in Interfaces above.

3c. Extend `CoordinationSummary`:
```typescript
export interface CoordinationSummary {
  readonly requiredNotPresent: number;
  readonly presentNotRequired: number;
  readonly danglingRef: number;
  readonly relatedListedNotCited: number;
  readonly relatedCitedNotListed: number;
  readonly standardCitedNotListed: number;
  readonly total: number;
}
```

3d. Add an adapter that maps `ReferenceConsistencyFinding` → `Finding`:
```typescript
function toReferenceFinding(f: ReferenceConsistencyFinding): Finding {
  const base = { sourceSpecId: f.sourceSpecId, sourceSpecSection: f.sourceSpecSection };
  if (f.type === 'standard_cited_not_listed') {
    return { type: f.type, ...base, standardCode: f.value };
  }
  return { type: f.type, ...base, section: f.value };
}
```

3e. Thread the classified refs through. Change `buildFindings` to accept the reference findings and append them; compute them in `getCoordinationReport` from the in-scope present spec ids:
```typescript
// in getCoordinationReport, after `present` is read and before COMMIT:
const classified = await classifyScopedRefs(present.map((p) => p.specId), client);
// ... COMMIT ...
const referenceFindings = buildReferenceConsistencyFindings(classified).map(toReferenceFinding);
const { findings, notes } = buildFindings(required, present, broken, referenceFindings);
```
Update `buildFindings`'s signature + return to spread `referenceFindings` into `findings` (keep order: required, present, dangling, then reference findings).

3f. Extend `summarize`:
```typescript
function summarize(findings: readonly Finding[]): CoordinationSummary {
  const count = (t: Finding['type']): number => findings.filter((f) => f.type === t).length;
  return {
    requiredNotPresent: count('required_not_present'),
    presentNotRequired: count('present_not_required'),
    danglingRef: count('dangling_ref'),
    relatedListedNotCited: count('related_listed_not_cited'),
    relatedCitedNotListed: count('related_cited_not_listed'),
    standardCitedNotListed: count('standard_cited_not_listed'),
    total: findings.length,
  };
}
```

> **ESLint watch:** if `buildFindings` exceeds complexity/length after adding a parameter, extract the reference-findings spread is trivial (just `...referenceFindings`), so it stays small. If `getCoordinationReport` approaches 50 lines, extract the classify+build into a `referenceFindings(present, client)` helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/db/queries/coordination.integration.test.ts`
Expected: PASS — all existing + the three new #259 tests. (The existing "returns exactly one finding of each class" test asserts `report.summary` equality — UPDATE its expected object to include the three new zero counts.)

- [ ] **Step 5: Update the existing summary-equality assertion**

In the first test, change the `expect(report.summary).toEqual({...})` to include `relatedListedNotCited: 0, relatedCitedNotListed: 0, standardCitedNotListed: 0`. Re-run.

- [ ] **Step 6: Full unit + lint**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test` then `pnpm lint`
Expected: green. Confirm `coordination.ts` is still under 400 lines.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/coordination.ts src/db/queries/coordination.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(coordination): article<->body reference consistency findings (#259)

related_listed_not_cited (A3), related_cited_not_listed (A2),
standard_cited_not_listed (B2). Reuses extracted spec_references; classifies
each by its source paragraph's nearest ancestor article role. B1 (listed
standard not cited) is a non-goal and yields nothing. Three #259 verification
cases pinned.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: openapi.yaml — Finding schemas, summary counts, descriptions

**Files:**
- Modify: `openapi.yaml`
- Test: `src/api/contract.integration.test.ts` (existing — runs as the gate, no edit needed).

CI's contract test validates that the route's actual response matches the schema. The new findings + summary fields MUST be reflected or the `coordination-report` response validation fails.

- [ ] **Step 1: Extend `CoordinationSummary`** (in `openapi.yaml`)

```yaml
    CoordinationSummary:
      type: object
      required:
        [
          requiredNotPresent,
          presentNotRequired,
          danglingRef,
          relatedListedNotCited,
          relatedCitedNotListed,
          standardCitedNotListed,
          total,
        ]
      properties:
        requiredNotPresent: { type: integer }
        presentNotRequired: { type: integer }
        danglingRef: { type: integer }
        relatedListedNotCited: { type: integer }
        relatedCitedNotListed: { type: integer }
        standardCitedNotListed: { type: integer }
        total: { type: integer }
```

- [ ] **Step 2: Extend the `CoordinationFinding` oneOf + discriminator**

```yaml
    CoordinationFinding:
      oneOf:
        - $ref: '#/components/schemas/FindingRequiredNotPresent'
        - $ref: '#/components/schemas/FindingPresentNotRequired'
        - $ref: '#/components/schemas/FindingDanglingRef'
        - $ref: '#/components/schemas/FindingRelatedListedNotCited'
        - $ref: '#/components/schemas/FindingRelatedCitedNotListed'
        - $ref: '#/components/schemas/FindingStandardCitedNotListed'
      discriminator:
        propertyName: type
        mapping:
          required_not_present: '#/components/schemas/FindingRequiredNotPresent'
          present_not_required: '#/components/schemas/FindingPresentNotRequired'
          dangling_ref: '#/components/schemas/FindingDanglingRef'
          related_listed_not_cited: '#/components/schemas/FindingRelatedListedNotCited'
          related_cited_not_listed: '#/components/schemas/FindingRelatedCitedNotListed'
          standard_cited_not_listed: '#/components/schemas/FindingStandardCitedNotListed'
```

- [ ] **Step 3: Add the three Finding schemas** (after `FindingDanglingRef`)

```yaml
    FindingRelatedListedNotCited:
      type: object
      description: >
        A3 — a section appears in this spec's Related Sections article but is never
        referenced anywhere else in its body. Likely an over-broad coordination list.
      required: [type, sourceSpecId, sourceSpecSection, section]
      properties:
        type: { type: string, enum: [related_listed_not_cited] }
        sourceSpecId: { type: string, format: uuid }
        sourceSpecSection: { type: string }
        section: { type: string, description: Canonical CSI number listed but not cited }
    FindingRelatedCitedNotListed:
      type: object
      description: >
        A2 — a section is cited in this spec's body but absent from its Related
        Sections article. The coordination list is missing a real dependency.
      required: [type, sourceSpecId, sourceSpecSection, section]
      properties:
        type: { type: string, enum: [related_cited_not_listed] }
        sourceSpecId: { type: string, format: uuid }
        sourceSpecSection: { type: string }
        section: { type: string, description: Canonical CSI number cited but not listed }
    FindingStandardCitedNotListed:
      type: object
      description: >
        B2 — a code/standard (ASTM, NFPA, UL, …) is cited in this spec's body but
        absent from its References article. (The inverse, a listed-but-uncited
        standard, is intentionally NOT reported — #259 non-goal B1.)
      required: [type, sourceSpecId, sourceSpecSection, standardCode]
      properties:
        type: { type: string, enum: [standard_cited_not_listed] }
        sourceSpecId: { type: string, format: uuid }
        sourceSpecSection: { type: string }
        standardCode: { type: string, description: Normalized "ORG identifier", e.g. ASTM E814 }
```

- [ ] **Step 4: Update the path summary/description** for `GET /projects/{id}/coordination-report` to mention the new findings (keep concise):

```yaml
      summary: Project coordination report — required/present/reference + article-body consistency findings
```
(Add no new `description` body unless one exists; the schema descriptions carry the detail.)

- [ ] **Step 5: Validate openapi + run the contract gate**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/api/contract.integration.test.ts`
Expected: PASS (route↔spec coverage + response-schema validation green).

- [ ] **Step 6: Lint (prettier checks openapi? no — but run full lint)**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add openapi.yaml
git commit -m "$(cat <<'EOF'
docs(api): document article<->body reference-consistency findings (#259)

Extend CoordinationFinding oneOf/discriminator with related_listed_not_cited,
related_cited_not_listed, standard_cited_not_listed; add their three summary
counts. Descriptions note B1 (listed-not-cited standard) is a non-goal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: MCP tool description + API integration assertion

**Files:**
- Modify: `src/mcp/tools.ts` (the `coordination_report` description string only)
- Modify: `src/api/coordination.integration.test.ts` (add one assertion that a reference-consistency finding flows through the HTTP layer end-to-end)

The MCP handler already serializes the full report — no logic change. Update its description so an MCP client knows the new findings exist (openapi-accuracy principle applies to tool descriptions too).

- [ ] **Step 1: Extend the `coordination_report` description** in `src/mcp/tools.ts`

Append to the existing description string:
```
'Also reports article<->body reference consistency: related_listed_not_cited ' +
'(a Related Sections entry never cited), related_cited_not_listed (a section ' +
'cited in the body but not listed), and standard_cited_not_listed (a standard ' +
'cited but absent from References). '
```

- [ ] **Step 2: Add an HTTP end-to-end assertion** in `src/api/coordination.integration.test.ts`

Mirror the existing fixture style there; add a spec that cites a section in the body with no Related Sections entry, hit the endpoint, and assert the response `data.findings` contains a `related_cited_not_listed` and `data.summary.relatedCitedNotListed === 1`. (Reuse that file's existing project/spec helpers; insert the body paragraph + spec_references row inline as in Task 3's `addClassifiedRef`.)

- [ ] **Step 3: Run MCP + API integration tests**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration -- src/mcp/coordination.integration.test.ts src/api/coordination.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/api/coordination.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): surface article<->body reference findings in coordination_report

Extend the tool description to name the three new findings; pin an HTTP
end-to-end assertion that related_cited_not_listed flows through GET
/projects/:id/coordination-report. (#259)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full green gate + finish branch

**Files:** none (verification + PR).

- [ ] **Step 1: Full lint**

Run: `pnpm lint`
Expected: eslint + tsc --noEmit + prettier all clean.

- [ ] **Step 2: Full unit suite**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test`
Expected: PASS.

- [ ] **Step 3: Full integration suite**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm test:integration`
Expected: PASS (including the contract gate).

- [ ] **Step 4: Finish the branch** via `superpowers:finishing-a-development-branch` option 2 (Push + PR). PR body: `Closes #259`, `## Why`, `## What`, `## Design decisions` (per-spec isolation; refs reused not re-parsed; B1 non-goal; role resolved in TS not SQL since `deriveArticleRole` owns the rule table), `## Testing` checklist.

---

## Self-Review

**1. Spec coverage:**
- A3 `related_listed_not_cited` → Task 2 builder + Task 3 wiring + Task 3 test ✓
- A2 `related_cited_not_listed` → same ✓
- B2 `standard_cited_not_listed` → same ✓
- B1 non-goal (listed standard not cited yields nothing) → Task 2 test "B1 non-goal" + Task 3 B2 test's listed-uncited fixture ✓
- Reuse extracted refs with sourceNodeId, compare cited-outside-article vs listed-in-article → Task 1 CTE ✓
- GET endpoint + MCP tool + openapi same PR → Tasks 4 & 5 ✓
- Three verification fixtures → Task 3 ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**3. Type consistency:** `ClassifiedRef` (Task 1) consumed unchanged in Task 2; `ReferenceConsistencyFinding.value` (Task 2) adapted to `section`/`standardCode` in Task 3's `toReferenceFinding`; summary field names (`relatedListedNotCited` etc.) identical in `coordination.ts` (Task 3) and `openapi.yaml` (Task 4) and tests. `classifyScopedRefs(specIds, db)` signature identical across Tasks 1 and 3. ✓

**Open ambiguity resolved (documented, not blocking):** "cited outside an article" — a section cited *inside a different non-Related-Sections article* (e.g. under Quality Assurance) still counts as cited-elsewhere, satisfying A3 and feeding A2. This matches the issue's "cited OUTSIDE [the role] article" framing. No `// KNOWN AMBIGUITY` needed — the rule is unambiguous once stated this way.
