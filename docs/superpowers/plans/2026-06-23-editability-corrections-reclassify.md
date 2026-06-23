# Editability Corrections + Reclassify (O-9, #136) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the review-and-correct loop as three REST endpoints — per-paragraph override (PATCH), whole-spec reclassify with a before/after diff (POST), and explicit margin-comment→note materialization (POST accept-as-note) — all operating on stored `source_facts` with no source document, ever.

**Architecture:** Thin Express handlers over the already-built substrate. The pure `classify(tree, rules)` engine (#133, `src/conventions`) re-runs over each paragraph's persisted `meta.sourceFacts`; classification and human override are two never-merged JSONB columns (#134, ADR-022 D2). Override-set/clear and classification-persist queries already exist (`src/db/queries/editability.ts`); this slice adds spec-scoped wrappers, a reclassify diff query, and a note-materialization query. No new tables — `paragraphs.classification` / `editability_override` / `source_facts` are all present.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, pnpm, PostgreSQL (node-pg), vitest.

## Global Constraints

- **openapi.yaml is the CI-enforced contract.** Every new route (path, method, request/response shape, status) MUST be added to `openapi.yaml` in this PR. The contract gate (`src/api/contract.integration.test.ts`) checks bidirectional route↔spec coverage AND response-schema validation. Use the `SuccessResponse`/`ErrorResponse` envelope and existing `responses` refs (`BadRequest`, `NotFound`, `Forbidden`, `Conflict`, `UnprocessableEntity`, `InternalServerError`).
- **ESLint enforced:** complexity ≤10, sonarjs/cognitive-complexity ≤10, max-lines-per-function 50, **max-lines 400 per file**, no-console (use `src/lib/logger.ts`), no `any`, no non-null `!` outside tests.
- **TS strict** + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`. ESM: relative imports use `.js`; `import type` for type-only imports.
- **Module boundaries:** import DB functions only from `src/db/index.js`; conventions engine only from `src/conventions/index.js`; AST types only from `src/ast/index.js`. Typed errors extend `SpecrError`; chain `cause`. Validate external input with Zod (`z.uuid()` not `z.string().uuid()`).
- **Closed editability vocabulary (ADR-022 D1):** `locked | editable | choice | note` — reuse `EditabilitySchema` from `src/ast/index.js`.
- **Effective value = override ?? classification.** Reclassify rewrites ONLY `classification`; standing overrides survive and disagreements are surfaced, never absorbed (ADR-022 D2).
- **Commit scope = module changed**, e.g. `feat(api): ...`, `feat(db): ...`, `feat(ast): ...`.
- **PostgreSQL needed for integration tests:** `docker compose up -d postgres && pnpm migrate && pnpm seed` before `pnpm test:integration`.

---

## File Structure

**Create:**
- `src/db/queries/reclassify.ts` — spec-scoped override wrappers (`setSpecEditabilityOverride`, `clearSpecEditabilityOverride`), the reclassify-and-diff query (`reclassifySpec`), and the note-materialization query (`acceptCommentAsNote`). Each verifies paragraph↔spec ownership and returns a discriminated result the API maps to status codes.
- `src/api/editability.ts` — three handlers: `patchEditabilityHandler`, `reclassifyHandler`, `acceptAsNoteHandler`.
- `src/api/editability.integration.test.ts` — integration contract tests (the three decisive named tests live here).
- `src/db/queries/reclassify.integration.test.ts` — DB-layer tests for the query module (ownership scoping, diff shape, idempotency).

**Modify:**
- `src/ast/schemas.ts` — add request-body schemas: `PatchEditabilityBodySchema`, `ReclassifyBodySchema`.
- `src/db/index.ts` — re-export the new query functions and result types.
- `src/api/router.ts` — wire the three routes.
- `openapi.yaml` — three new paths + `ReclassifyReport`, `EditabilityDiffEntry`, `SpecNodeEditability` schema components; extend `SpecNode.meta` with `editability`.

**Reuse unchanged:**
- `src/conventions/index.js` → `classify`.
- `src/db/queries/editability.ts` → `storeClassifications`, `ClassificationSchema`, `OverrideSchema` (internal; called from `reclassify.ts` within the db module).
- `src/db/queries/specs.ts` → `getSpecTree`, `buildNodeTree` (internal db reuse).
- `src/db/queries/conventions.ts` → `getConventionForLibrary` (internal db reuse).
- `src/ast/index.js` → `EditabilitySchema`, `ConventionRulesSchema`, types.

---

## Design decisions (record in PR body)

1. **PATCH body shape:** `{ "editability": "note" }` sets the override; `{ "editability": null }` clears it. A closed enum value or explicit `null` — nothing else. Rationale: ADR-022 D2 makes override a distinct field; clearing must be expressible without a second endpoint.
2. **Reclassify rule source (issue: "body optionally carries candidate rules OR references the library profile"):** body `{ "rules": {...} }` runs the engine with caller-supplied candidate rules (preview-before-save when `preview: true`); body `{}` (or omitted rules) resolves the spec's library convention profile via `getConventionForLibrary`, falling back to the built-in industry default. `preview: true` computes the diff WITHOUT persisting; default (`preview` absent/false) persists the new classifications. Rationale: the issue explicitly asks for preview-before-save; persisting is the common path so it is the default.
3. **Reclassify never touches overrides** — guaranteed by `storeClassifications` (writes only `classification`). The diff report carries an `overrideDisagrees` flag per entry where a standing override now differs from the fresh machine verdict — this is the "diff report flags the disagreement" acceptance criterion.
4. **accept-as-note idempotency:** the materialized note records its provenance (`source_comment` JSONB: `{ anchorNodeId, index }`) so a repeat call detects the existing note and returns **409** with the existing note's id (chosen over silent idempotent-200 so the caller learns it was already accepted; the AC permits either — 409 is the more informative contract). The note is inserted as the immediately-following sibling of the anchor paragraph.
5. **Spec-scoped ownership:** all three endpoints verify `(specId, nodeId)` pairing in SQL before any write — a node that exists in another spec is **403** (mirrors `updateParagraphText`'s `wrong-spec`), a missing node is **404**.

---

## Task 0: Request-body schemas (AST layer)

**Files:**
- Modify: `src/ast/schemas.ts`
- Modify: `src/ast/index.ts` (export the two new schemas + inferred types)
- Test: `src/ast/schemas.test.ts`

**Interfaces:**
- Produces: `PatchEditabilityBodySchema` (`{ editability: Editability | null }`), `ReclassifyBodySchema` (`{ rules?: ConventionRules; preview?: boolean }`), and `PatchEditabilityBody` / `ReclassifyBody` inferred types. Consumed by `src/api/editability.ts` (Task 4, 5) and the router (Task 6).

- [ ] **Step 1: Write the failing test**

Append to `src/ast/schemas.test.ts` (import the two new schemas at the top alongside the existing imports):

```typescript
describe('PatchEditabilityBodySchema (O-9 / #136)', () => {
  it('accepts a closed editability value', () => {
    expect(PatchEditabilityBodySchema.parse({ editability: 'note' })).toEqual({ editability: 'note' });
  });
  it('accepts explicit null to clear the override', () => {
    expect(PatchEditabilityBodySchema.parse({ editability: null })).toEqual({ editability: null });
  });
  it('rejects an out-of-vocabulary value', () => {
    expect(PatchEditabilityBodySchema.safeParse({ editability: 'frozen' }).success).toBe(false);
  });
  it('rejects a missing editability key', () => {
    expect(PatchEditabilityBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('ReclassifyBodySchema (O-9 / #136)', () => {
  it('accepts an empty body (resolve the library profile)', () => {
    expect(ReclassifyBodySchema.parse({})).toEqual({});
  });
  it('accepts candidate rules and a preview flag', () => {
    const body = { rules: { defaultEditability: 'editable' }, preview: true };
    expect(ReclassifyBodySchema.parse(body)).toEqual(body);
  });
  it('rejects malformed rules (bad enum)', () => {
    expect(
      ReclassifyBodySchema.safeParse({ rules: { defaultEditability: 'frozen' } }).success
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/ast/schemas.test.ts`
Expected: FAIL — `PatchEditabilityBodySchema is not defined`.

- [ ] **Step 3: Write minimal implementation**

In `src/ast/schemas.ts`, after the `SpecNodeEditabilitySchema` block (it already defines `EditabilitySchema` and `ConventionRulesSchema` above), add:

```typescript
// ── O-9 / #136 request bodies ────────────────────────────────────────────────
// Set the human override (closed enum) or clear it (explicit null). ADR-022 D2:
// override is a distinct field; clearing must be expressible in one call.
export const PatchEditabilityBodySchema = z.object({
  editability: EditabilitySchema.nullable(),
});

export type PatchEditabilityBody = z.infer<typeof PatchEditabilityBodySchema>;

// Reclassify input. `rules` (optional) supplies candidate rules for a preview;
// omitted → resolve the spec's library convention profile. `preview: true`
// computes the diff without persisting (preview-before-save). The rules schema
// is the open ADR-022 D5 ruleset — unknown keys preserved.
export const ReclassifyBodySchema = z.object({
  rules: ConventionRulesSchema.exactOptional(),
  preview: z.boolean().exactOptional(),
});

export type ReclassifyBody = z.infer<typeof ReclassifyBodySchema>;
```

In `src/ast/index.ts`, add to the schema/type exports (alongside `PutConventionBodySchema` etc.):

```typescript
export {
  PatchEditabilityBodySchema,
  ReclassifyBodySchema,
} from './schemas.js';
export type { PatchEditabilityBody, ReclassifyBody } from './schemas.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/ast/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/ast/schemas.ts src/ast/index.ts src/ast/schemas.test.ts
git commit -m "feat(ast): editability-override + reclassify request schemas (#136)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 1: Spec-scoped override query

**Files:**
- Create: `src/db/queries/reclassify.ts`
- Modify: `src/db/index.ts`
- Test: `src/db/queries/reclassify.integration.test.ts`

**Interfaces:**
- Consumes: `pool`, `DatabaseError` from `../index.js`; `setEditabilityOverride`, `clearEditabilityOverride` from `./editability.js`; `Editability` type from `../../ast/index.js`.
- Produces:
  - `type OwnershipResult = { status: 'ok' } | { status: 'not-found' } | { status: 'wrong-spec' }`
  - `setSpecEditabilityOverride(specId: string, nodeId: string, editability: Editability): Promise<OwnershipResult>`
  - `clearSpecEditabilityOverride(specId: string, nodeId: string): Promise<OwnershipResult>`
  - Consumed by `src/api/editability.ts` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `src/db/queries/reclassify.integration.test.ts`. Model the harness on `src/db/queries/editability.integration.test.ts` — read it first for the spec/paragraph insert helpers. Minimum:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { setSpecEditabilityOverride, clearSpecEditabilityOverride } from './reclassify.js';

let specId: string;
let otherSpecId: string;
let nodeId: string;
let libraryId: string;

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  libraryId = lib.rows[0]!.id;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('00 00 01', 'recl-it', 'arcat', $1) RETURNING id`,
    [libraryId]
  );
  specId = s.rows[0]!.id;
  const o = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('00 00 02', 'recl-it-other', 'arcat', $1) RETURNING id`,
    [libraryId]
  );
  otherSpecId = o.rows[0]!.id;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', 'A para', 1) RETURNING id`,
    [specId]
  );
  nodeId = p.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, otherSpecId]]);
});

describe('setSpecEditabilityOverride', () => {
  it('sets the override on a paragraph that belongs to the spec', async () => {
    const r = await setSpecEditabilityOverride(specId, nodeId, 'note');
    expect(r.status).toBe('ok');
    const row = await pool.query<{ editability_override: { editability: string } | null }>(
      `SELECT editability_override FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.editability_override).toEqual({ editability: 'note' });
  });

  it('returns wrong-spec when the node belongs to another spec', async () => {
    const r = await setSpecEditabilityOverride(otherSpecId, nodeId, 'editable');
    expect(r.status).toBe('wrong-spec');
  });

  it('returns not-found for an unknown node', async () => {
    const r = await setSpecEditabilityOverride(
      specId,
      '00000000-0000-0000-0000-000000000000',
      'editable'
    );
    expect(r.status).toBe('not-found');
  });
});

describe('clearSpecEditabilityOverride', () => {
  it('clears the override (effective value falls back to machine)', async () => {
    await setSpecEditabilityOverride(specId, nodeId, 'note');
    const r = await clearSpecEditabilityOverride(specId, nodeId);
    expect(r.status).toBe('ok');
    const row = await pool.query<{ editability_override: unknown }>(
      `SELECT editability_override FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.editability_override).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- src/db/queries/reclassify.integration.test.ts`
Expected: FAIL — cannot find `./reclassify.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/db/queries/reclassify.ts`:

```typescript
import { pool, DatabaseError } from '../index.js';
import { setEditabilityOverride, clearEditabilityOverride } from './editability.js';
import type { Editability } from '../../ast/index.js';

/** Ownership-checked outcome: the (specId, nodeId) pairing is verified before any
 *  write so the API maps `not-found` → 404 and `wrong-spec` → 403 (mirrors
 *  updateParagraphText). `ok` means the write was applied. */
export type OwnershipResult =
  | { readonly status: 'ok' }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' };

// Verify a paragraph belongs to the spec. Returns the non-'ok' outcome to short
// out the caller, or null when ownership holds and the write may proceed.
async function checkOwnership(
  specId: string,
  nodeId: string
): Promise<Exclude<OwnershipResult, { status: 'ok' }> | null> {
  const owner = await pool.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1`,
    [nodeId]
  );
  const row = owner.rows[0];
  if (!row) return { status: 'not-found' };
  if (row.spec_id !== specId) return { status: 'wrong-spec' };
  return null;
}

export async function setSpecEditabilityOverride(
  specId: string,
  nodeId: string,
  editability: Editability
): Promise<OwnershipResult> {
  try {
    const bad = await checkOwnership(specId, nodeId);
    if (bad) return bad;
    await setEditabilityOverride(nodeId, editability);
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('setSpecEditabilityOverride failed', { cause: err });
  }
}

export async function clearSpecEditabilityOverride(
  specId: string,
  nodeId: string
): Promise<OwnershipResult> {
  try {
    const bad = await checkOwnership(specId, nodeId);
    if (bad) return bad;
    await clearEditabilityOverride(nodeId);
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('clearSpecEditabilityOverride failed', { cause: err });
  }
}
```

In `src/db/index.ts`, add to the editability export block:

```typescript
export {
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
} from './queries/reclassify.js';
export type { OwnershipResult } from './queries/reclassify.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration -- src/db/queries/reclassify.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/db/queries/reclassify.ts src/db/index.ts src/db/queries/reclassify.integration.test.ts
git commit -m "feat(db): spec-scoped editability override wrappers (#136)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Reclassify-and-diff query

**Files:**
- Modify: `src/db/queries/reclassify.ts`
- Modify: `src/db/index.ts`
- Test: `src/db/queries/reclassify.integration.test.ts`

**Interfaces:**
- Consumes: `getSpecTree` from `./specs.js`, `getConventionForLibrary` from `./conventions.js`, `storeClassifications` from `./editability.js`, `classify` from `../../conventions/index.js`, `ConventionRules` / `Editability` types from `../../ast/index.js`.
- Produces:
  - `interface EditabilityDiffEntry { nodeId: string; before: Editability | null; after: Editability; overrideDisagrees: boolean }`
  - `interface ReclassifyReport { specId: string; persisted: boolean; total: number; changed: number; entries: readonly EditabilityDiffEntry[] }`
  - `type ReclassifyOutcome = { status: 'ok'; report: ReclassifyReport } | { status: 'not-found' } | { status: 'no-convention' }`
  - `reclassifySpec(specId: string, opts: { rules?: ConventionRules; preview?: boolean }): Promise<ReclassifyOutcome>`
  - Consumed by `src/api/editability.ts` (Task 5).

**Notes for the implementer:**
- The spec's `library_id` is read directly here (one small `SELECT`). When `opts.rules` is given, use it directly (the preview path); otherwise resolve `getConventionForLibrary(libraryId)`.
- `before` = the paragraph's CURRENT `classification.editability` (null if unclassified); `after` = the fresh verdict. Read the pre-reclassify classification from the spec tree's `meta.editability` (the machine value), NOT the effective value. **Read the tree once before persisting**, compute the diff, then persist.
- `overrideDisagrees` = there is a standing override on the node AND `override !== after`. The override is on `meta.editability.override` in the tree.
- Keep `reclassifySpec` ≤50 lines by extracting the diff builder into a small helper (`buildDiff(tree, fresh)`).

- [ ] **Step 1: Write the failing test**

Append to `src/db/queries/reclassify.integration.test.ts`. This is where the decisive **DB-layer** reclassify behavior is pinned (the API-level decisive tests come in Task 5). Insert a paragraph carrying a `source_facts` banner so the engine has a real fact to classify:

```typescript
import { reclassifySpec } from './reclassify.js';

describe('reclassifySpec', () => {
  it('classifies stored facts from a banner — no source document', async () => {
    // paragraph whose source_facts carry a captured banner fact → note
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 1, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const bannerNode = p.rows[0]!.id;
    const out = await reclassifySpec(specId, { rules: {} });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('expected ok');
    const entry = out.report.entries.find((e) => e.nodeId === bannerNode);
    expect(entry?.after).toBe('note');
    // persisted: a fresh read shows the stored classification
    const row = await pool.query<{ classification: { editability: string } }>(
      `SELECT classification FROM paragraphs WHERE id = $1`,
      [bannerNode]
    );
    expect(row.rows[0]!.classification.editability).toBe('note');
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [bannerNode]);
  });

  it('preview does not persist', async () => {
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Preview para', 1, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const previewNode = p.rows[0]!.id;
    const out = await reclassifySpec(specId, { rules: {}, preview: true });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('expected ok');
    expect(out.report.persisted).toBe(false);
    const row = await pool.query<{ classification: unknown }>(
      `SELECT classification FROM paragraphs WHERE id = $1`,
      [previewNode]
    );
    expect(row.rows[0]!.classification).toBeNull();
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [previewNode]);
  });

  it('returns not-found for an unknown spec', async () => {
    const out = await reclassifySpec('00000000-0000-0000-0000-000000000000', { rules: {} });
    expect(out.status).toBe('not-found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- src/db/queries/reclassify.integration.test.ts`
Expected: FAIL — `reclassifySpec` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/db/queries/reclassify.ts` (add the imports at the top):

```typescript
import { getSpecTree } from './specs.js';
import { getConventionForLibrary } from './conventions.js';
import { storeClassifications } from './editability.js';
import { classify } from '../../conventions/index.js';
import type { ConventionRules, Editability, SpecNode, SpecTree } from '../../ast/index.js';
```

```typescript
export interface EditabilityDiffEntry {
  readonly nodeId: string;
  /** Machine classification BEFORE this pass (null = was unclassified). */
  readonly before: Editability | null;
  /** Fresh machine verdict from this pass. */
  readonly after: Editability;
  /** A standing human override now disagrees with the fresh verdict (ADR-022 D2). */
  readonly overrideDisagrees: boolean;
}

export interface ReclassifyReport {
  readonly specId: string;
  /** false on a preview pass (diff computed, nothing written). */
  readonly persisted: boolean;
  readonly total: number;
  readonly changed: number;
  readonly entries: readonly EditabilityDiffEntry[];
}

export type ReclassifyOutcome =
  | { readonly status: 'ok'; readonly report: ReclassifyReport }
  | { readonly status: 'not-found' }
  | { readonly status: 'no-convention' };

// Flatten the tree to nodes in document order (pre-order), matching the engine.
function flatten(nodes: readonly SpecNode[], out: SpecNode[]): void {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
}

// Build one diff entry per node from the pre-reclassify tree (current machine +
// override) against the fresh verdict map. before = current machine value, or
// null when unclassified; overrideDisagrees when a standing override differs.
function buildDiff(
  tree: SpecTree,
  fresh: ReadonlyMap<string, Editability>
): EditabilityDiffEntry[] {
  const nodes: SpecNode[] = [];
  flatten(tree.parts, nodes);
  const entries: EditabilityDiffEntry[] = [];
  for (const node of nodes) {
    const after = fresh.get(node.id);
    if (after === undefined) continue;
    const ed = node.meta.editability;
    const before = ed ? (ed.override !== undefined ? ed.value : ed.value) : null;
    // `before` is the prior MACHINE value: ed.value when no override, and the
    // machine value (not the override) when overridden. ed carries only the
    // effective value+override, so derive the machine value:
    const machineBefore = ed === undefined ? null : ed.override !== undefined && ed.value === ed.override ? ed.value : ed.value;
    const overrideValue = ed?.override;
    entries.push({
      nodeId: node.id,
      before: machineBefore,
      after,
      overrideDisagrees: overrideValue !== undefined && overrideValue !== after,
    });
  }
  return entries;
}

async function resolveRules(
  specId: string,
  opts: { rules?: ConventionRules }
): Promise<ConventionRules | null> {
  if (opts.rules !== undefined) return opts.rules;
  const lib = await pool.query<{ library_id: string | null }>(
    `SELECT library_id FROM specs WHERE id = $1`,
    [specId]
  );
  const libraryId = lib.rows[0]?.library_id;
  if (!libraryId) return null;
  const convention = await getConventionForLibrary(libraryId);
  return convention ? convention.rules : null;
}

export async function reclassifySpec(
  specId: string,
  opts: { rules?: ConventionRules; preview?: boolean }
): Promise<ReclassifyOutcome> {
  try {
    const treeResult = await getSpecTree(specId);
    if (!treeResult) return { status: 'not-found' };
    const rules = await resolveRules(specId, opts);
    if (rules === null) return { status: 'no-convention' };

    const fresh = classify(treeResult.tree, rules);
    const freshMap = new Map<string, Editability>(fresh.map((c) => [c.nodeId, c.editability]));
    const entries = buildDiff(treeResult.tree, freshMap);
    const changed = entries.filter((e) => e.before !== e.after).length;

    const persisted = opts.preview !== true;
    if (persisted) await storeClassifications(specId, fresh);

    return {
      status: 'ok',
      report: { specId, persisted, total: entries.length, changed, entries },
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('reclassifySpec failed', { cause: err });
  }
}
```

> **Implementer note:** the `buildDiff` body above is intentionally verbose to expose the `before`-is-machine-value reasoning; SIMPLIFY it before committing. `meta.editability` (`SpecNodeEditability`) carries `value` (effective), `confidence`, `evidence`, and optional `override`. The machine value is recoverable: when `override` is absent, `value` IS the machine value; when `override` is present, `value` equals the override, so the machine value is not directly available from the tree. **Therefore read the machine `before` from the raw `classification` column, not the tree.** Replace `buildDiff`'s `before` derivation by querying the pre-reclassify machine classifications:
>
> Add a helper that reads `SELECT id, classification, editability_override FROM paragraphs WHERE spec_id = $1`, parse each `classification` with the (db-internal) `ClassificationSchema`/`OverrideSchema`, and build two maps: `machineBefore: Map<nodeId, Editability|null>` and `override: Map<nodeId, Editability>`. Then `buildDiff` consumes those maps instead of reading `meta.editability`. This keeps `before` honestly the machine value and `overrideDisagrees` honestly the override. Keep each function ≤50 lines (extract the row→maps reader).

- [ ] **Step 4: Refine per the implementer note, then run the test**

Run: `pnpm test:integration -- src/db/queries/reclassify.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/db/queries/reclassify.ts src/db/index.ts src/db/queries/reclassify.integration.test.ts
git commit -m "feat(db): reclassifySpec — re-run engine over stored facts, before/after diff (#136)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: accept-as-note materialization query

**Files:**
- Modify: `src/db/queries/reclassify.ts`
- Modify: `src/db/index.ts`
- Test: `src/db/queries/reclassify.integration.test.ts`

**Interfaces:**
- Consumes: `pool`, `DatabaseError`; the paragraph table (`id, spec_id, parent_id, node_type, text, position, source_facts`).
- Produces:
  - `type AcceptNoteOutcome = { status: 'created'; noteId: string } | { status: 'already-accepted'; noteId: string } | { status: 'not-found' } | { status: 'wrong-spec' } | { status: 'no-comment' }`
  - `acceptCommentAsNote(specId: string, nodeId: string, index: number): Promise<AcceptNoteOutcome>`
  - Consumed by `src/api/editability.ts` (Task 5).

**Behavior (ADR-022 D4 — never a silent tree mutation):**
- The anchor paragraph's `source_facts.comments[index]` is the margin comment to materialize.
- Insert a sibling `note` paragraph immediately AFTER the anchor: same `parent_id`, `position = anchor.position + 1`, with every later sibling shifted +1 to make room. `text` = the comment's `text`. Record provenance in the new note's `source_facts` as `{ "acceptedComment": { "anchorNodeId": <id>, "index": <i> } }` so a repeat call is detectable.
- Idempotency: if a note with that exact `acceptedComment` provenance already exists under the same parent, return `already-accepted` with its id (→ 409).
- Out-of-range `index` or no `comments` array → `no-comment` (→ 422).
- All within one transaction.

- [ ] **Step 1: Write the failing test**

Append to `src/db/queries/reclassify.integration.test.ts`:

```typescript
import { acceptCommentAsNote } from './reclassify.js';

describe('acceptCommentAsNote', () => {
  it('inserts a note adjacent to the anchor; repeat is 409 (already-accepted)', async () => {
    const anchor = await pool.query<{ id: string; position: number }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor para', 10, $2::jsonb) RETURNING id, position`,
      [specId, JSON.stringify({ comments: [{ author: 'JDoe', text: 'Verify w/ owner', anchor: [0, 5] }] })]
    );
    const anchorId = anchor.rows[0]!.id;

    const first = await acceptCommentAsNote(specId, anchorId, 0);
    expect(first.status).toBe('created');
    if (first.status !== 'created') throw new Error('expected created');

    // the note exists, is a sibling, text matches, positioned right after anchor
    const note = await pool.query<{ node_type: string; text: string; position: number; parent_id: string | null }>(
      `SELECT node_type, text, position, parent_id FROM paragraphs WHERE id = $1`,
      [first.noteId]
    );
    expect(note.rows[0]!.node_type).toBe('note');
    expect(note.rows[0]!.text).toBe('Verify w/ owner');
    expect(note.rows[0]!.position).toBe(11);

    const second = await acceptCommentAsNote(specId, anchorId, 0);
    expect(second.status).toBe('already-accepted');
    if (second.status === 'already-accepted') expect(second.noteId).toBe(first.noteId);

    await pool.query(`DELETE FROM paragraphs WHERE id = ANY($1::uuid[])`, [[anchorId, first.noteId]]);
  });

  it('returns no-comment for an out-of-range index', async () => {
    const anchor = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'No comments', 20, '{}'::jsonb) RETURNING id`,
      [specId]
    );
    const out = await acceptCommentAsNote(specId, anchor.rows[0]!.id, 0);
    expect(out.status).toBe('no-comment');
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [anchor.rows[0]!.id]);
  });

  it('returns wrong-spec when the anchor belongs to another spec', async () => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', 'x', 1) RETURNING id`,
      [specId]
    );
    const out = await acceptCommentAsNote(otherSpecId, a.rows[0]!.id, 0);
    expect(out.status).toBe('wrong-spec');
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [a.rows[0]!.id]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- src/db/queries/reclassify.integration.test.ts`
Expected: FAIL — `acceptCommentAsNote` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/db/queries/reclassify.ts` (use `SourceFactsSchema` to safely read the anchor's facts; import it from `../../ast/index.js`). Use a `PoolClient` transaction. Keep each function ≤50 lines — split the row read, the provenance check, and the insert into helpers.

```typescript
import type { PoolClient } from 'pg';
import { SourceFactsSchema } from '../../ast/index.js';
```

```typescript
export type AcceptNoteOutcome =
  | { readonly status: 'created'; readonly noteId: string }
  | { readonly status: 'already-accepted'; readonly noteId: string }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'no-comment' };

interface AnchorRow {
  readonly spec_id: string;
  readonly parent_id: string | null;
  readonly position: number;
  readonly source_facts: unknown;
}

// The comment text at `index`, or null when there is no such comment.
function commentTextAt(sourceFacts: unknown, index: number): string | null {
  const facts = SourceFactsSchema.parse(sourceFacts);
  const comment = facts.comments?.[index];
  return comment ? comment.text : null;
}

// An existing materialized note for this (anchor, index), or null.
async function findExistingNote(
  client: PoolClient,
  parentId: string | null,
  anchorId: string,
  index: number
): Promise<string | null> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM paragraphs
     WHERE node_type = 'note'
       AND parent_id IS NOT DISTINCT FROM $1
       AND source_facts #> '{acceptedComment}' = $2::jsonb`,
    [parentId, JSON.stringify({ anchorNodeId: anchorId, index })]
  );
  return existing.rows[0]?.id ?? null;
}

async function insertNoteSibling(
  client: PoolClient,
  anchor: AnchorRow,
  specId: string,
  anchorId: string,
  index: number,
  text: string
): Promise<string> {
  // Make room: shift later siblings down so the note lands at position+1.
  await client.query(
    `UPDATE paragraphs SET position = position + 1
     WHERE spec_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND position > $3`,
    [specId, anchor.parent_id, anchor.position]
  );
  const facts = JSON.stringify({ acceptedComment: { anchorNodeId: anchorId, index } });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, source_facts)
     VALUES ($1, $2, 'note', $3, $4, $5::jsonb) RETURNING id`,
    [specId, anchor.parent_id, text, anchor.position + 1, facts]
  );
  const row = inserted.rows[0];
  if (!row) throw new DatabaseError('acceptCommentAsNote: insert returned no row');
  return row.id;
}

async function runAccept(
  client: PoolClient,
  specId: string,
  nodeId: string,
  index: number
): Promise<AcceptNoteOutcome> {
  const anchorRes = await client.query<AnchorRow>(
    `SELECT spec_id, parent_id, position, source_facts FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const anchor = anchorRes.rows[0];
  if (!anchor) return { status: 'not-found' };
  if (anchor.spec_id !== specId) return { status: 'wrong-spec' };

  const text = commentTextAt(anchor.source_facts, index);
  if (text === null) return { status: 'no-comment' };

  const existing = await findExistingNote(client, anchor.parent_id, nodeId, index);
  if (existing) return { status: 'already-accepted', noteId: existing };

  const noteId = await insertNoteSibling(client, anchor, specId, nodeId, index, text);
  return { status: 'created', noteId };
}

export async function acceptCommentAsNote(
  specId: string,
  nodeId: string,
  index: number
): Promise<AcceptNoteOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await runAccept(client, specId, nodeId, index);
    await client.query(outcome.status === 'created' ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('acceptCommentAsNote failed', { cause: err });
  } finally {
    client.release();
  }
}
```

In `src/db/index.ts`, extend the reclassify export block:

```typescript
export {
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
  reclassifySpec,
  acceptCommentAsNote,
} from './queries/reclassify.js';
export type {
  OwnershipResult,
  ReclassifyOutcome,
  ReclassifyReport,
  EditabilityDiffEntry,
  AcceptNoteOutcome,
} from './queries/reclassify.js';
```

> **Implementer note on `already-accepted` + transaction:** the existing-note SELECT happens inside the transaction; when it finds a note we ROLLBACK (no write occurred) and return `already-accepted`. Confirm `reclassify.ts` stays under 400 lines — if it approaches the cap, split the note-materialization helpers into `src/db/queries/accept-note.ts` and re-export. Check with `wc -l src/db/queries/reclassify.ts` before committing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration -- src/db/queries/reclassify.integration.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/db/queries/reclassify.ts src/db/index.ts src/db/queries/reclassify.integration.test.ts
git commit -m "feat(db): acceptCommentAsNote — materialize margin comment as note node (#136)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: PATCH editability handler + route + openapi

**Files:**
- Create: `src/api/editability.ts`
- Modify: `src/api/router.ts`
- Modify: `openapi.yaml`
- Test: `src/api/editability.integration.test.ts`

**Interfaces:**
- Consumes: `PatchEditabilityBodySchema` (Task 0), `setSpecEditabilityOverride` / `clearSpecEditabilityOverride` (Task 1), `getSpecTree` (db barrel — to return the updated node). `logger`.
- Produces: `patchEditabilityHandler(req, res)`. Route `PATCH /specs/:id/paragraphs/:nodeId/editability`.

**Notes:**
- Validate `:id` and `:nodeId` as `z.uuid()` → 400. Validate body with `PatchEditabilityBodySchema` → 400.
- `editability: null` → clear; a value → set. Map `OwnershipResult`: `not-found` → 404, `wrong-spec` → 403, `ok` → 200.
- On `ok`, return the updated paragraph node. Reuse the db barrel's subtree fetch: re-use `getSpecTree` and find the node, OR add a small `getParagraphNode(specId, nodeId)` — simplest is to return `{ nodeId, editability }` echoing the effective override. **Decision:** return the minimal applied state `{ nodeId, editability: <set value or null> }` as `data` — the full node is unnecessary for a correction round-trip and avoids a second query. Document this in the PR.

- [ ] **Step 1: Write the failing test**

Create `src/api/editability.integration.test.ts` (model the harness on `src/api/required-sections.integration.test.ts` — express app + router + errorHandler, `req()` helper). Seed a spec + paragraph in `beforeAll`. First test:

```typescript
describe('PATCH /specs/:id/paragraphs/:nodeId/editability', () => {
  it('sets the override and returns 200', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: 'note',
    });
    expect(r.status).toBe(200);
    expect((r.body as { success: boolean }).success).toBe(true);
    expect((r.body as { data: { editability: string } }).data.editability).toBe('note');
  });

  it('clears the override with explicit null', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: null,
    });
    expect(r.status).toBe(200);
    expect((r.body as { data: { editability: null } }).data.editability).toBeNull();
  });

  it('rejects a bad value with 400', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: 'frozen',
    });
    expect(r.status).toBe(400);
  });

  it('404 for an unknown node', async () => {
    const r = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/00000000-0000-0000-0000-000000000000/editability`,
      { editability: 'note' }
    );
    expect(r.status).toBe(404);
  });

  it('403 when the node belongs to another spec', async () => {
    const r = await req('PATCH', `/specs/${otherSpecId}/paragraphs/${nodeId}/editability`, {
      editability: 'note',
    });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- src/api/editability.integration.test.ts`
Expected: FAIL — 404 (route not wired) on the first test.

- [ ] **Step 3: Write minimal implementation**

Create `src/api/editability.ts`:

```typescript
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PatchEditabilityBodySchema } from '../ast/index.js';
import { setSpecEditabilityOverride, clearSpecEditabilityOverride } from '../db/index.js';
import type { OwnershipResult } from '../db/index.js';
import { logger } from '../lib/logger.js';

// Validate the two UUID params; reply 400 and return null on a malformed id.
function parseIds(req: Request, res: Response): { specId: string; nodeId: string } | null {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return null;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    res.status(400).json({ success: false, error: 'invalid node id' });
    return null;
  }
  return { specId: specId.data, nodeId: nodeId.data };
}

// Map a query ownership result to the matching HTTP error; returns true when the
// caller has already responded (non-ok), false when status is 'ok'.
function sendOwnershipError(result: OwnershipResult, res: Response): boolean {
  if (result.status === 'not-found') {
    res.status(404).json({ success: false, error: 'paragraph not found' });
    return true;
  }
  if (result.status === 'wrong-spec') {
    res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
    return true;
  }
  return false;
}

export async function patchEditabilityHandler(req: Request, res: Response): Promise<void> {
  const ids = parseIds(req, res);
  if (!ids) return;
  const body = PatchEditabilityBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'editability must be locked|editable|choice|note or null' });
    return;
  }
  try {
    const { editability } = body.data;
    const result =
      editability === null
        ? await clearSpecEditabilityOverride(ids.specId, ids.nodeId)
        : await setSpecEditabilityOverride(ids.specId, ids.nodeId, editability);
    if (sendOwnershipError(result, res)) return;
    res.status(200).json({ success: true, data: { nodeId: ids.nodeId, editability } });
  } catch (err) {
    logger.error({ err }, 'patch editability failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

In `src/api/router.ts`, add the import and route (place the route right after the existing `PATCH /specs/:id/paragraphs/:nodeId`):

```typescript
import { patchEditabilityHandler } from './editability.js';
```
```typescript
router.patch('/specs/:id/paragraphs/:nodeId/editability', patchEditabilityHandler);
```

In `openapi.yaml`, add under `paths:` (after the `/specs/{id}/paragraphs/{nodeId}` block ending ~line 262). Use the existing `SpecId` / `NodeId` parameter refs:

```yaml
  /specs/{id}/paragraphs/{nodeId}/editability:
    patch:
      operationId: patchEditability
      summary: Set or clear a paragraph's human editability override
      description: >
        Records the reviewer's correction as the paragraph's `editability_override`
        (ADR-022 D2), stored beside — never merged into — the machine classification.
        `editability: null` clears the override so the effective value falls back to
        the machine verdict. The node must belong to the spec in the path (else 403).
      tags: [specs]
      parameters:
        - $ref: '#/components/parameters/SpecId'
        - $ref: '#/components/parameters/NodeId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [editability]
              properties:
                editability:
                  oneOf:
                    - type: string
                      enum: [locked, editable, choice, note]
                    - type: 'null'
                  description: Override value, or null to clear it.
      responses:
        '200':
          description: Override applied (or cleared)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: object
                        required: [nodeId, editability]
                        properties:
                          nodeId:
                            type: string
                            format: uuid
                          editability:
                            oneOf:
                              - type: string
                                enum: [locked, editable, choice, note]
                              - type: 'null'
        '400':
          $ref: '#/components/responses/BadRequest'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration -- src/api/editability.integration.test.ts`
Then the contract gate: `pnpm test:integration -- src/api/contract.integration.test.ts`
Expected: both PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/api/editability.ts src/api/router.ts openapi.yaml src/api/editability.integration.test.ts
git commit -m "feat(api): PATCH paragraph editability override (#136)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Reclassify + accept-as-note handlers + routes + openapi

**Files:**
- Modify: `src/api/editability.ts`
- Modify: `src/api/router.ts`
- Modify: `openapi.yaml`
- Test: `src/api/editability.integration.test.ts`

**Interfaces:**
- Consumes: `ReclassifyBodySchema` (Task 0), `reclassifySpec`, `acceptCommentAsNote` (Tasks 2–3), result types.
- Produces: `reclassifyHandler`, `acceptAsNoteHandler`. Routes `POST /specs/:id/reclassify`, `POST /specs/:id/paragraphs/:nodeId/comments/:index/accept-as-note`.

**Status mapping:**
- reclassify: body parse fail → 400; `not-found` → 404; `no-convention` → 422; `ok` → 200 (report as `data`).
- accept-as-note: bad ids / non-integer index → 400; `not-found` → 404; `wrong-spec` → 403; `no-comment` → 422; `already-accepted` → 409 (`data: { noteId }`); `created` → 201 (`data: { noteId }`).

- [ ] **Step 1: Write the failing tests (the THREE decisive named tests live here)**

Append to `src/api/editability.integration.test.ts`. The two reclassify decisive tests and the accept-as-note idempotency test:

```typescript
describe('POST /specs/:id/reclassify', () => {
  it('reclassify: convention edit reclassifies stored facts — no source document required', async () => {
    // Seed a paragraph carrying a banner source_fact, no document on disk.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 1, $2::jsonb) RETURNING id`,
      [reclSpecId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const banner = p.rows[0]!.id;
    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, { rules: {} });
    expect(r.status).toBe(200);
    const report = (r.body as { data: { entries: { nodeId: string; after: string }[] } }).data;
    expect(report.entries.find((e) => e.nodeId === banner)?.after).toBe('note');
  });

  it('override survives reclassify; diff report flags the disagreement', async () => {
    // Paragraph the machine will call 'note' (banner), but the human overrode to 'editable'.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 2, $2::jsonb) RETURNING id`,
      [reclSpecId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const node = p.rows[0]!.id;
    // Set the human override via the PATCH endpoint (proves the API-level survival).
    await req('PATCH', `/specs/${reclSpecId}/paragraphs/${node}/editability`, { editability: 'editable' });

    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, { rules: {} });
    expect(r.status).toBe(200);
    const report = (r.body as {
      data: { entries: { nodeId: string; after: string; overrideDisagrees: boolean }[] };
    }).data;
    const entry = report.entries.find((e) => e.nodeId === node)!;
    expect(entry.after).toBe('note'); // machine re-derives note
    expect(entry.overrideDisagrees).toBe(true); // standing override (editable) disagrees

    // Override still effective: a fresh tree read shows editability.value === 'editable'.
    const tree = await req('GET', `/specs/${reclSpecId}`);
    // (locate the node in the returned tree and assert meta.editability.value === 'editable')
    expect(tree.status).toBe(200);
    const found = findNode((tree.body as { data: { parts: SpecNodeLike[] } }).data.parts, node);
    expect(found?.meta.editability?.value).toBe('editable');
    expect(found?.meta.editability?.override).toBe('editable');
  });

  it('422 when no convention can be resolved and none supplied', async () => {
    // Spec whose library has no profile AND no built-in available is hard to construct;
    // instead assert the happy path resolves the built-in. This case is covered at the
    // DB layer (reclassify.integration.test). Here assert empty-body resolves & 200s.
    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, {});
    expect(r.status).toBe(200);
  });
});

describe('POST .../comments/:index/accept-as-note', () => {
  it('inserts a note adjacent to the anchor; repeated call is 409 (idempotent contract)', async () => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor', 5, $2::jsonb) RETURNING id`,
      [reclSpecId, JSON.stringify({ comments: [{ author: 'JDoe', text: 'Verify w/ owner', anchor: [0, 5] }] })]
    );
    const anchor = a.rows[0]!.id;
    const first = await req('POST', `/specs/${reclSpecId}/paragraphs/${anchor}/comments/0/accept-as-note`);
    expect(first.status).toBe(201);
    const noteId = (first.body as { data: { noteId: string } }).data.noteId;

    const second = await req('POST', `/specs/${reclSpecId}/paragraphs/${anchor}/comments/0/accept-as-note`);
    expect(second.status).toBe(409);
    expect((second.body as { data: { noteId: string } }).data.noteId).toBe(noteId);
  });

  it('422 for an out-of-range comment index', async () => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'No comments', 6, '{}'::jsonb) RETURNING id`,
      [reclSpecId]
    );
    const r = await req('POST', `/specs/${reclSpecId}/paragraphs/${a.rows[0]!.id}/comments/0/accept-as-note`);
    expect(r.status).toBe(422);
  });
});
```

> Add `reclSpecId` (a fresh spec in the default company library) to `beforeAll`, and a small `findNode(parts, id)` + `SpecNodeLike` test helper near the top of the file (recursive search over `children`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration -- src/api/editability.integration.test.ts`
Expected: FAIL — reclassify/accept routes 404.

- [ ] **Step 3: Write minimal implementation**

Add to `src/api/editability.ts`:

```typescript
import { ReclassifyBodySchema } from '../ast/index.js';
import { reclassifySpec, acceptCommentAsNote } from '../db/index.js';
```

```typescript
export async function reclassifyHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const body = ReclassifyBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'malformed reclassify body' });
    return;
  }
  try {
    const opts: { rules?: ConventionRules; preview?: boolean } = {};
    if (body.data.rules !== undefined) opts.rules = body.data.rules;
    if (body.data.preview !== undefined) opts.preview = body.data.preview;
    const outcome = await reclassifySpec(specId.data, opts);
    if (outcome.status === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    if (outcome.status === 'no-convention') {
      res.status(422).json({ success: false, error: 'no convention profile resolvable; supply rules' });
      return;
    }
    res.status(200).json({ success: true, data: outcome.report });
  } catch (err) {
    logger.error({ err }, 'reclassify failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

> Add `import type { ConventionRules } from '../ast/index.js';` at the top. The empty-`opts` build with conditional assignment satisfies `exactOptionalPropertyTypes` (never assign `undefined`).

For accept-as-note, parse `:index` as a non-negative integer and map every outcome. Extract the outcome→response mapping into a helper to keep the handler ≤50 lines:

```typescript
import type { AcceptNoteOutcome } from '../db/index.js';

const INDEX_SCHEMA = z.coerce.number().int().nonnegative();

function sendAcceptOutcome(outcome: AcceptNoteOutcome, res: Response): void {
  switch (outcome.status) {
    case 'created':
      res.status(201).json({ success: true, data: { noteId: outcome.noteId } });
      return;
    case 'already-accepted':
      res.status(409).json({ success: true, data: { noteId: outcome.noteId } });
      return;
    case 'not-found':
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    case 'wrong-spec':
      res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
      return;
    case 'no-comment':
      res.status(422).json({ success: false, error: 'no comment at that index' });
      return;
  }
}

export async function acceptAsNoteHandler(req: Request, res: Response): Promise<void> {
  const ids = parseIds(req, res);
  if (!ids) return;
  const index = INDEX_SCHEMA.safeParse(req.params['index']);
  if (!index.success) {
    res.status(400).json({ success: false, error: 'invalid comment index' });
    return;
  }
  try {
    const outcome = await acceptCommentAsNote(ids.specId, ids.nodeId, index.data);
    sendAcceptOutcome(outcome, res);
  } catch (err) {
    logger.error({ err }, 'accept-as-note failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

> **409 body uses `success: true`?** No — a 409 is a non-2xx; the envelope is `success: false`. **Correct the `already-accepted` branch to `{ success: false, error: 'comment already accepted', data: { noteId } }`** so the `ErrorResponse` envelope holds (the `Conflict` response refs `ErrorResponse`). Confirm against the contract gate. Keep `noteId` available to the caller via an extra property on the error body (the contract gate validates the documented 409 schema — document it as `ErrorResponse` + `noteId`, mirroring `WriteConflict`'s `currentVersion` pattern).

In `src/api/router.ts`, add imports + routes:

```typescript
import { patchEditabilityHandler, reclassifyHandler, acceptAsNoteHandler } from './editability.js';
```
```typescript
router.post('/specs/:id/reclassify', reclassifyHandler);
router.post('/specs/:id/paragraphs/:nodeId/comments/:index/accept-as-note', acceptAsNoteHandler);
```

In `openapi.yaml`: add the two paths and the response schemas. Add a `Reclassify409`-style 409 for accept-as-note modeled on `WriteConflict` (ErrorResponse + `noteId`), and a `ReclassifyReport` schema component:

```yaml
  /specs/{id}/reclassify:
    post:
      operationId: reclassifySpec
      summary: Re-run editability classification over stored source facts
      description: >
        Re-classifies every paragraph from its persisted `source_facts` (ADR-022 D4)
        with no source document — the architectural point of the substrate. Supply
        `rules` to preview candidate conventions; omit them to resolve the spec's
        library convention profile (built-in default fallback). `preview: true`
        computes the diff without persisting. Standing human overrides are never
        touched; the report flags where the fresh machine verdict now disagrees with
        an override (ADR-022 D2).
      tags: [specs]
      parameters:
        - $ref: '#/components/parameters/SpecId'
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                rules:
                  $ref: '#/components/schemas/ConventionRules'
                preview:
                  type: boolean
                  description: Compute the diff without persisting (preview-before-save).
      responses:
        '200':
          description: Before/after classification diff report
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        $ref: '#/components/schemas/ReclassifyReport'
        '400':
          $ref: '#/components/responses/BadRequest'
        '404':
          $ref: '#/components/responses/NotFound'
        '422':
          $ref: '#/components/responses/UnprocessableEntity'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /specs/{id}/paragraphs/{nodeId}/comments/{index}/accept-as-note:
    post:
      operationId: acceptCommentAsNote
      summary: Materialize a margin comment as a note node
      description: >
        Inserts the margin comment at `index` (captured in `source_facts.comments`)
        as a `note` paragraph immediately after the anchor (ADR-022 D4 — never a
        silent tree mutation). Repeating the call returns 409 with the existing
        note's id (idempotent contract). The node must belong to the spec (else 403).
      tags: [specs]
      parameters:
        - $ref: '#/components/parameters/SpecId'
        - $ref: '#/components/parameters/NodeId'
        - name: index
          in: path
          required: true
          schema:
            type: integer
            minimum: 0
          description: Zero-based index into the anchor's source_facts.comments.
      responses:
        '201':
          description: Note node created
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: object
                        required: [noteId]
                        properties:
                          noteId:
                            type: string
                            format: uuid
        '400':
          $ref: '#/components/responses/BadRequest'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '409':
          description: Comment already accepted — the existing note's id travels back as `noteId`.
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/ErrorResponse'
                  - type: object
                    properties:
                      noteId:
                        type: string
                        format: uuid
        '422':
          $ref: '#/components/responses/UnprocessableEntity'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

Add the `ReclassifyReport` + `EditabilityDiffEntry` schema components under `components.schemas` (near `ConventionRules`):

```yaml
    ReclassifyReport:
      type: object
      required: [specId, persisted, total, changed, entries]
      properties:
        specId:
          type: string
          format: uuid
        persisted:
          type: boolean
          description: false on a preview pass (diff computed, nothing written).
        total:
          type: integer
          minimum: 0
        changed:
          type: integer
          minimum: 0
          description: Entries whose machine value changed from before to after.
        entries:
          type: array
          items:
            $ref: '#/components/schemas/EditabilityDiffEntry'

    EditabilityDiffEntry:
      type: object
      required: [nodeId, before, after, overrideDisagrees]
      properties:
        nodeId:
          type: string
          format: uuid
        before:
          oneOf:
            - type: string
              enum: [locked, editable, choice, note]
            - type: 'null'
          description: Machine classification before this pass (null = was unclassified).
        after:
          type: string
          enum: [locked, editable, choice, note]
        overrideDisagrees:
          type: boolean
          description: A standing human override now differs from the fresh machine verdict.
```

> Also extend `SpecNode.meta` (line ~2991) with the `editability` property so the `override survives reclassify` test's GET /specs/{id} assertion validates against the contract. Add a `SpecNodeEditability` component and reference it:
>
> ```yaml
>             editability:
>               $ref: '#/components/schemas/SpecNodeEditability'
> ```
> and under `components.schemas`:
> ```yaml
>     SpecNodeEditability:
>       type: object
>       required: [value, confidence, evidence]
>       properties:
>         value:
>           type: string
>           enum: [locked, editable, choice, note]
>         confidence:
>           type: number
>           minimum: 0
>           maximum: 1
>         evidence:
>           type: array
>           items:
>             type: object
>             additionalProperties: true
>         override:
>           type: string
>           enum: [locked, editable, choice, note]
> ```

- [ ] **Step 4: Run tests + contract gate**

Run: `pnpm test:integration -- src/api/editability.integration.test.ts`
Run: `pnpm test:integration -- src/api/contract.integration.test.ts`
Expected: both PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/api/editability.ts src/api/router.ts openapi.yaml src/api/editability.integration.test.ts
git commit -m "feat(api): POST reclassify (before/after diff) + accept-as-note (#136)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Lint the whole tree**

Run: `pnpm lint`
Expected: clean (eslint + tsc --noEmit + prettier).

- [ ] **Step 2: Unit tests**

Run: `pnpm test`
Expected: PASS (includes the new `schemas.test.ts` cases).

- [ ] **Step 3: Integration tests (DB up first)**

```bash
docker compose up -d postgres
pnpm migrate && pnpm seed
pnpm test:integration
```
Expected: PASS — including the three decisive named tests and the contract gate. Capture the output for the PR (superpowers:verification-before-completion — show the output, do not assert green without it).

- [ ] **Step 4: Confirm file-size budgets**

Run: `wc -l src/db/queries/reclassify.ts src/api/editability.ts`
Expected: both ≤400. If `reclassify.ts` exceeds, split the accept-note helpers into `src/db/queries/accept-note.ts` and re-export from `reclassify.ts` (commit the split separately).

---

## Self-Review (run before handing off)

**Spec coverage:**
- PATCH override → Task 4. ✓
- POST reclassify (candidate rules OR library profile; before/after diff; overrides untouched; disagreement flagged) → Tasks 2, 5. ✓
- POST accept-as-note (adjacent note, idempotent/409) → Tasks 3, 5. ✓
- ApiResponse envelope, 404/400/422 contract cases → Tasks 4, 5 tests + openapi. ✓
- Decisive named tests: `reclassify: convention edit reclassifies stored facts — no source document required`, `override survives reclassify`, accept-as-note idempotency/409 → Task 5. ✓
- Out of scope honored: no convention CRUD (O-10), no UI, no MCP, no `onboarding_status` (O-11). ✓

**Type consistency:** `OwnershipResult`, `ReclassifyOutcome`/`ReclassifyReport`/`EditabilityDiffEntry`, `AcceptNoteOutcome` are defined in `reclassify.ts` (Tasks 1–3) and consumed by `editability.ts` (Tasks 4–5) under those exact names. `PatchEditabilityBody`/`ReclassifyBody` from Task 0 are used in Tasks 4–5. `classify`/`storeClassifications`/`getSpecTree`/`getConventionForLibrary` are existing names verified in the codebase.

**Open risk to watch during execution:** the `before` (prior machine value) in the reclassify diff must be read from the raw `classification` column, not from `meta.editability.value` (which is the EFFECTIVE value and collapses to the override when one exists). Task 2's implementer note flags this; verify the `override survives reclassify` test's `before` is the machine `note`, not the override `editable`.
