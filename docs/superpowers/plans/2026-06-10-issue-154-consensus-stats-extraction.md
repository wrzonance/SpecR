# Issue #154: Extract Consensus Stat Helpers into consensus-stats.ts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure mechanical refactor — move `modeOf`, `medianOf`, `countVotes`, `absentWins`, `selectWinner` and the `ABSENT` sentinel out of `src/parser/docx/derive-template.ts` (448 physical lines) into a sibling `src/parser/docx/consensus-stats.ts`, moving the helper-focused tests alongside. Zero behavior change.

**Architecture:** `consensus-stats.ts` is a pure leaf module (no imports at all — only built-ins). `derive-template.ts` imports from it (same-module internal import inside `parser/docx/` — allowed). No barrel changes: none of the moved symbols were exported from `parser/docx/index.ts` or `parser/index.ts`.

**Tech Stack:** TypeScript strict (verbatimModuleSyntax, declaration emit), vitest, ESLint flat config, Prettier.

**Out of scope:** Any behavior change, signature change, renaming, new tests, new logic. The diff is moves + imports only.

**Proof of correctness:** All 20 existing tests stay green with test bodies unchanged (only file location / imports change). `pnpm lint && pnpm test` passes. No DB needed.

---

## Forced design decisions (document in PR body)

The five named helpers don't move cleanly without these companions — all are forced by the move, none change behavior:

1. **`VoteCounts`, `ABSENT_KEY`, `mustGet` move too and are exported.** Each is used by both moved code (`countVotes`, `absentWins`, `modeOf`) and staying code (`collectDefinedValues`, `buildRejected`, `decidePath`, `decideAllPaths`, `groupByNodeType`). Moving them to the leaf module and importing back into `derive-template.ts` avoids duplication and avoids a circular import.
2. **`DecisionSource` type introduced in `consensus-stats.ts`.** `selectWinner`'s original return type referenced `PropertyDecision['source']` from `derive-template.ts`. Keeping that would create a (type-only) circular import. The union `'consensus' | 'intent' | 'median' | 'single' | 'mode'` now lives with `selectWinner`; `PropertyDecision.source` references it — structurally identical type, no consumer change.
3. **`WinnerInput` is exported.** `tsconfig.json` has `declaration: true`; a non-exported interface in an exported function signature is a TS4078 declaration-emit error.
4. **Test moves:** no direct unit tests for the five helpers existed (they were module-private, pinned through `deriveTemplate`'s public API). The two describe blocks whose sole purpose is pinning moved-helper semantics — "absent tie falls through" (`absentWins` tie rule) and "fallback mode arm" (`selectWinner`'s final arm) — move verbatim to `consensus-stats.test.ts`, still driving through the public `deriveTemplate` API. The other 8 describes pin `deriveTemplate`'s end-to-end contract and stay put. The `para`/`makeStyleMap` fixture helpers are duplicated into the new test file (test scaffolding, not logic).

---

### Task 1: Create `consensus-stats.ts` and rewire `derive-template.ts`

**Files:**
- Create: `src/parser/docx/consensus-stats.ts`
- Modify: `src/parser/docx/derive-template.ts`

- [ ] **Step 1: Create `src/parser/docx/consensus-stats.ts` with exactly this content**

Function bodies are verbatim moves from `derive-template.ts` (lines 50–66, 105–209). Only changes: `export` keywords, the `DecisionSource` type alias replacing the `PropertyDecision['source']` reference, and section headers.

```typescript
// Consensus statistical helpers — vote counting + §5 winner-selection waterfall.
// Pure leaf module: no I/O, no DB, no XML, no internal imports.
// Extracted verbatim from derive-template.ts (#154).

// ─── Public shapes ────────────────────────────────────────────────────────────

// Sentinel for "this voter has no value at this path"
export const ABSENT = Symbol('absent');
export const ABSENT_KEY = '__absent__';

export interface VoteCounts {
  readonly counts: ReadonlyMap<string, { readonly value: unknown; readonly count: number }>;
  readonly order: readonly string[];
}

export type DecisionSource = 'consensus' | 'intent' | 'median' | 'single' | 'mode';

/** Map lookup that throws a contextful invariant error instead of returning undefined. */
export function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K, ctx: string): V {
  const v = map.get(key);
  if (v === undefined) {
    throw new Error(`${ctx}: invariant violated — missing key ${String(key)}`);
  }
  return v;
}

// ─── Statistical helpers ──────────────────────────────────────────────────────

/** Mode of a value array by JSON.stringify, first-seen tie-break. Returns [value, count]. */
export function modeOf(values: readonly unknown[]): [unknown, number] {
  const counts = new Map<string, { readonly value: unknown; readonly count: number }>();
  const order: string[] = [];
  for (const v of values) {
    const key = JSON.stringify(v);
    const entry = counts.get(key);
    if (entry) {
      counts.set(key, { ...entry, count: entry.count + 1 });
    } else {
      counts.set(key, { value: v, count: 1 });
      order.push(key);
    }
  }
  // Strict > and insertion-order iteration give the first-seen tie-break.
  let bestValue: unknown;
  let bestCount = 0;
  for (const key of order) {
    const entry = mustGet(counts, key, 'modeOf');
    if (entry.count > bestCount) {
      bestValue = entry.value;
      bestCount = entry.count;
    }
  }
  return [bestValue, bestCount];
}

/** Median of a numeric array. Lower-middle on even counts. */
export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid] as number;
}

// ─── Vote counting ────────────────────────────────────────────────────────────

/** Build a count map over raw vote values (including ABSENT sentinel). */
export function countVotes(values: readonly unknown[]): VoteCounts {
  const counts = new Map<string, { readonly value: unknown; readonly count: number }>();
  const order: string[] = [];
  for (const v of values) {
    const key = v === ABSENT ? ABSENT_KEY : JSON.stringify(v);
    const entry = counts.get(key);
    if (entry) {
      counts.set(key, { ...entry, count: entry.count + 1 });
    } else {
      counts.set(key, { value: v, count: 1 });
      order.push(key);
    }
  }
  return { counts, order };
}

/**
 * Returns true only when absent STRICTLY beats every defined value's count.
 * On a tie, absent does NOT win — the path falls through to the §5 decision
 * waterfall (dominant → intent → median → fallback mode), so the modal
 * style's intent can keep a property that half the voters carry.
 */
export function absentWins(voteCounts: VoteCounts): boolean {
  const absentCount = voteCounts.counts.get(ABSENT_KEY)?.count ?? 0;
  let maxDefinedCount = 0;
  for (const [key, entry] of voteCounts.counts) {
    if (key !== ABSENT_KEY && entry.count > maxDefinedCount) {
      maxDefinedCount = entry.count;
    }
  }
  return absentCount > maxDefinedCount;
}

// ─── Winner selection ─────────────────────────────────────────────────────────

export interface WinnerInput {
  readonly definedValues: readonly unknown[];
  readonly styledCount: number;
  readonly intentValue: unknown;
}

/** Select the winning value and source per §5 decision order. */
export function selectWinner(input: WinnerInput): {
  chosenValue: unknown;
  source: DecisionSource;
} {
  const { definedValues, styledCount, intentValue } = input;
  if (styledCount === 1) {
    return { chosenValue: definedValues[0], source: 'single' };
  }
  const [modeVal, modeCount] = modeOf(definedValues);
  if (modeCount / styledCount > 0.5) {
    return { chosenValue: modeVal, source: 'consensus' };
  }
  if (intentValue !== undefined) {
    return { chosenValue: intentValue, source: 'intent' };
  }
  if (definedValues.every((v) => typeof v === 'number')) {
    const numericValues = definedValues as number[];
    return { chosenValue: medianOf(numericValues), source: 'median' };
  }
  // Low-plurality fallback: no dominant value, no intent, non-numeric votes.
  // 'mode' (not 'consensus') — consensus means >0.5, which already failed here.
  const [fallback] = modeOf(definedValues);
  return { chosenValue: fallback, source: 'mode' };
}
```

- [ ] **Step 2: Rewire `src/parser/docx/derive-template.ts`**

Apply these edits — nothing else in the file changes:

**2a. Replace the import block (lines 4–6) with:**

```typescript
import { STYLE_NODE_TYPES, StylePropertiesSchema } from '../../ast/index.js';
import type { NodeType, StyleNodeType, StyleProperties } from '../../ast/types.js';
import { ABSENT, ABSENT_KEY, absentWins, countVotes, mustGet, selectWinner } from './consensus-stats.js';
import type { DecisionSource, VoteCounts } from './consensus-stats.js';
import type { ClassifiedParagraph } from './types.js';
```

(`verbatimModuleSyntax` requires the type-only names on `import type`. Prettier may wrap the value-import line — accept its formatting.)

**2b. In `PropertyDecision`, replace the `source` member:**

```typescript
  readonly source: 'consensus' | 'intent' | 'median' | 'single' | 'mode';
```

with:

```typescript
  readonly source: DecisionSource;
```

**2c. Delete these blocks entirely (verbatim text now lives in consensus-stats.ts):**

- The `VoteCounts` interface (lines 50–53) — keep the `Voter` interface above it.
- The `ABSENT` / `ABSENT_KEY` declarations and their comment (lines 55–57).
- The `mustGet` function and its doc comment (lines 59–66).
- The entire `// ─── Statistical helpers ───…` section: `modeOf` + `medianOf` (lines 105–139).
- The entire `// ─── Vote counting ───…` section: `countVotes` + `absentWins` (lines 141–175).
- The entire `// ─── Winner selection ───…` section header, `WinnerInput`, and `selectWinner` (lines 177–209).

Everything from `// ─── Per-path decision helpers ───…` (line 211) onward stays byte-identical. The functions `collectDefinedValues`, `buildRejected`, `decidePath`, `decideAllPaths`, `groupByNodeType` keep calling `mustGet`/`countVotes`/`absentWins`/`selectWinner`/`ABSENT`/`ABSENT_KEY` — now resolved via the import.

- [ ] **Step 3: Verify lint + full unit suite green (no test file touched yet)**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-154 && pnpm lint && pnpm test`
Expected: lint clean; all unit tests pass; `derive-template.test.ts` still 20/20.

- [ ] **Step 4: Verify line counts dropped below the 400 advisory**

Run: `wc -l src/parser/docx/derive-template.ts src/parser/docx/consensus-stats.ts`
Expected: `derive-template.ts` ≈ 325 lines (< 400), `consensus-stats.ts` ≈ 130 lines.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/consensus-stats.ts src/parser/docx/derive-template.ts
git commit -m "refactor(parser): extract consensus stat helpers into consensus-stats.ts"
```

---

### Task 2: Move the helper-focused tests into `consensus-stats.test.ts`

**Files:**
- Create: `src/parser/docx/consensus-stats.test.ts`
- Modify: `src/parser/docx/derive-template.test.ts`

- [ ] **Step 1: Create `src/parser/docx/consensus-stats.test.ts` with exactly this content**

The two describe blocks are verbatim moves of "Case 4b" (lines 160–178) and "Case 4c" (lines 180–218) from `derive-template.test.ts`; `para`/`makeStyleMap` are verbatim copies of that file's fixture helpers. Test bodies unchanged.

```typescript
// Pins the semantics of the consensus-stats helpers (absentWins tie rule,
// selectWinner fallback 'mode' arm) through the public deriveTemplate API.
// Moved verbatim from derive-template.test.ts (#154).

import { describe, it, expect } from 'vitest';
import { StylePropertiesSchema } from '../../ast/index.js';
import type { StyleProperties } from '../../ast/types.js';
import type { ClassifiedParagraph } from './types.js';
import { deriveTemplate } from './derive-template.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function para(
  nodeType: ClassifiedParagraph['nodeType'],
  styleId?: string,
  isVanish = false
): ClassifiedParagraph {
  return {
    paragraph: { text: 'x', isVanish, ...(styleId ? { styleId } : {}) },
    resolvedIlvl: 0,
    nodeType,
    signalUsed: 1,
    conflicts: [],
    isVanish,
  };
}

function makeStyleMap(
  entries: ReadonlyArray<readonly [string, StyleProperties]>
): ReadonlyMap<string, StyleProperties> {
  return new Map(entries.map(([k, v]) => [k, StylePropertiesSchema.parse(v)]));
}

// ─── Absent TIE does NOT omit — falls through to intent ──────────────────────

describe('deriveTemplate — absent tie falls through', () => {
  it('absent TIE falls through to intent (does not omit) — §5 consistency-wins-else-intent', () => {
    const styles = makeStyleMap([
      ['A', StylePropertiesSchema.parse({ rPr: { sz: 20 } })],
      ['Bare', StylePropertiesSchema.parse({})],
    ]);
    // 2× A (sz:20) + 2× Bare (vote "absent" on rPr.sz) → tie 2v2:
    // absent did not STRICTLY win → share 0.5 not >0.5 → modal style A
    // (first-seen on equal counts) defines sz → intent keeps sz=20.
    const input = [para('pr1', 'A'), para('pr1', 'A'), para('pr1', 'Bare'), para('pr1', 'Bare')];
    const { rules, report } = deriveTemplate(input, styles);
    expect(rules[0]?.properties.rPr?.sz).toBe(20);
    const d = report.nodeTypes[0]?.decisions.find((x) => x.path === 'rPr.sz');
    expect(d?.source).toBe('intent');
    expect(d?.confidence).toBe(0.5);
  });
});

// ─── Fallback plain mode — low plurality, no intent, non-numeric ──────────────

describe('deriveTemplate — fallback mode arm (no majority, no intent, non-numeric)', () => {
  const styles = makeStyleMap([
    ['Plain', StylePropertiesSchema.parse({ rPr: { b: true } })],
    ['U1', StylePropertiesSchema.parse({ rPr: { u: 'single' } })],
    ['U2', StylePropertiesSchema.parse({ rPr: { u: 'double' } })],
    ['U3', StylePropertiesSchema.parse({ rPr: { u: 'dash' } })],
  ]);
  // Plain paragraphs first → modal=Plain (first-seen on equal counts) and Plain
  // does NOT define rPr.u → intent cannot fire at that path. rPr.u splits 2/2/2
  // (no >0.5 winner), absent=2 does not strictly beat any defined count, and the
  // values are strings → the waterfall genuinely reaches the final 'mode' arm.
  const classified = [
    para('pr1', 'Plain'),
    para('pr1', 'Plain'),
    para('pr1', 'U1'),
    para('pr1', 'U1'),
    para('pr1', 'U2'),
    para('pr1', 'U2'),
    para('pr1', 'U3'),
    para('pr1', 'U3'),
  ];

  it('chooses first-seen plurality value with source:mode and its true low share', () => {
    const { rules, report } = deriveTemplate(classified, styles);
    expect(rules[0]?.properties.rPr?.u).toBe('single');
    const nr = report.nodeTypes[0]!;
    expect(nr.modalStyleId).toBe('Plain');
    const d = nr.decisions.find((x) => x.path === 'rPr.u');
    expect(d?.source).toBe('mode');
    expect(d?.confidence).toBe(0.25); // 2 of 8 voters
    expect(d?.disagreesWithIntent).toBe(false); // modal style defines nothing at rPr.u
    expect(d?.rejected).toEqual([
      { value: 'double', count: 2 },
      { value: 'dash', count: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Delete the two moved describe blocks from `src/parser/docx/derive-template.test.ts`**

Delete lines 160–218 — i.e. the section comment `// ─── Case 4b: Absent TIE does NOT omit …` through the end of the `describe('deriveTemplate — fallback mode arm …')` block, including the `// ─── Case 4c …` comment between them. Nothing else in the file changes (Case 1–4, 5–8, and the barrel-surface describe all stay byte-identical).

- [ ] **Step 3: Verify the moved tests run and total count is conserved**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-154 && pnpm vitest run src/parser/docx/derive-template.test.ts src/parser/docx/consensus-stats.test.ts`
Expected: 2 files passed; `derive-template.test.ts` 18 tests, `consensus-stats.test.ts` 2 tests — total 20, same as baseline.

- [ ] **Step 4: Commit**

```bash
git add src/parser/docx/consensus-stats.test.ts src/parser/docx/derive-template.test.ts
git commit -m "test(parser): move consensus-stat semantics tests alongside consensus-stats.ts"
```

---

### Task 3: Final verification

- [ ] **Step 1: Full gate**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-154 && pnpm lint && pnpm test && pnpm build`
Expected: all green. (Unit tests only — no DB needed for this refactor.)

- [ ] **Step 2: Confirm the diff is moves + imports only**

Run: `git diff main --stat`
Expected: exactly 4 source files changed (`consensus-stats.ts` +, `derive-template.ts` −, `consensus-stats.test.ts` +, `derive-template.test.ts` −) plus this plan doc. No barrel files, no other modules.
