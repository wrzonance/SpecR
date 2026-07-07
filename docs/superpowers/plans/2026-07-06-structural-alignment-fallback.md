# Structural Alignment Fallback + Differences Filter + Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `compare_specs` align two *independently-ingested* specs of the same CSI section by canonical structural address (deterministic, not fuzzy), add a `differences`-only row filter, and always emit a grounded `summary` rollup — so the flagship "summarize the differences between these two projects" demo works even when the projects share no paragraph UUIDs.

**Architecture:** ADR-047 shipped origin-key alignment (`originParagraphId ?? id`). This slice lifts its fuzzy/content-alignment non-goal with a *structural* fallback: the alignment key becomes the root-to-node path of `(nodeType, sibling-ordinal)` (sibling-ordinal = 0-based index among same-`nodeType` siblings in `(position, id)` order — the same tree address render-derived CSI numbering comes from; no rendered label is ever stored or compared). `alignment: 'origin' | 'structure' | 'auto'` (default `auto`) selects the keyer; `auto` picks `origin` iff the sources share ≥1 cross-source origin key, else `structure`, and the resolved mode echoes back as `alignedBy`. `summary` is computed over the full matrix; `include: 'differences'` trims the returned rows (and baseline-lens rows) to non-identical ones while `summary` still reports full-matrix totals.

> **Post-review correction (ADR-053, commit c4a78e1).** The shipped `auto` adds one guard the wording above and the Task 6 Step-4 openapi snippet below omit: with **no** shared cross-source origin key it falls back to `structure` **only when the two sources are the same CSI `section`** — different-section pairs stay on `origin`, so unrelated specs (whose `part:0|article:0` addresses coincide) are never falsely paired. An explicit `alignment: 'structure'` is unaffected. This plan preserves its original point-in-time text; `openapi.yaml` + ADR-053 are authoritative for the final rule.

**Tech Stack:** TypeScript/Node 22 (ESM, `.js` import suffixes, `import type`), Zod v4 (`z.uuid()`), vitest (unit `--project unit`, integration needs Postgres), Express, `@modelcontextprotocol/sdk`, hand-authored `openapi.yaml` (CI-enforced contract gate), ajv (`strict:false`) response validation.

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400 (file cap), `no-console` error, `no-explicit-any` error.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`. No `any`, no `as unknown as`, no cross-boundary type assertions, no non-null `!` outside tests.
- Immutability: create new objects; never mutate inputs. Comprehensive error handling with `cause` chains; `ReportingError` is the module-boundary error.
- Module boundaries: import siblings via their `index.ts` barrel only. Reporting imports DB via `../db/index.js`.
- No rendered CSI labels stored or compared — align on tree addresses only (numbering is render-derived; mirror the `consumesNumber`/same-type-sibling ordinal rule from `src/ast/labels.ts`).
- OpenAPI ↔ MCP lockstep: `openapi.yaml` (`CompareRequest`, `ComparisonReport`) and the `compare_specs` MCP tool input schema/description change in the SAME commit series. `z.uuid()` (Zod v4). MCP tools never throw — `{ isError: true, ... }`.
- Determinism (ADR-047): stable ordering, no randomness; `run1` deep-equals `run2`, pinned by a regression test.
- Genuinely ambiguous cases documented IN TESTS as `// KNOWN AMBIGUITY: …`; ordinal-shift-on-insertion misalignment is accepted for this slice and stated in the ADR.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit scope = module (`feat(reporting): …`).
- Additive/back-compat only: existing origin behavior unchanged for `alignment: 'origin'` and shared-master pairs under `auto`.

## File Structure

- `src/reporting/structure.ts` **(new)** — `computeStructuralKeys(rows): ReadonlyMap<string,string>`: pure structural addressing. Owns the tree-walk + same-type-sibling ordinal rule.
- `src/reporting/summary.ts` **(new)** — `summarize(matrix): ComparisonSummary` + `filterToDifferences(matrix, baseline?)`: pure rollup + differences filter, sharing a private `isIdentical(row, colCount)`.
- `src/reporting/align.ts` **(modify)** — thread a `keyOf` strategy through `buildSourceMap`/`sweepOrderedKeys`; add `resolveAlignment` (auto → origin|structure) + `sharesCrossSourceOrigin`; `alignTrees` returns `alignedBy`.
- `src/reporting/types.ts` **(modify)** — `CompareRequestSchema` gains `alignment` + `include`; add `AlignmentMode`, `AlignmentRequest`, `ComparisonSummary`, `ComparisonSummaryColumn`; `ComparisonReport` gains required `summary` + `alignedBy`.
- `src/reporting/report.ts` **(modify)** — pass `alignment`/`include` through; assemble `summary` (full matrix) + `alignedBy`; apply differences filter to returned rows + baseline.
- `src/reporting/index.ts` **(modify)** — export new types + `computeStructuralKeys`, `summarize`.
- `src/api/reporting.ts` **(modify)** — pass `alignment`/`include` from the validated body.
- `src/mcp/report-tools.ts` **(modify)** — add `alignment`/`include` to `compare_specs` input schema + update description.
- `src/mcp/reporting-handler.ts` **(modify)** — accept + forward `alignment`/`include`.
- `openapi.yaml` **(modify)** — `CompareRequest` (`alignment`, `include`), `ComparisonReport` (`summary`, `alignedBy`), new `ComparisonSummary` schema.
- `docs/adr/053-structural-alignment-fallback.md` **(new)** — the decision, determinism guarantee, accepted ordinal-shift ambiguity.
- Tests: `src/reporting/structure.test.ts` (new, unit), `src/reporting/summary.test.ts` (new, unit), extend `src/reporting/align.test.ts` (unit), extend `src/reporting/reporting.integration.test.ts` (integration), extend `src/reporting/types.test.ts`.

Loader (`src/db/queries/reporting.ts`) needs **no change**: `ComparisonParagraphRow` already carries `position`, `parentId`, `nodeType`, `originParagraphId` — verified.

---

### Task 1: Structural addressing (`structure.ts`)

**Files:**
- Create: `src/reporting/structure.ts`
- Test: `src/reporting/structure.test.ts`

**Interfaces:**
- Consumes: `ComparisonParagraph` from `./types.js` (`{ specId, id, originParagraphId, text, position, parentId, nodeType }`).
- Produces: `computeStructuralKeys(rows: readonly ComparisonParagraph[]): ReadonlyMap<string, string>` — maps each row `id` to its canonical structural-address string, e.g. `"part:0|article:1|pr1:0"`. Ordinal = 0-based index among **same-`nodeType`** siblings (children of the same `parentId`) in `(position, id)` order. Root nodes have `parentId === null`. Deterministic; within one source every address is unique.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { computeStructuralKeys } from './structure.js';
import type { ComparisonParagraph } from './types.js';

function p(over: Partial<ComparisonParagraph> & Pick<ComparisonParagraph, 'id' | 'nodeType'>): ComparisonParagraph {
  return { specId: 's', originParagraphId: null, text: '', position: 0, parentId: null, ...over };
}

describe('computeStructuralKeys', () => {
  it('addresses a two-part tree by (nodeType, same-type ordinal) root-to-node path', () => {
    const rows = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 1 }),
      p({ id: 'c1', nodeType: 'pr1', parentId: 'a2', position: 0 }),
      p({ id: 'part2', nodeType: 'part', position: 1 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(keys.get('part1')).toBe('part:0');
    expect(keys.get('a1')).toBe('part:0|article:0');
    expect(keys.get('a2')).toBe('part:0|article:1');
    expect(keys.get('c1')).toBe('part:0|article:1|pr1:0');
    expect(keys.get('part2')).toBe('part:1');
  });

  it('scopes ordinal per nodeType: interleaved notes do not shift numbered siblings', () => {
    const rows = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'n1', nodeType: 'note', parentId: 'part1', position: 1 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 2 }),
      p({ id: 'n2', nodeType: 'note', parentId: 'part1', position: 3 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(keys.get('a1')).toBe('part:0|article:0');
    expect(keys.get('a2')).toBe('part:0|article:1'); // note between them didn't bump it
    expect(keys.get('n1')).toBe('part:0|note:0');
    expect(keys.get('n2')).toBe('part:0|note:1'); // notes get distinct, collision-free slots
  });

  it('is deterministic regardless of input row order (sorts by position,id)', () => {
    const base = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 1 }),
    ];
    const shuffled = [base[2], base[0], base[1]].filter((x): x is ComparisonParagraph => x !== undefined);
    expect(computeStructuralKeys(shuffled)).toEqual(computeStructuralKeys(base));
  });

  it('assigns a distinct address to every node within a source (no intra-source collisions)', () => {
    const rows = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 1 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(new Set(keys.values()).size).toBe(keys.size);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/reporting/structure.test.ts`
Expected: FAIL — `computeStructuralKeys` not defined / module missing.

- [ ] **Step 3: Implement `structure.ts`**

```typescript
import type { ComparisonParagraph } from './types.js';

/** Children grouped by parentId (`''` bucket = roots), each list sorted by the
 *  deterministic (position, id) order the loader already emits. */
function groupChildren(
  rows: readonly ComparisonParagraph[]
): ReadonlyMap<string, readonly ComparisonParagraph[]> {
  const byParent = new Map<string, ComparisonParagraph[]>();
  for (const row of rows) {
    const key = row.parentId ?? '';
    const bucket = byParent.get(key) ?? [];
    if (bucket.length === 0) byParent.set(key, bucket);
    bucket.push(row);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byParent;
}

/** Ordinal among same-nodeType siblings — mirrors render numbering, which advances
 *  only past same-tier (consumesNumber) siblings, so interleaved notes/continuations
 *  never shift a numbered node's slot (src/ast/labels.ts). */
function siblingOrdinal(siblings: readonly ComparisonParagraph[], node: ComparisonParagraph): number {
  let ordinal = 0;
  for (const sib of siblings) {
    if (sib.id === node.id) return ordinal;
    if (sib.nodeType === node.nodeType) ordinal += 1;
  }
  return ordinal;
}

/** Map every paragraph id to its canonical structural address:
 *  the root-to-node path of `nodeType:ordinal` segments joined by `|`.
 *  Two structurally-identical trees produce identical strings for corresponding
 *  nodes, so the address is comparable across independently-ingested sources. */
export function computeStructuralKeys(
  rows: readonly ComparisonParagraph[]
): ReadonlyMap<string, string> {
  const byParent = groupChildren(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, string>();

  const addressOf = (node: ComparisonParagraph): string => {
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    const siblings = byParent.get(node.parentId ?? '') ?? [];
    const segment = `${node.nodeType}:${siblingOrdinal(siblings, node)}`;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    const address = parent === undefined ? segment : `${addressOf(parent)}|${segment}`;
    memo.set(node.id, address);
    return address;
  };

  return new Map(rows.map((r) => [r.id, addressOf(r)]));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/reporting/structure.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reporting/structure.ts src/reporting/structure.test.ts
git commit -m "feat(reporting): canonical structural address for cross-spec alignment"
```

---

### Task 2: Alignment mode + structural keyer in `align.ts`

**Files:**
- Modify: `src/reporting/align.ts`
- Modify: `src/reporting/types.ts` (add `AlignmentMode`, `AlignmentRequest`)
- Test: extend `src/reporting/align.test.ts`

**Interfaces:**
- Consumes: `computeStructuralKeys` from `./structure.js`; `ComparisonParagraph`, `AlignSource` from `./types.js`.
- Produces:
  - `type AlignmentMode = 'origin' | 'structure'` and `type AlignmentRequest = AlignmentMode | 'auto'` in `types.ts`.
  - `alignTrees(sources, options?: { baseline?: string; alignment?: AlignmentRequest }): { matrix: ComparisonMatrix; baseline?: BaselineLens; alignedBy: AlignmentMode }` — resolves `auto`, selects the keyer, always returns the resolved `alignedBy`.

- [ ] **Step 1: Add the mode types to `types.ts`** (before the request schema)

```typescript
export type AlignmentMode = 'origin' | 'structure';
export type AlignmentRequest = AlignmentMode | 'auto';
```

- [ ] **Step 2: Write the failing tests** (append to `align.test.ts`)

```typescript
describe('alignTrees — alignment mode', () => {
  // Two independently-ingested specs: no shared origin (all NULL → key = own id),
  // identical structure (PART/article/pr1).
  function indieSource(specId: string, texts: readonly string[]): AlignSource {
    const partId = `${specId}-part`;
    const artId = `${specId}-art`;
    return {
      column: { specId, section: '07 21 00', title: 'T' },
      rows: [
        para({ specId, id: partId, text: 'PART 1', nodeType: 'part', position: 0 }),
        para({ specId, id: artId, text: 'SUMMARY', nodeType: 'article', parentId: partId, position: 0 }),
        ...texts.map((t, i) =>
          para({ specId, id: `${specId}-c${i}`, text: t, nodeType: 'pr1', parentId: artId, position: i })
        ),
      ],
    };
  }

  it('auto falls back to structure when sources share no cross-source origin key', () => {
    const a = indieSource('a', ['Alpha', 'Bravo']);
    const b = indieSource('b', ['Alpha', 'Bravo EDITED']);
    const { matrix, alignedBy } = alignTrees([a, b]);
    expect(alignedBy).toBe('structure');
    // Every row aligns both columns (identical structure): part, article, 2 pr1.
    expect(matrix.rows).toHaveLength(4);
    expect(matrix.rows.every((r) => r.cells[0]?.present && r.cells[1]?.present)).toBe(true);
    const bravo = matrix.rows.find((r) => r.cells[0]?.present && r.cells[0].text === 'Bravo');
    expect(bravo?.cells[1]).toMatchObject({ present: true, text: 'Bravo EDITED' });
  });

  it('auto uses origin when sources share a cross-source origin key (shared master)', () => {
    const { alignedBy } = alignTrees([p1(), p2()]);
    expect(alignedBy).toBe('origin');
  });

  it('explicit alignment: "origin" forces origin even for independently-ingested specs', () => {
    const a = indieSource('a', ['Alpha']);
    const b = indieSource('b', ['Alpha']);
    const { matrix, alignedBy } = alignTrees([a, b], { alignment: 'origin' });
    expect(alignedBy).toBe('origin');
    // No shared origin → nothing aligns → every row present in exactly one column.
    expect(matrix.rows.every((r) => r.cells.filter((c) => c.present).length === 1)).toBe(true);
  });

  it('explicit alignment: "structure" forces structure even for shared-master clones', () => {
    const { alignedBy } = alignTrees([p1(), p2()], { alignment: 'structure' });
    expect(alignedBy).toBe('structure');
  });

  it('structure alignment is deterministic: run1 deep-equals run2', () => {
    const mk = (): readonly AlignSource[] => [indieSource('a', ['x', 'y']), indieSource('b', ['x', 'z'])];
    expect(alignTrees(mk(), { alignment: 'structure' })).toEqual(alignTrees(mk(), { alignment: 'structure' }));
  });

  it('// KNOWN AMBIGUITY: an inserted sibling shifts downstream ordinals — structural alignment mispairs by position', () => {
    // b inserts a new first clause; structure keys on ordinal, so b-c0(New) aligns
    // with a-c0(Alpha), a-c1(Bravo) with b-c1(Alpha), etc. This ordinal-shift
    // misalignment is accepted for this slice (ADR-053) — assert the accepted shape.
    const a = indieSource('a', ['Alpha', 'Bravo']);
    const b = indieSource('b', ['New', 'Alpha', 'Bravo']);
    const { matrix } = alignTrees([a, b], { alignment: 'structure' });
    const first = matrix.rows.find((r) => r.cells[0]?.present && r.cells[0].text === 'Alpha');
    // 'Alpha' (a, ordinal 0) pairs with b's ordinal-0 clause 'New', not b's 'Alpha'.
    expect(first?.cells[1]).toMatchObject({ present: true, text: 'New' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test -- src/reporting/align.test.ts`
Expected: FAIL — `alignedBy` undefined / `alignment` option unsupported.

- [ ] **Step 4: Refactor `align.ts`** — thread a keyer, add mode resolution. Replace the current `keyOf`/`buildSourceMap`/`sweepOrderedKeys`/`alignTrees` with:

```typescript
import { computeStructuralKeys } from './structure.js';
import type {
  AlignmentMode,
  AlignmentRequest,
  AlignSource,
  BaselineLens,
  // …existing imports unchanged…
  ComparisonParagraph,
} from './types.js';

type Keyer = (p: ComparisonParagraph) => string;

/** Origin key (ADR-047): a cloned paragraph aligns on its master origin; a
 *  NULL-origin paragraph keys on its own id and surfaces as only-in-X. */
const originKeyOf: Keyer = (p) => p.originParagraphId ?? p.id;

/** True iff any origin key occurs in ≥2 distinct sources — i.e. the pair descends
 *  from a shared master (project↔project) or is project↔its-own-master. */
function sharesCrossSourceOrigin(sources: readonly AlignSource[]): boolean {
  const firstSeenIn = new Map<string, number>();
  for (let i = 0; i < sources.length; i += 1) {
    for (const row of sources[i]?.rows ?? []) {
      const k = originKeyOf(row);
      const seen = firstSeenIn.get(k);
      if (seen !== undefined && seen !== i) return true;
      if (seen === undefined) firstSeenIn.set(k, i);
    }
  }
  return false;
}

function resolveAlignment(sources: readonly AlignSource[], requested: AlignmentRequest): AlignmentMode {
  if (requested !== 'auto') return requested;
  return sharesCrossSourceOrigin(sources) ? 'origin' : 'structure';
}

/** Structural keyer over ALL sources at once — paragraph ids are globally unique,
 *  and identical structural addresses across sources are what align them. */
function structuralKeyer(sources: readonly AlignSource[]): Keyer {
  const merged = new Map<string, string>();
  for (const source of sources) {
    for (const [id, address] of computeStructuralKeys(source.rows)) merged.set(id, address);
  }
  return (p) => merged.get(p.id) ?? p.id;
}

function keyerFor(sources: readonly AlignSource[], mode: AlignmentMode): Keyer {
  return mode === 'origin' ? originKeyOf : structuralKeyer(sources);
}
```

Update `buildSourceMap` and `sweepOrderedKeys` to accept `keyOf: Keyer` (replace the module-level `keyOf` usages with the passed argument; keep the `// KNOWN AMBIGUITY` comment on the first-wins collision in `buildSourceMap`). Then:

```typescript
export function alignTrees(
  sources: readonly AlignSource[],
  options?: { readonly baseline?: string; readonly alignment?: AlignmentRequest }
): { readonly matrix: ComparisonMatrix; readonly baseline?: BaselineLens; readonly alignedBy: AlignmentMode } {
  const alignedBy = resolveAlignment(sources, options?.alignment ?? 'auto');
  const keyOf = keyerFor(sources, alignedBy);
  const columns: readonly ComparisonColumn[] = sources.map((s) => s.column);
  const maps = sources.map((s) => buildSourceMap(s.rows, keyOf));
  const orderedKeys = sweepOrderedKeys(sources, keyOf);
  const rows: readonly ComparisonMatrixRow[] = orderedKeys.map((key) => ({
    originId: key,
    cells: maps.map((m) => cellFor(m, key)),
  }));
  const matrix: ComparisonMatrix = { columns, rows };
  const baseline = options?.baseline;
  if (baseline === undefined) return { matrix, alignedBy };
  return { matrix, baseline: projectBaseline(matrix, baseline), alignedBy };
}
```

Note: for `structure` mode the `originId` field now carries a structural-address string rather than a UUID — document this (see Task 6 openapi/ADR). `projectBaseline` is unchanged.

- [ ] **Step 5: Run to verify pass + full reporting unit suite green**

Run: `pnpm test -- src/reporting/align.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/reporting/align.ts src/reporting/types.ts src/reporting/align.test.ts
git commit -m "feat(reporting): alignment mode (origin|structure|auto) with structural fallback"
```

---

### Task 3: Summary rollup + differences filter (`summary.ts`)

**Files:**
- Create: `src/reporting/summary.ts`
- Modify: `src/reporting/types.ts` (add `ComparisonSummary`, `ComparisonSummaryColumn`)
- Test: `src/reporting/summary.test.ts`

**Interfaces:**
- Consumes: `ComparisonMatrix`, `ComparisonMatrixRow`, `BaselineLens` from `./types.js`.
- Produces:
  - `ComparisonSummaryColumn = { specId: string; present: number; onlyIn: number }`, `ComparisonSummary = { rows: number; aligned: number; identical: number; differing: number; columns: readonly ComparisonSummaryColumn[] }` in `types.ts`.
  - `summarize(matrix: ComparisonMatrix): ComparisonSummary`.
  - `filterToDifferences(matrix: ComparisonMatrix, baseline?: BaselineLens): { matrix: ComparisonMatrix; baseline?: BaselineLens }`.
  - Definitions: a row is **identical** iff present in every column AND all texts equal; **differing** = not identical (includes only-in-X and modified). `aligned` = rows present in ≥2 columns. `differing = rows − identical`.

- [ ] **Step 1: Add types to `types.ts`**

```typescript
export interface ComparisonSummaryColumn {
  readonly specId: string;
  readonly present: number; // rows where this column's cell is present
  readonly onlyIn: number; // rows present ONLY in this column
}

export interface ComparisonSummary {
  readonly rows: number; // total aligned rows in the full matrix
  readonly aligned: number; // rows present in ≥2 columns
  readonly identical: number; // rows present in all columns with identical text
  readonly differing: number; // rows that are not identical (rows − identical)
  readonly columns: readonly ComparisonSummaryColumn[]; // index-aligned to columns
}
```

Add `summary` (required) to `ComparisonReport` and `alignedBy` (required) in Task 5; leave `ComparisonReport` for now.

- [ ] **Step 2: Write the failing tests** (`summary.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { summarize, filterToDifferences } from './summary.js';
import type { ComparisonMatrix, ComparisonCell } from './types.js';

const cell = (specId: string, text: string): ComparisonCell => ({ present: true, specId, paragraphUuid: `${specId}-x`, text });
const absent: ComparisonCell = { present: false };

const matrix: ComparisonMatrix = {
  columns: [
    { specId: 'a', section: '07 21 00', title: 'T' },
    { specId: 'b', section: '07 21 00', title: 'T' },
  ],
  rows: [
    { originId: 'r1', cells: [cell('a', 'same'), cell('b', 'same')] }, // identical
    { originId: 'r2', cells: [cell('a', 'x'), cell('b', 'y')] }, // modified
    { originId: 'r3', cells: [cell('a', 'only-a'), absent] }, // only-in-a
    { originId: 'r4', cells: [absent, cell('b', 'only-b')] }, // only-in-b
  ],
};

describe('summarize', () => {
  it('rolls up overall + per-column counts consistent with the matrix', () => {
    const s = summarize(matrix);
    expect(s.rows).toBe(4);
    expect(s.aligned).toBe(2); // r1, r2 present in both
    expect(s.identical).toBe(1); // r1
    expect(s.differing).toBe(3); // r2, r3, r4
    expect(s.identical + s.differing).toBe(s.rows);
    expect(s.columns).toEqual([
      { specId: 'a', present: 3, onlyIn: 1 },
      { specId: 'b', present: 3, onlyIn: 1 },
    ]);
  });
});

describe('filterToDifferences', () => {
  it('keeps only non-identical rows and drops the identical one', () => {
    const { matrix: out } = filterToDifferences(matrix);
    expect(out.rows.map((r) => r.originId)).toEqual(['r2', 'r3', 'r4']);
    expect(out.columns).toEqual(matrix.columns);
  });

  it('filters the baseline lens rows to the same kept originIds', () => {
    const baseline = {
      specId: 'a',
      rows: matrix.rows.map((r) => ({ originId: r.originId, states: ['baseline', 'unchanged'] as const })),
    };
    const { baseline: out } = filterToDifferences(matrix, baseline);
    expect(out?.rows.map((r) => r.originId)).toEqual(['r2', 'r3', 'r4']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test -- src/reporting/summary.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `summary.ts`**

```typescript
import type {
  BaselineLens,
  ComparisonMatrix,
  ComparisonMatrixRow,
  ComparisonSummary,
  ComparisonSummaryColumn,
} from './types.js';

const presentCount = (row: ComparisonMatrixRow): number => row.cells.filter((c) => c.present).length;

/** A row is identical iff present in every column and all present texts are equal. */
function isIdentical(row: ComparisonMatrixRow, columnCount: number): boolean {
  const texts = row.cells.flatMap((c) => (c.present ? [c.text] : []));
  return texts.length === columnCount && texts.every((t) => t === texts[0]);
}

function summarizeColumn(matrix: ComparisonMatrix, index: number): ComparisonSummaryColumn {
  const specId = matrix.columns[index]?.specId ?? '';
  const present = matrix.rows.filter((r) => r.cells[index]?.present).length;
  const onlyIn = matrix.rows.filter(
    (r) => presentCount(r) === 1 && r.cells[index]?.present === true
  ).length;
  return { specId, present, onlyIn };
}

/** Grounded rollup computed over the FULL matrix (never the filtered view), so an
 *  agent can cite totals without paging every row. */
export function summarize(matrix: ComparisonMatrix): ComparisonSummary {
  const columnCount = matrix.columns.length;
  const identical = matrix.rows.filter((r) => isIdentical(r, columnCount)).length;
  return {
    rows: matrix.rows.length,
    aligned: matrix.rows.filter((r) => presentCount(r) >= 2).length,
    identical,
    differing: matrix.rows.length - identical,
    columns: matrix.columns.map((_c, i) => summarizeColumn(matrix, i)),
  };
}

/** Trim matrix rows (and any baseline-lens rows) to the non-identical set. Returns
 *  new objects; the summary is computed separately over the full matrix. */
export function filterToDifferences(
  matrix: ComparisonMatrix,
  baseline?: BaselineLens
): { readonly matrix: ComparisonMatrix; readonly baseline?: BaselineLens } {
  const columnCount = matrix.columns.length;
  const kept = new Set(
    matrix.rows.filter((r) => !isIdentical(r, columnCount)).map((r) => r.originId)
  );
  const filteredMatrix: ComparisonMatrix = {
    columns: matrix.columns,
    rows: matrix.rows.filter((r) => kept.has(r.originId)),
  };
  if (baseline === undefined) return { matrix: filteredMatrix };
  return {
    matrix: filteredMatrix,
    baseline: { specId: baseline.specId, rows: baseline.rows.filter((r) => kept.has(r.originId)) },
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test -- src/reporting/summary.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reporting/summary.ts src/reporting/types.ts src/reporting/summary.test.ts
git commit -m "feat(reporting): grounded summary rollup + differences-only filter"
```

---

### Task 4: Request schema — `alignment` + `include`

**Files:**
- Modify: `src/reporting/types.ts` (`CompareRequestSchema`)
- Test: extend `src/reporting/types.test.ts`

**Interfaces:**
- Produces: `CompareRequestSchema` gains `alignment: z.enum(['origin','structure','auto']).default('auto')` and `include: z.enum(['all','differences']).default('all')`. `CompareRequest` (z.infer output) has both as required (defaulted).

- [ ] **Step 1: Write failing tests** (append to `types.test.ts`)

```typescript
describe('CompareRequestSchema — alignment & include', () => {
  it('defaults alignment to "auto" and include to "all"', () => {
    const parsed = CompareRequestSchema.parse({ sources: [A, B] });
    expect(parsed.alignment).toBe('auto');
    expect(parsed.include).toBe('all');
  });

  it('accepts explicit alignment and include', () => {
    const parsed = CompareRequestSchema.parse({ sources: [A, B], alignment: 'structure', include: 'differences' });
    expect(parsed.alignment).toBe('structure');
    expect(parsed.include).toBe('differences');
  });

  it('rejects an unknown alignment mode', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, B], alignment: 'fuzzy' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- src/reporting/types.test.ts`
Expected: FAIL — `alignment` undefined.

- [ ] **Step 3: Extend `CompareRequestSchema`** — add the two fields inside the `.object({...})`:

```typescript
    sources: z.array(z.uuid()).length(2),
    baseline: z.uuid().optional(),
    alignment: z.enum(['origin', 'structure', 'auto']).default('auto'),
    include: z.enum(['all', 'differences']).default('all'),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- src/reporting/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reporting/types.ts src/reporting/types.test.ts
git commit -m "feat(reporting): CompareRequest alignment + include options"
```

---

### Task 5: Wire the report — `alignedBy`, `summary`, `include`

**Files:**
- Modify: `src/reporting/types.ts` (`ComparisonReport`)
- Modify: `src/reporting/report.ts`
- Modify: `src/reporting/index.ts`
- Test: extend `src/reporting/reporting.integration.test.ts` (project↔project structural + summary + differences)

**Interfaces:**
- Consumes: `alignTrees` (now returns `alignedBy`), `summarize`, `filterToDifferences`.
- Produces: `buildComparisonReport(sources, options?: { baseline?; alignment?: AlignmentRequest; include?: 'all'|'differences' })`; `ComparisonReport` gains required `summary: ComparisonSummary` and `alignedBy: AlignmentMode`.

- [ ] **Step 1: Extend `ComparisonReport` in `types.ts`**

```typescript
export interface ComparisonReport {
  readonly columns: readonly ComparisonColumn[];
  readonly rows: readonly ComparisonMatrixRow[];
  readonly summary: ComparisonSummary; // always emitted (full-matrix rollup)
  readonly alignedBy: AlignmentMode; // the mode actually used
  readonly baseline?: BaselineLens;
  readonly drift?: readonly DriftEntry[];
}
```

- [ ] **Step 2: Extend `index.ts` exports**

```typescript
export { computeStructuralKeys } from './structure.js';
export { summarize, filterToDifferences } from './summary.js';
```
…and add to the `export type { … }` block: `AlignmentMode, AlignmentRequest, ComparisonSummary, ComparisonSummaryColumn`.

- [ ] **Step 3: Write the failing integration tests** (append to `reporting.integration.test.ts`, project↔project describe block)

```typescript
  it('always emits alignedBy=origin and a summary consistent with the matrix (shared master)', async () => {
    const { body } = await post({ sources: [p1Spec, p2Spec] });
    const report = okData(body);
    expect(report.alignedBy).toBe('origin');
    expect(report.summary).toBeDefined();
    expect(report.summary.rows).toBe(report.rows.length);
    expect(report.summary.identical + report.summary.differing).toBe(report.summary.rows);
    const bothPresent = report.rows.filter((r) => r.cells[0]?.present && r.cells[1]?.present).length;
    expect(report.summary.aligned).toBe(bothPresent);
  });

  it('include=differences drops identical rows but summary still reports full-matrix totals', async () => {
    const full = okData((await post({ sources: [p1Spec, p2Spec] })).body);
    const diff = okData((await post({ sources: [p1Spec, p2Spec], include: 'differences' })).body);
    expect(diff.summary).toEqual(full.summary); // summary is full-matrix
    expect(diff.rows.length).toBe(full.summary.differing);
    expect(diff.rows.length).toBeLessThan(full.rows.length);
    // no returned row is identical (present in both with equal text)
    const anyIdentical = diff.rows.some(
      (r) => r.cells[0]?.present && r.cells[1]?.present && cellText(r, 0) === cellText(r, 1)
    );
    expect(anyIdentical).toBe(false);
  });
```

- [ ] **Step 4: Rewrite `buildComparisonReport`** in `report.ts`:

```typescript
import { alignTrees } from './align.js';
import { summarize, filterToDifferences } from './summary.js';
import type {
  AlignmentRequest,
  AlignSource,
  ComparisonColumn,
  ComparisonReport,
  DriftEntry,
} from './types.js';

// …toColumn / indexMeta / assertAllFound / buildSources / driftFor / computeDrift unchanged…

export async function buildComparisonReport(
  sources: readonly string[],
  options: { readonly baseline?: string; readonly alignment?: AlignmentRequest; readonly include?: 'all' | 'differences' } = {}
): Promise<ComparisonReport> {
  const distinct = [...new Set(sources)];
  const metas = await getComparisonColumns(distinct);
  const metaMap = indexMeta(metas);
  assertAllFound(sources, metaMap);

  const rows = await getComparisonParagraphs(distinct);
  const alignInput = buildSources(sources, metaMap, rows);
  const alignOpts = {
    ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
    ...(options.alignment !== undefined ? { alignment: options.alignment } : {}),
  };
  const { matrix, baseline, alignedBy } = alignTrees(alignInput, alignOpts);
  const summary = summarize(matrix); // full matrix — never the filtered view

  const view =
    options.include === 'differences' ? filterToDifferences(matrix, baseline) : { matrix, baseline };

  const orderedMetas = distinct
    .map((specId) => metaMap.get(specId))
    .filter((m): m is ComparisonColumnMeta => m !== undefined);
  const drift = await computeDrift(orderedMetas);

  return {
    columns: view.matrix.columns,
    rows: view.matrix.rows,
    summary,
    alignedBy,
    ...(view.baseline ? { baseline: view.baseline } : {}),
    ...(drift.length > 0 ? { drift } : {}),
  };
}
```

- [ ] **Step 5: Run unit + typecheck**

Run: `pnpm test -- src/reporting/ && pnpm exec tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Run integration** (see verification setup in Task 8 for DB) then commit

```bash
git add src/reporting/report.ts src/reporting/types.ts src/reporting/index.ts src/reporting/reporting.integration.test.ts
git commit -m "feat(reporting): emit alignedBy + summary, honor include filter"
```

---

### Task 6: REST + MCP surface (lockstep with openapi)

**Files:**
- Modify: `src/api/reporting.ts`
- Modify: `src/mcp/reporting-handler.ts`
- Modify: `src/mcp/report-tools.ts`
- Modify: `openapi.yaml`

**Interfaces:**
- Consumes: `CompareRequest` (now with `alignment`/`include`).
- Produces: REST handler forwards `alignment`/`include`; MCP tool exposes them; openapi documents `CompareRequest.alignment`, `CompareRequest.include`, `ComparisonReport.summary`, `ComparisonReport.alignedBy`, and a `ComparisonSummary` schema.

- [ ] **Step 1: REST handler** — `src/api/reporting.ts`, in `compareReportHandler`:

```typescript
  const { sources, baseline, alignment, include } = req.body as CompareRequest;
  try {
    const report = await buildComparisonReport(sources, {
      ...(baseline !== undefined ? { baseline } : {}),
      alignment,
      include,
    });
    res.status(200).json({ success: true, data: report });
```

- [ ] **Step 2: MCP handler** — `src/mcp/reporting-handler.ts`, extend the arg type + forward:

```typescript
export async function handleCompareSpecs({
  sources,
  baseline,
  alignment,
  include,
}: {
  sources: string[];
  baseline?: string | undefined;
  alignment?: 'origin' | 'structure' | 'auto' | undefined;
  include?: 'all' | 'differences' | undefined;
}): Promise<ToolResult> {
  try {
    const report = await buildComparisonReport(sources, {
      ...(baseline !== undefined ? { baseline } : {}),
      ...(alignment !== undefined ? { alignment } : {}),
      ...(include !== undefined ? { include } : {}),
    });
```

- [ ] **Step 3: MCP tool schema + description** — `src/mcp/report-tools.ts`, `registerCompareTool`, add to `inputSchema` and extend the description:

```typescript
        alignment: z
          .enum(['origin', 'structure', 'auto'])
          .optional()
          .describe(
            'How to align rows. "origin": resolved paragraph origin (clones of a shared master). ' +
              '"structure": canonical structural address (independently-ingested specs of the same section). ' +
              '"auto" (default): origin when the sources share a cross-source origin, else structure. ' +
              'The mode actually used is echoed as alignedBy.'
          ),
        include: z
          .enum(['all', 'differences'])
          .optional()
          .describe(
            'Row scope. "all" (default): full matrix. "differences": only non-identical rows ' +
              '(modified / only-in-one) — the summary still reports full-matrix totals.'
          ),
```

Extend the tool description to mention structural alignment, the differences filter, and the always-present summary.

- [ ] **Step 4: openapi.yaml — `CompareRequest`** (add under `properties`):

```yaml
        alignment:
          type: string
          enum: [origin, structure, auto]
          default: auto
          description: >
            Row alignment strategy. `origin` keys on resolved paragraph origin
            (clones of a shared master); `structure` keys on the canonical
            structural address (independently-ingested specs of the same section);
            `auto` (default) uses origin when the sources share a cross-source
            origin key, else structure. The mode used is echoed as `alignedBy`.
        include:
          type: string
          enum: [all, differences]
          default: all
          description: >
            Row scope. `all` (default) returns the full matrix; `differences`
            returns only non-identical rows (modified / present-in-one). `summary`
            always reports full-matrix totals regardless of this filter.
```

> _Post-review (ADR-053, c4a78e1): the shipped `alignment` description gates the `auto` → `structure` fallback on the two sources being the **same CSI section**; the snippet above keeps its original point-in-time wording. See the correction note near the top and the authoritative `openapi.yaml`._

- [ ] **Step 5: openapi.yaml — `ComparisonReport`** (add `summary` + `alignedBy`; mark required):

```yaml
    ComparisonReport:
      type: object
      required: [columns, rows, summary, alignedBy]
      properties:
        columns:
          type: array
          items: { $ref: '#/components/schemas/ComparisonColumn' }
        rows:
          type: array
          items: { $ref: '#/components/schemas/ComparisonMatrixRow' }
        alignedBy:
          type: string
          enum: [origin, structure]
          description: >
            The alignment mode actually used. Under `structure`, `ComparisonMatrixRow.originId`
            is a canonical structural-address string, not a paragraph UUID.
        summary:
          $ref: '#/components/schemas/ComparisonSummary'
        baseline:
          $ref: '#/components/schemas/BaselineLens'
        drift:
          type: array
          items: { $ref: '#/components/schemas/DriftEntry' }
```

- [ ] **Step 6: openapi.yaml — new `ComparisonSummary` schema** (insert next to `ComparisonReport`):

```yaml
    ComparisonSummary:
      type: object
      required: [rows, aligned, identical, differing, columns]
      description: Grounded rollup over the full matrix (before any include filter).
      properties:
        rows: { type: integer, description: Total aligned rows in the full matrix. }
        aligned: { type: integer, description: Rows present in ≥2 columns. }
        identical: { type: integer, description: Rows present in all columns with identical text. }
        differing: { type: integer, description: Rows that are not identical (rows − identical). }
        columns:
          type: array
          description: Per-column counts, index-aligned to `columns`.
          items:
            type: object
            required: [specId, present, onlyIn]
            properties:
              specId: { type: string, format: uuid }
              present: { type: integer }
              onlyIn: { type: integer }
```

Also update the `postCompareReport` operation `description` to mention structural fallback, the differences filter, and the summary.

- [ ] **Step 7: Verify contract gates + build**

Run: `pnpm exec tsc --noEmit && pnpm test:integration -- src/api/contract.integration.test.ts src/mcp/contract.integration.test.ts`
Expected: PASS (route↔spec coverage intact; op↔tool mapping intact).

- [ ] **Step 8: Commit**

```bash
git add src/api/reporting.ts src/mcp/reporting-handler.ts src/mcp/report-tools.ts openapi.yaml
git commit -m "feat(reporting): expose alignment/include + summary/alignedBy across REST, MCP, openapi"
```

---

### Task 7: Fixture-grounded structural integration test

**Files:**
- Modify: `src/reporting/reporting.integration.test.ts` (add an independently-ingested structural describe block)

**Interfaces:**
- Consumes: raw-SQL fixture helpers already in the file (`insertLibrary`, `insertMaster`, `insertPara`), `buildComparisonReport` via `post`.

- [ ] **Step 1: Add the structural fixture test.** Build two independent masters (no cloning → all `origin_paragraph_id` NULL) with the SAME structure (PART 1 → SUMMARY → two pr1 clauses), one clause edited in the second, and one extra clause in the second. Assert `alignedBy === 'structure'`, PART/article/clause counterparts pair up, the edited clause shows both texts, and the summary counts are correct.

```typescript
describe('POST /reports/compare — independently-ingested (structural fallback)', () => {
  let indieA: string;
  let indieB: string;

  beforeAll(async () => {
    indieA = await insertMaster(companyLib, '07 21 00');
    const partA = await insertPara(indieA, null, 'part', 'PART 1 GENERAL', 1);
    const artA = await insertPara(indieA, partA, 'article', 'SUMMARY', 1);
    await insertPara(indieA, artA, 'pr1', 'Section includes thermal insulation.', 1);
    await insertPara(indieA, artA, 'pr1', 'Comply with referenced standards.', 2);

    indieB = await insertMaster(companyLib, '07 21 00');
    const partB = await insertPara(indieB, null, 'part', 'PART 1 GENERAL', 1);
    const artB = await insertPara(indieB, partB, 'article', 'SUMMARY', 1);
    await insertPara(indieB, artB, 'pr1', 'Section includes thermal insulation.', 1);
    await insertPara(indieB, artB, 'pr1', 'Comply with referenced standards AS AMENDED.', 2);
    await insertPara(indieB, artB, 'pr1', 'Submit product data.', 3);
  });

  it('aligns two independently-ingested specs of the same section by structure', async () => {
    const { status, body } = await post({ sources: [indieA, indieB] });
    expect(status).toBe(200);
    const report = okData(body);
    expect(report.alignedBy).toBe('structure');

    // PART and SUMMARY article pair up (both present).
    const part = report.rows.find((r) => cellText(r, 0) === 'PART 1 GENERAL');
    expect(part?.cells[1]?.present).toBe(true);
    const summaryArt = report.rows.find((r) => cellText(r, 0) === 'SUMMARY');
    expect(summaryArt?.cells[1]?.present).toBe(true);

    // The edited clause shows both cells.
    const edited = report.rows.find(
      (r) => cellText(r, 0) === 'Comply with referenced standards.'
    );
    expect(cellText(edited!, 1)).toBe('Comply with referenced standards AS AMENDED.');

    // The extra clause in B is only-in-B.
    const extra = report.rows.find((r) => cellText(r, 1) === 'Submit product data.');
    expect(extra?.cells[0]?.present).toBe(false);

    // Summary: A has 4 rows present, B has 5; aligned = 4 (part, article, 2 clauses).
    const colB = report.summary.columns.find((c) => c.specId === indieB);
    expect(colB?.onlyIn).toBe(1);
    expect(report.summary.aligned).toBe(4);
  });
});
```

(Note: these two masters live in `companyLib`, already torn down by the existing `afterAll` which deletes paragraphs+specs by `library_id = companyLib`.)

- [ ] **Step 2: Run integration**

Run: `pnpm test:integration -- src/reporting/reporting.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/reporting/reporting.integration.test.ts
git commit -m "test(reporting): structural alignment of two independently-ingested specs"
```

---

### Task 8: ADR + full verification

**Files:**
- Create: `docs/adr/053-structural-alignment-fallback.md`

- [ ] **Step 1: Write ADR-053** — Status: Accepted. Context: ADR-047's origin-only alignment fails for independently-ingested specs (no shared UUIDs → all only-in-X); fuzzy/content alignment was its explicit non-goal. Decision: structural fallback keying on the root-to-node path of `(nodeType, same-type sibling ordinal)` — the render-derived numbering address, no rendered label stored/compared; `auto` picks origin iff sources share a cross-source origin key else structure; `alignedBy` echoes the resolved mode; `summary` always emitted over the full matrix; `include: 'differences'` trims returned rows only. Determinism: `(position, id)` ordering + first-occurrence sweep, no randomness, `run1 === run2`. Consequences / accepted ambiguity: an inserted sibling shifts downstream ordinals → positional mispair (stated as accepted for this slice, pinned by a KNOWN AMBIGUITY test); `originId` carries a structural-address string under `structure` mode; N>2, frozen package/revision sources, cross-master multi-hop, and fuzzy/content alignment remain non-goals (ADR-047 stands).

- [ ] **Step 2: Full lint + unit**

Run: `pnpm lint && pnpm test`
Expected: PASS (eslint, tsc, prettier, all unit tests).

- [ ] **Step 3: Full integration** (DB up — see below)

```bash
docker compose up -d postgres   # or an isolated postgres:16 on :5434 if 5432 is taken
# export DATABASE_URL=postgres://specr:specr@localhost:5432/specr
pnpm migrate && pnpm seed && pnpm test:integration
```
Expected: PASS — including both contract gates and the reporting integration suites.

- [ ] **Step 4: Commit ADR**

```bash
git add docs/adr/053-structural-alignment-fallback.md
git commit -m "docs(adr): 053 structural alignment fallback for cross-spec comparison"
```

- [ ] **Step 5: Finish the branch** — `superpowers:finishing-a-development-branch` → Push + draft PR (`gh pr create --draft`). PR body: Why / What / Design decisions (structural-address ordinal rule, auto-detection heuristic, summary-over-full-matrix, accepted ordinal-shift ambiguity, inline-vs-subagent execution note) / Testing checkboxes (tick only what ran, with output) / `Closes #384` / `🤖 Co-authored by Claude Fable 5`.

## Self-Review

**Spec coverage:**
- Structural alignment fallback (deterministic) → Tasks 1, 2. ✓
- `alignment: origin|structure|auto`, default auto, echo `alignedBy` → Tasks 2, 4, 5, 6. ✓
- Determinism (run1===run2) → Task 2 (unit) + Task 5 (integration). ✓
- KNOWN AMBIGUITY (ordinal shift) → Task 2 test + ADR. ✓
- `include: all|differences` → Tasks 3, 4, 5, 6. ✓
- `summary` (overall + per-column), grounded, full-matrix → Task 3, verified Task 5. ✓
- ADR → Task 8. ✓
- Fixture-grounded integration (same section, two sources) → Task 7. ✓
- OpenAPI ↔ MCP lockstep → Task 6. ✓
- Contract gates stay green → Task 6 Step 7 + Task 8 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows code. `insertMaster`/`insertPara` reused verbatim from the existing test file (Task 7 relies on names already present there).

**Type consistency:** `AlignmentMode`/`AlignmentRequest`, `ComparisonSummary`/`ComparisonSummaryColumn`, `computeStructuralKeys`, `summarize`, `filterToDifferences`, `alignedBy` used identically across tasks. `alignTrees` return shape `{ matrix, baseline?, alignedBy }` consistent in Tasks 2 and 5.
</content>
</invoke>
