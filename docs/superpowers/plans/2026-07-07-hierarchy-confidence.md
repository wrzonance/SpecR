# Hierarchy-Inference Confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist 5-signal inference provenance per paragraph and derive a 0–1 hierarchy confidence at read time, surfaced on paragraph meta (REST + MCP) and as a `hierarchy` section in the onboarding report.

**Architecture:** Approach A from the approved spec (`docs/superpowers/specs/2026-07-07-hierarchy-confidence-design.md`): the parser records which signal won and which agreed (`paragraphs.signal_provenance` jsonb, NULL = honestly unscored); a pure scorer (`src/parser/docx/hierarchy-confidence.ts`) converts persisted facts + conflicts into `{confidence, signalUsed, agreed, evidence}` at every read, so the formula can improve without migration or reparse. A tree-walking summarizer mirrors the editability pattern for the report.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, node-pg-migrate, vitest, PostgreSQL 16.

## Global Constraints

- **Branch:** all work on `feat/hierarchy-confidence` (branched from `origin/main`). NEVER commit to `main`.
- **Commits:** Conventional Commits, scope = module changed; every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- ESLint enforced: `complexity` 10, `sonarjs/cognitive-complexity` 10, `max-lines-per-function` 50, `max-lines` 400, `no-console` error, no `any`. Test files exempt from line caps.
- TS strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (use `import type`), `.js` extensions on relative imports, no `!` outside tests.
- **`openapi.yaml` updated in the same PR as any response-shape change** (ADR-026 contract gate). No new REST routes → ADR-044 contract map unchanged.
- **Signal-derived, never vendor-keyed:** scoring inputs and evidence strings name signals (`numbering.xml`, `style chain`, `document order`, `text pattern`, `indentation`), never vendors (arcat/cpi/ufgs).
- **Zero classification drift:** no resolved tree may change. Baseline `pnpm fixture:snapshot before` is taken on `main` before Task 1; Task 8 proves `pnpm fixture:diff before after` → `0/N fixtures changed`.
- **Numbers that moved since the spec was written:** migration is `041` (latest is `040_create_clients.ts`), ADR is **055** (`054-first-class-clients.md` exists — the spec's "ADR-054" is stale).
- Unit tests: `pnpm test`. Integration: `pnpm test:integration` (needs Postgres via `docker compose up -d postgres`, then `pnpm migrate && pnpm seed`; `DATABASE_URL` from `.env`).
- DB validation style: no CHECK constraints on jsonb — Zod at the query boundary is authoritative (ADR-021); corrupt rows fail loud, never silently drop.

---

### Task 1: Canonical normalized-ilvl map in `src/ast/`

The NodeType→normalized-ilvl mapping currently lives as private constants in `inference.ts` (lines 29–55). Three consumers will need it (inference, scorer, report summarizer), so it moves to the foundational `ast/` layer. Pure refactor — behavior identical, existing tests stay green.

**Files:**
- Create: `src/ast/normalized-ilvl.ts`
- Modify: `src/ast/index.ts` (barrel export)
- Modify: `src/parser/docx/inference.ts:28-55` (delete local copies, import from ast)

**Interfaces:**
- Produces: `nodeTypeToNormalizedIlvl(nodeType: NodeType): number`, `NODE_TYPE_TO_NORMALIZED_ILVL: Partial<Record<NodeType, number>>`, `NODE_TYPES_BY_NORMALIZED_ILVL: readonly NodeType[]` — all exported from `../ast/index.js`.

- [ ] **Step 1: Create the module**

```typescript
// src/ast/normalized-ilvl.ts
import type { NodeType } from './types.js';

// Canonical normalized ilvl: part=0, article=1, pr1=2, ..., pr7=8.
// Single source of truth shared by the inference engine (signal resolution),
// the hierarchy-confidence scorer (conflict ilvl distance), and the report
// summarizer (lowConfidence entries).
export const NODE_TYPE_TO_NORMALIZED_ILVL: Partial<Record<NodeType, number>> = {
  part: 0,
  article: 1,
  pr1: 2,
  pr2: 3,
  pr3: 4,
  pr4: 5,
  pr5: 6,
  pr6: 7,
  pr7: 8,
};

export const NODE_TYPES_BY_NORMALIZED_ILVL: readonly NodeType[] = [
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
];

export function nodeTypeToNormalizedIlvl(nodeType: NodeType): number {
  return NODE_TYPE_TO_NORMALIZED_ILVL[nodeType] ?? 0;
}
```

- [ ] **Step 2: Export via the ast barrel**

In `src/ast/index.ts`, add (matching the file's existing export style):

```typescript
export {
  NODE_TYPE_TO_NORMALIZED_ILVL,
  NODE_TYPES_BY_NORMALIZED_ILVL,
  nodeTypeToNormalizedIlvl,
} from './normalized-ilvl.js';
```

- [ ] **Step 3: Refactor inference.ts to consume it**

In `src/parser/docx/inference.ts`:
- Delete the local `NODE_TYPE_TO_NORMALIZED` map (lines 28–39), `NODE_TYPES_BY_ILVL` (lines 41–51), and `toNormalizedIlvl` (lines 53–55).
- Extend the existing `../../ast/index.js` import (line 20 currently imports `getLabel, consumesNumber`) with `nodeTypeToNormalizedIlvl, NODE_TYPES_BY_NORMALIZED_ILVL`.
- Replace the two `toNormalizedIlvl(nodeType)` calls (in `trySignal1` and `trySignal2`) with `nodeTypeToNormalizedIlvl(nodeType)`.
- In `trySignal5`, replace `NODE_TYPES_BY_ILVL[estimated]` with `NODE_TYPES_BY_NORMALIZED_ILVL[estimated]`.

- [ ] **Step 4: Verify green**

Run: `pnpm test` — expect all unit tests PASS (pure refactor).
Run: `pnpm lint` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add src/ast/normalized-ilvl.ts src/ast/index.ts src/parser/docx/inference.ts
git commit -m "refactor(ast): canonical normalized-ilvl map shared via ast barrel"
```

---

### Task 2: `agreed` signals on `ClassifiedParagraph`

`classifyOne` already holds all signal `hits` when picking a winner. Record which non-winning signals *agree* with the final resolved `(nodeType, normalizedIlvl)` — i.e. post-`correctMisalignedArticle`. Disagreeing losers keep flowing to `conflicts` unchanged; signals that never fired appear in neither set.

**Files:**
- Modify: `src/parser/docx/types.ts:96-109` (`ClassifiedParagraph`)
- Modify: `src/parser/docx/inference.ts` (`buildAgreed`, `continuationResult`, `classifyOne`)
- Test: `src/parser/docx/inference.test.ts`

**Interfaces:**
- Consumes: `nodeTypeToNormalizedIlvl` from Task 1 (already imported into inference.ts).
- Produces: `ClassifiedParagraph.agreed: readonly (1 | 2 | 3 | 4 | 5)[]` — Task 4 reads it in `makeNode`.

- [ ] **Step 1: Write the failing tests**

Append to `src/parser/docx/inference.test.ts` (uses the file's existing `makePara`, `numMap`, `emptyStyleMap` helpers):

```typescript
describe('agreed signals (hierarchy-confidence provenance)', () => {
  it('signal that matches the winner nodeType+ilvl lands in agreed, not conflicts', () => {
    // S1: numId=1 ilvl=2, articleIlvl=1 → pr1 (normalized 2). S4: "A. " → pr1 (2).
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 2, text: 'A. Provide products as specified' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.agreed).toEqual([4]);
    expect(result[0]?.conflicts).toEqual([]);
  });

  it('disagreeing signal lands in conflicts, never in agreed', () => {
    // S1: ilvl=1 → article (1). S4: "A. " → pr1 (2) — disagrees.
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 1, text: 'A. Provide products as specified' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.agreed).toEqual([]);
    expect(result[0]?.conflicts.map((c) => c.signal)).toEqual([4]);
  });

  it('indentation corroboration: matching indent tier lands in agreed', () => {
    // S1: ilvl=2 → pr1 (2). S5: 1152 twips / 576 = tier 2 → pr1. No S4 pattern.
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 2, leftIndent: 1152, text: 'Some content here' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.agreed).toEqual([5]);
  });

  it('agreed is computed against the POST-correctMisalignedArticle resolution', () => {
    // S1 says article (ilvl=1) but indentation sits at tier 3 (1728 twips) with no
    // second article vote → demoted to the first non-article hit: S4 "1. " → pr2 (3).
    // S5 (tier 3 → pr2) matches the FINAL type → agreed; the losing S1 article → conflicts.
    const result = classifyParagraphs(
      [
        makePara({
          numId: 13,
          ilvl: 1,
          leftIndent: 1728,
          text: '1. Normal street clothes and shoes',
        }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('pr2');
    expect(result[0]?.signalUsed).toBe(4);
    expect(result[0]?.agreed).toEqual([5]);
    expect(result[0]?.conflicts.map((c) => c.signal)).toContain(1);
  });

  it('continuation (no signal fired) carries an empty agreed set', () => {
    const result = classifyParagraphs([makePara({ text: 'unclassifiable' })], numMap(1), emptyStyleMap());
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.agreed).toEqual([]);
  });

  it('lone indentation win: empty agreed, empty conflicts', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 1152, text: 'Loose trailing fragment' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(5);
    expect(result[0]?.agreed).toEqual([]);
    expect(result[0]?.conflicts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit src/parser/docx/inference.test.ts`
Expected: FAIL — `agreed` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement**

In `src/parser/docx/types.ts`, add to `ClassifiedParagraph` (after `conflicts`):

```typescript
  // Signals whose vote matched the FINAL resolved (nodeType, normalizedIlvl) —
  // post-correctMisalignedArticle. The winner itself is excluded; disagreeing
  // losers are in `conflicts`; signals that never fired appear in neither.
  readonly agreed: readonly (1 | 2 | 3 | 4 | 5)[];
```

In `src/parser/docx/inference.ts`:

Add beside `buildConflicts`:

```typescript
function buildAgreed(
  winner: SignalHit,
  hits: readonly SignalHit[]
): readonly (1 | 2 | 3 | 4 | 5)[] {
  return hits
    .filter(
      (h) =>
        h !== winner &&
        h.nodeType === winner.nodeType &&
        h.normalizedIlvl === winner.normalizedIlvl
    )
    .map((h) => h.signal);
}
```

In `continuationResult`, add `agreed: [],` beside `conflicts: []`.

In `classifyOne`, after `const conflicts = buildConflicts(winner, hits);` add `const agreed = buildAgreed(winner, hits);` and include `agreed,` in the returned object (after `conflicts`).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project unit src/parser/docx` then `pnpm test && pnpm lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/types.ts src/parser/docx/inference.ts src/parser/docx/inference.test.ts
git commit -m "feat(parser): record agreed signals on classified paragraphs"
```

---

### Task 3: Provenance/inference types + the read-time scorer

Types live in `ast/` (foundational layer — db validates the persisted shape, parser computes with it). The pure scorer lives in `src/parser/docx/hierarchy-confidence.ts` per the spec, exported through both barrels.

**Files:**
- Modify: `src/ast/types.ts` (add `SignalNumber`, `SignalProvenance`, `SpecNodeInference`; extend `SpecNodeMeta`)
- Modify: `src/ast/schemas.ts` (add `SignalNumberSchema`, `SignalProvenanceSchema`, `SpecNodeInferenceSchema`; extend `SpecNodeMetaSchema`)
- Modify: `src/ast/index.ts` (export new types/schemas, matching how `SignalConflict`/`SignalConflictSchema` are exported)
- Create: `src/parser/docx/hierarchy-confidence.ts`
- Modify: `src/parser/docx/index.ts` + `src/parser/index.ts` (barrel exports)
- Test: `src/parser/docx/hierarchy-confidence.test.ts`

**Interfaces:**
- Produces:
  - `type SignalNumber = 1 | 2 | 3 | 4 | 5`
  - `interface SignalProvenance { readonly signalUsed: SignalNumber; readonly agreed: readonly SignalNumber[] }` — the persisted jsonb wire shape
  - `interface SpecNodeInference { readonly confidence: number; readonly signalUsed: SignalNumber; readonly agreed: readonly SignalNumber[]; readonly evidence: readonly string[] }` — `SpecNodeMeta.inference`
  - `scoreHierarchyConfidence(provenance: SignalProvenance | null | undefined, conflicts: readonly SignalConflict[], nodeType: NodeType): SpecNodeInference | null` — from `../parser/index.js`
  - `SignalProvenanceSchema`, `SpecNodeInferenceSchema` — from `../ast/index.js`

- [ ] **Step 1: Write the failing table-driven tests**

```typescript
// src/parser/docx/hierarchy-confidence.test.ts
import { describe, expect, it } from 'vitest';
import { scoreHierarchyConfidence } from './hierarchy-confidence.js';
import type { SignalConflict, SignalNumber, SignalProvenance } from '../../ast/index.js';

const prov = (signalUsed: SignalNumber, agreed: SignalNumber[] = []): SignalProvenance => ({
  signalUsed,
  agreed,
});

const conflict = (
  signal: SignalNumber,
  reportedIlvl: number,
  reportedNodeType: SignalConflict['reportedNodeType']
): SignalConflict => ({ signal, reportedIlvl, reportedNodeType });

describe('scoreHierarchyConfidence', () => {
  it('null in → null out (unscored honesty)', () => {
    expect(scoreHierarchyConfidence(null, [], 'article')).toBeNull();
    expect(scoreHierarchyConfidence(undefined, [], 'article')).toBeNull();
  });

  it.each([
    [1, 0.95],
    [2, 0.85],
    [3, 0.6],
    [4, 0.6],
    [5, 0.35],
  ] as const)('base tier: signal %i alone scores %f', (signal, expected) => {
    const result = scoreHierarchyConfidence(prov(signal), [], 'article');
    expect(result?.confidence).toBeCloseTo(expected, 5);
  });

  it('corroboration bonus is weighted by the agreeing signal own tier and capped at 1.0', () => {
    // 0.95 + 0.15*0.85 = 1.0775 → clamp 1.0
    expect(scoreHierarchyConfidence(prov(1, [2]), [], 'article')?.confidence).toBe(1);
    // 0.6 + 0.15*0.35 = 0.6525
    expect(scoreHierarchyConfidence(prov(4, [5]), [], 'pr2')?.confidence).toBeCloseTo(0.6525, 5);
  });

  it('conflict penalty scales with ilvl distance (nodeType mismatch base + distance)', () => {
    // article = normalized 1. Conflict at ilvl 2 → 0.95 − (0.1 + 0.02·1) = 0.83
    const near = scoreHierarchyConfidence(prov(1), [conflict(4, 2, 'pr1')], 'article');
    // Conflict at ilvl 4 → 0.95 − (0.1 + 0.02·3) = 0.79
    const far = scoreHierarchyConfidence(prov(1), [conflict(4, 4, 'pr3')], 'article');
    expect(near?.confidence).toBeCloseTo(0.83, 5);
    expect(far?.confidence).toBeCloseTo(0.79, 5);
    expect(far!.confidence).toBeLessThan(near!.confidence);
  });

  it('clamps to 0 when penalties exceed the base', () => {
    const conflicts = [
      conflict(1, 5, 'pr4'),
      conflict(2, 5, 'pr4'),
      conflict(4, 5, 'pr4'),
    ];
    // 0.35 − 3·(0.1 + 0.02·3) = 0.35 − 0.48 → clamp 0  (indentation win at pr1=2)
    expect(scoreHierarchyConfidence(prov(5), conflicts, 'pr1')?.confidence).toBe(0);
  });

  it('monotonic in corroboration: adding an agreed signal never lowers the score', () => {
    const withoutAgreed = scoreHierarchyConfidence(prov(4), [conflict(1, 1, 'article')], 'pr2');
    const withAgreed = scoreHierarchyConfidence(prov(4, [5]), [conflict(1, 1, 'article')], 'pr2');
    expect(withAgreed!.confidence).toBeGreaterThanOrEqual(withoutAgreed!.confidence);
  });

  it('antitonic in disagreement: adding a conflict never raises the score', () => {
    const withoutConflict = scoreHierarchyConfidence(prov(2, [4]), [], 'article');
    const withConflict = scoreHierarchyConfidence(prov(2, [4]), [conflict(5, 3, 'pr2')], 'article');
    expect(withConflict!.confidence).toBeLessThanOrEqual(withoutConflict!.confidence);
  });

  it('score stays within [0, 1] across a broad input sweep', () => {
    const signals: SignalNumber[] = [1, 2, 3, 4, 5];
    for (const s of signals) {
      for (const agreed of [[], signals.filter((x) => x !== s)] as SignalNumber[][]) {
        for (const conflicts of [[], [conflict(3, 8, 'pr7'), conflict(5, 0, 'part')]]) {
          const r = scoreHierarchyConfidence(prov(s, agreed), conflicts, 'article');
          expect(r!.confidence).toBeGreaterThanOrEqual(0);
          expect(r!.confidence).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('evidence names signals, never vendors', () => {
    const r = scoreHierarchyConfidence(prov(5), [conflict(2, 2, 'pr1')], 'article');
    expect(r?.evidence.some((e) => e.includes('indentation'))).toBe(true);
    expect(r?.evidence.some((e) => e.includes('style chain disagreed: pr1 vs article'))).toBe(true);
    for (const line of r?.evidence ?? []) {
      expect(line.toLowerCase()).not.toMatch(/arcat|cpi|ufgs/);
    }
  });

  it('lone winner evidence: "won alone" + "no corroborating signal fired"', () => {
    const r = scoreHierarchyConfidence(prov(5), [], 'pr1');
    expect(r?.evidence).toEqual(['indentation won alone', 'no corroborating signal fired']);
  });

  it('corroborated evidence lists each agreeing signal', () => {
    const r = scoreHierarchyConfidence(prov(1, [2, 4]), [], 'article');
    expect(r?.evidence).toEqual([
      'classified by numbering.xml',
      'corroborated by style chain',
      'corroborated by text pattern',
    ]);
  });

  it('passes provenance through: signalUsed and agreed echo the input', () => {
    const r = scoreHierarchyConfidence(prov(2, [1, 4]), [], 'pr1');
    expect(r?.signalUsed).toBe(2);
    expect(r?.agreed).toEqual([1, 4]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit src/parser/docx/hierarchy-confidence.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add the AST types and schemas**

In `src/ast/types.ts`, after `SignalConflict` (line 25):

```typescript
export type SignalNumber = 1 | 2 | 3 | 4 | 5;

/**
 * Persisted 5-signal inference provenance (paragraphs.signal_provenance, ADR-055):
 * which signal won and which independently agreed with the final resolution.
 * The confidence score is derived from this at read time, never persisted.
 */
export interface SignalProvenance {
  readonly signalUsed: SignalNumber;
  readonly agreed: readonly SignalNumber[];
}

/**
 * Hierarchy-inference confidence surfaced on a paragraph (ADR-055) — derived at
 * read time from persisted provenance + conflicts. Absent === unscored (null
 * provenance: pre-provenance parse or non-DOCX source) or non-structural node.
 */
export interface SpecNodeInference {
  readonly confidence: number;
  readonly signalUsed: SignalNumber;
  readonly agreed: readonly SignalNumber[];
  readonly evidence: readonly string[];
}
```

In `SpecNodeMeta` (after `conflicts`):

```typescript
  /** Hierarchy-inference confidence (ADR-055). Absent === unscored or non-structural. */
  readonly inference?: SpecNodeInference;
```

In `src/ast/schemas.ts`, replace the inline union in `SignalConflictSchema` and add the new schemas:

```typescript
export const SignalNumberSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const SignalConflictSchema = z.object({
  signal: SignalNumberSchema,
  reportedIlvl: z.number().int(),
  reportedNodeType: NodeTypeSchema,
});

// Persisted provenance wire shape (ADR-055). CLOSED (.strict()): this is our own
// engine output — a malformed row is drift and must fail loud at the boundary.
export const SignalProvenanceSchema = z
  .object({
    signalUsed: SignalNumberSchema,
    agreed: z.array(SignalNumberSchema),
  })
  .strict();

export const SpecNodeInferenceSchema = z.object({
  confidence: z.number().min(0).max(1),
  signalUsed: SignalNumberSchema,
  agreed: z.array(SignalNumberSchema),
  evidence: z.array(z.string()),
});
```

In `SpecNodeMetaSchema` (after `conflicts`): `inference: SpecNodeInferenceSchema.exactOptional(),`

In `src/ast/index.ts`: export `SignalNumber`, `SignalProvenance`, `SpecNodeInference` (types) and `SignalNumberSchema`, `SignalProvenanceSchema`, `SpecNodeInferenceSchema` (values), matching the file's existing style.

- [ ] **Step 4: Implement the scorer**

```typescript
// src/parser/docx/hierarchy-confidence.ts
// Read-time hierarchy-inference confidence scorer (ADR-055).
//
// Persisted facts in (signal_provenance + conflicts), derived score out — the
// formula improves without migration or reparse (render-derived house style).
// Evidence strings name SIGNALS, never source vendors (standing rule:
// signal-derived, never vendor-keyed).

import type {
  NodeType,
  SignalConflict,
  SignalNumber,
  SignalProvenance,
  SpecNodeInference,
} from '../../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../../ast/index.js';

// ── Formula v1 constants (ADR-055) — acknowledged heuristics, tunable here ────
// Base = the winning signal's reliability tier (ARCHITECTURE.md 5-signal table).
const SIGNAL_TIER: Record<SignalNumber, number> = {
  1: 0.95, // numbering.xml — what Word actually respects
  2: 0.85, // style chain
  3: 0.6, // document order
  4: 0.6, // text pattern
  5: 0.35, // indentation — fallback only
};

const SIGNAL_NAME: Record<SignalNumber, string> = {
  1: 'numbering.xml',
  2: 'style chain',
  3: 'document order',
  4: 'text pattern',
  5: 'indentation',
};

// Corroboration bonus per agreed signal = weight × that signal's own tier.
const CORROBORATION_WEIGHT = 0.15;
// Every recorded conflict is a nodeType mismatch (buildConflicts only keeps
// those), so the base penalty applies per conflict; ilvl distance scales it.
const CONFLICT_BASE_PENALTY = 0.1;
const CONFLICT_ILVL_STEP = 0.02;

function buildEvidence(
  provenance: SignalProvenance,
  conflicts: readonly SignalConflict[],
  nodeType: NodeType
): string[] {
  const winner = SIGNAL_NAME[provenance.signalUsed];
  const lines: string[] = [
    provenance.agreed.length === 0 && conflicts.length === 0
      ? `${winner} won alone`
      : `classified by ${winner}`,
  ];
  for (const signal of provenance.agreed) {
    lines.push(`corroborated by ${SIGNAL_NAME[signal]}`);
  }
  if (provenance.agreed.length === 0) {
    lines.push('no corroborating signal fired');
  }
  for (const c of conflicts) {
    lines.push(`${SIGNAL_NAME[c.signal]} disagreed: ${c.reportedNodeType} vs ${nodeType}`);
  }
  return lines;
}

/**
 * Derive a 0–1 hierarchy confidence from persisted provenance + conflicts.
 * Null provenance → null (an unscored row never yields a fake number).
 * Monotonic in corroboration, antitonic in disagreement, clamped to [0, 1].
 */
export function scoreHierarchyConfidence(
  provenance: SignalProvenance | null | undefined,
  conflicts: readonly SignalConflict[],
  nodeType: NodeType
): SpecNodeInference | null {
  if (provenance === null || provenance === undefined) return null;
  const winnerIlvl = nodeTypeToNormalizedIlvl(nodeType);
  const base = SIGNAL_TIER[provenance.signalUsed];
  const bonus = provenance.agreed.reduce(
    (sum, signal) => sum + CORROBORATION_WEIGHT * SIGNAL_TIER[signal],
    0
  );
  const penalty = conflicts.reduce(
    (sum, c) => sum + CONFLICT_BASE_PENALTY + CONFLICT_ILVL_STEP * Math.abs(c.reportedIlvl - winnerIlvl),
    0
  );
  const confidence = Math.min(1, Math.max(0, base + bonus - penalty));
  return {
    confidence,
    signalUsed: provenance.signalUsed,
    agreed: provenance.agreed,
    evidence: buildEvidence(provenance, conflicts, nodeType),
  };
}
```

Barrel exports — in `src/parser/docx/index.ts` (Public exports block, ~line 240):

```typescript
export { scoreHierarchyConfidence } from './hierarchy-confidence.js';
```

In `src/parser/index.ts` (beside the other `./docx/index.js` re-exports):

```typescript
export { scoreHierarchyConfidence } from './docx/index.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run --project unit src/parser/docx/hierarchy-confidence.test.ts` then `pnpm test && pnpm lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/ast/types.ts src/ast/schemas.ts src/ast/index.ts src/parser/docx/hierarchy-confidence.ts src/parser/docx/hierarchy-confidence.test.ts src/parser/docx/index.ts src/parser/index.ts
git commit -m "feat(parser): read-time hierarchy-confidence scorer + provenance types"
```

---

### Task 4: Attach `meta.inference` to structural nodes at parse time

`makeNode` scores each structural node inline (same module, same formula the read path uses). `makeContinuationNode` is untouched — notes/continuations/vanish stay unscored by construction (classifyParagraphs routes every vanish/note to a continuation).

**Files:**
- Modify: `src/parser/docx/inference.ts` (`makeNode` only)
- Test: `src/parser/docx/inference.test.ts`

**Interfaces:**
- Consumes: `scoreHierarchyConfidence` (Task 3), `cp.agreed` (Task 2).
- Produces: `SpecNode.meta.inference` on every structural DOCX node — Task 5's `flattenDfs` persists its facts.

- [ ] **Step 1: Write the failing tests**

Append to `src/parser/docx/inference.test.ts`:

```typescript
describe('meta.inference (parse-time scoring)', () => {
  it('structural nodes carry meta.inference with confidence in [0,1]', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ numId: 1, ilvl: 1, text: '1.1 SUMMARY' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const part = tree.parts[0];
    expect(part?.meta.inference).toBeDefined();
    expect(part?.meta.inference?.confidence).toBeGreaterThanOrEqual(0);
    expect(part?.meta.inference?.confidence).toBeLessThanOrEqual(1);
    const article = part?.children[0];
    expect(article?.meta.inference?.signalUsed).toBe(1);
  });

  it('non-structural nodes (notes, continuations) never carry meta.inference', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: 'plain continuation body text' }),
        makePara({ text: '** NOTE TO SPECIFIER ** pick one', isVanish: true }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const children = tree.parts[0]?.children ?? [];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.meta.inference).toBeUndefined();
    }
  });

  it('lone-indentation node scores below the 0.6 review threshold', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ leftIndent: 1152, text: 'Loose indented fragment' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const indented = tree.parts[0]?.children[0];
    expect(indented?.meta.inference?.signalUsed).toBe(5);
    expect(indented?.meta.inference?.confidence).toBeLessThan(0.6);
    expect(indented?.meta.inference?.evidence).toContain('indentation won alone');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit src/parser/docx/inference.test.ts`
Expected: FAIL — `meta.inference` undefined on structural nodes.

- [ ] **Step 3: Implement**

In `src/parser/docx/inference.ts`:
- Import: `import { scoreHierarchyConfidence } from './hierarchy-confidence.js';`
- In `makeNode` (line ~353), before constructing `node`:

```typescript
  const inference = scoreHierarchyConfidence(
    { signalUsed: cp.signalUsed, agreed: cp.agreed },
    cp.conflicts,
    cp.nodeType
  );
```

and add to the meta spread (after the `conflicts` line):

```typescript
      ...(inference ? { inference } : {}),
```

- [ ] **Step 4: Run to verify pass + zero drift**

Run: `pnpm test && pnpm lint`
Expected: PASS. (`meta.inference` is additive — `renderMarkdown` output and tree shapes are unchanged; full corpus proof lands in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/inference.ts src/parser/docx/inference.test.ts
git commit -m "feat(parser): attach meta.inference to structural nodes at parse time"
```

---

### Task 5: Migration 041 + persistence threading + read-path derivation

Persist only the facts (`{signalUsed, agreed}`); every read derives the score. Three write sites, three read mappers, one shared derivation helper. MCP `get_paragraph` inherits the field through `ParagraphRow` automatically.

**Files:**
- Create: `src/db/migrations/041_paragraphs_signal_provenance.ts`
- Create: `src/db/queries/inference-meta.ts`
- Modify: `src/db/queries/paragraphs.ts` (FlatRow/flattenDfs/insertTree; ChainRow/toParagraphRow/getParagraphWithAncestors; SubtreeRow/buildSubtree/fetchSubtreeNode; `ParagraphRow` gains `inference?`)
- Modify: `src/db/queries/specs.ts` (ParagraphTreeRow/getSpecTree SELECT/buildNodeTree; new `getSpecSource`)
- Modify: `src/db/queries/derive.ts:111-118` (`cloneParagraphs` column lists)
- Modify: `src/db/index.ts` (export `getSpecSource` following the existing query-export pattern)
- Modify: `src/mcp/tools.ts:120-130` (`get_paragraph` description mentions `inference`)
- Test: `src/api/onboarding.integration.test.ts` (roundtrip assertions; more in Task 6)

**Interfaces:**
- Consumes: `SignalProvenanceSchema`, `SpecNodeInference` (Task 3), `scoreHierarchyConfidence` via `../../parser/index.js`.
- Produces: `deriveInference(raw: unknown, conflicts: readonly SignalConflict[], nodeType: NodeType): SpecNodeInference | undefined`; `getSpecSource(id: string): Promise<string | null>`; `paragraphs.signal_provenance` jsonb column.

- [ ] **Step 1: Migration (reversible)**

```typescript
// src/db/migrations/041_paragraphs_signal_provenance.ts
import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ADR-055: persist 5-signal hierarchy-inference provenance per paragraph.
 * Wire shape: { signalUsed: 1|2|3|4|5, agreed: (1|2|3|4|5)[] }.
 * NULL = honestly unscored (pre-provenance parse, non-DOCX source, or
 * non-structural node) — no backfill, never a fake value. The confidence
 * score is derived at READ time (scoreHierarchyConfidence), never persisted,
 * so the formula can improve without migration or reparse.
 * No CHECK on JSONB shape — the Zod schema at the query boundary is
 * authoritative (hybrid validation, ADR-021). Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    signal_provenance: { type: 'jsonb' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['signal_provenance']);
};
```

Run: `pnpm migrate` then `pnpm migrate:down && pnpm migrate` (proves both directions).

- [ ] **Step 2: Shared read-side derivation helper**

```typescript
// src/db/queries/inference-meta.ts
import { SignalProvenanceSchema } from '../../ast/index.js';
import type { NodeType, SignalConflict, SpecNodeInference } from '../../ast/index.js';
import { scoreHierarchyConfidence } from '../../parser/index.js';

/**
 * Derive `meta.inference` from the raw signal_provenance JSONB column (ADR-055).
 * NULL column → undefined (field omitted — unscored honesty); a corrupt row
 * fails loud via Zod (surfaced as DatabaseError by the calling query's catch),
 * never a silent drop. Mirrors deriveEditability (specs.ts).
 */
export function deriveInference(
  raw: unknown,
  conflicts: readonly SignalConflict[],
  nodeType: NodeType
): SpecNodeInference | undefined {
  if (raw === null || raw === undefined) return undefined;
  const provenance = SignalProvenanceSchema.parse(raw);
  return scoreHierarchyConfidence(provenance, conflicts, nodeType) ?? undefined;
}
```

Note: this adds a `db → parser` (barrel-only, acyclic) import. ADR-055 records it; precedent: `db/queries/reclassify.ts` already imports the conventions engine.

- [ ] **Step 3: Write path**

In `src/db/queries/paragraphs.ts`:
- `FlatRow` gains `readonly signalProvenance: SignalProvenance | null;` (import type `SignalProvenance` from `../../ast/index.js`).
- `flattenDfs` row push gains:

```typescript
      signalProvenance: node.meta.inference
        ? { signalUsed: node.meta.inference.signalUsed, agreed: node.meta.inference.agreed }
        : null,
```

- `insertTree` INSERT becomes:

```typescript
        `INSERT INTO paragraphs
           (id, spec_id, parent_id, node_type, text, position, vanish, conflicts, source_facts,
            signal_provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
```

with the new parameter `row.signalProvenance ? JSON.stringify(row.signalProvenance) : null` appended to the array.

In `src/db/queries/derive.ts` `cloneParagraphs` (lines 111–118): add `signal_provenance` to the INSERT column list and `p.signal_provenance` to the SELECT list (same position), so project clones keep provenance.

(`paragraph-insert.ts` and `reclassify.ts insertNoteSibling` are deliberately untouched: a manually inserted paragraph has no inference provenance — NULL is the honest value.)

- [ ] **Step 4: Read paths**

In `src/db/queries/specs.ts`:
- `ParagraphTreeRow` gains `readonly signal_provenance: unknown;`
- `getSpecTree` paragraph SELECT gains `signal_provenance` (append to the column list).
- `buildNodeTree`'s `buildNode` derives and spreads it:

```typescript
    const inference = deriveInference(
      row.signal_provenance,
      row.conflicts,
      row.node_type as NodeType
    );
```

meta gains `...(inference ? { inference } : {}),` after the `conflicts` line. Import `deriveInference` from `./inference-meta.js`.

- Add + export:

```typescript
/** The spec's persisted source label ('ufgs' | 'arcat' | 'cpi' | 'unknown'),
 *  or null when the spec does not exist. Used by the onboarding report to
 *  distinguish explicit-structure sources from unscored DOCX (ADR-055). */
export async function getSpecSource(id: string): Promise<string | null> {
  try {
    const result = await pool.query<{ source: string }>(
      'SELECT source FROM specs WHERE id = $1',
      [id]
    );
    return result.rows[0]?.source ?? null;
  } catch (err) {
    throw new DatabaseError('getSpecSource failed', { cause: err });
  }
}
```

Export `getSpecSource` through `src/db/index.ts` exactly like `getSpecTree` is.

In `src/db/queries/paragraphs.ts` (read side):
- `ChainRow` gains `readonly signalProvenance: unknown;`; both CTE arms in `getParagraphWithAncestors` select `signal_provenance` and the outer SELECT aliases `signal_provenance AS "signalProvenance"`.
- `ParagraphRow` gains:

```typescript
  /** Hierarchy-inference confidence (ADR-055). Present only when scored. */
  readonly inference?: SpecNodeInference;
```

- `toParagraphRow` derives it (reuse the existing `parseNodeType` for the cast) and spreads `...(inference ? { inference } : {})` after the `conflicts` spread:

```typescript
  const inference = deriveInference(r.signalProvenance, r.conflicts, parseNodeType(r.nodeType));
```

(Move `parseNodeType` above `toParagraphRow` if declaration order requires.)
- `SubtreeRow` gains `readonly signalProvenance: unknown;`; both `fetchSubtreeNode` CTE arms select `signal_provenance`, outer SELECT aliases `signal_provenance AS "signalProvenance"`; `buildSubtree`'s `build` derives `const inference = deriveInference(row.signalProvenance, row.conflicts, parseNodeType(row.nodeType));` (reusing the already-parsed type is fine) and meta gains `...(inference ? { inference } : {}),`.

In `src/mcp/tools.ts` `get_paragraph` description, extend the conflicts sentence: `… absent means the hierarchy was unambiguous. Scored paragraphs also carry inference — { confidence 0–1, signalUsed, agreed, evidence } derived from parse-time signal provenance; absent means unscored (pre-provenance parse or non-DOCX source).`

- [ ] **Step 5: Integration test (roundtrip: parse → persist → read)**

Add to `src/api/onboarding.integration.test.ts`, inside the existing DOCX import case (after the current report assertions), using the committed fixture already loaded there:

```typescript
    // ADR-055 roundtrip: provenance persisted, meta.inference derived on read
    const treeRes = await request(app).get(`/specs/${r.specId}`);
    expect(treeRes.status).toBe(200);
    const collect = (nodes: SpecNode[]): SpecNode[] =>
      nodes.flatMap((n) => [n, ...collect(n.children as SpecNode[])]);
    const nodes = collect(treeRes.body.data.parts as SpecNode[]);
    const structural = nodes.filter(
      (n) => !['note', 'continuation'].includes(n.type) && n.meta.vanish !== true
    );
    expect(structural.length).toBeGreaterThan(0);
    for (const n of structural) {
      expect(n.meta.inference, `node ${n.id} (${n.type}) unscored`).toBeDefined();
      expect(n.meta.inference!.confidence).toBeGreaterThanOrEqual(0);
      expect(n.meta.inference!.confidence).toBeLessThanOrEqual(1);
    }
    for (const n of nodes.filter((x) => ['note', 'continuation'].includes(x.type))) {
      expect(n.meta.inference).toBeUndefined();
    }
```

(Match the file's actual request helper/app import style; add `import type { SpecNode } from '../ast/index.js';` if absent.)

- [ ] **Step 6: Verify**

Run: `pnpm test && pnpm lint` — PASS/clean.
Run: `pnpm test:integration` (Postgres up, migrated, seeded) — PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/041_paragraphs_signal_provenance.ts src/db/queries/inference-meta.ts src/db/queries/paragraphs.ts src/db/queries/specs.ts src/db/queries/derive.ts src/db/index.ts src/mcp/tools.ts src/api/onboarding.integration.test.ts
git commit -m "feat(db): persist signal provenance and derive meta.inference on read"
```

---

### Task 6: `hierarchy` section in the onboarding report (REST + MCP)

Mirror of `editability-summary.ts`: pure tree walk shared by both surfaces so they cannot drift. `unscored` always carries its reason; a SEC-sourced spec reads as "explicit structure", never as suspect.

**Files:**
- Create: `src/lib/hierarchy-summary.ts`
- Modify: `src/lib/jobs.ts:103-110` (`OnboardingReport` gains `hierarchy`)
- Modify: `src/api/onboarding.ts:216-252` (`classifyAndSummarize` returns both summaries)
- Modify: `src/mcp/onboarding-handlers.ts:97-132` (`buildReport` gains hierarchy)
- Modify: `src/mcp/onboarding-tools.ts:43-54` (description mentions hierarchy)
- Test: `src/lib/hierarchy-summary.test.ts`, plus assertions in `src/api/onboarding.integration.test.ts` and `src/mcp/onboarding.integration.test.ts`

**Interfaces:**
- Consumes: `SpecNodeInference` on `meta` (Task 5 read path), `getSpecSource` (Task 5), `nodeTypeToNormalizedIlvl` (Task 1).
- Produces: `HIERARCHY_REVIEW_THRESHOLD = 0.6`, `interface HierarchySummary`, `summarizeHierarchy(tree: SpecTree, source: string | null, threshold?: number): HierarchySummary`.

- [ ] **Step 1: Write the failing unit tests**

```typescript
// src/lib/hierarchy-summary.test.ts
import { describe, expect, it } from 'vitest';
import {
  HIERARCHY_REVIEW_THRESHOLD,
  summarizeHierarchy,
} from './hierarchy-summary.js';
import type { SpecNode, SpecNodeInference, SpecTree } from '../ast/index.js';

const inf = (confidence: number): SpecNodeInference => ({
  confidence,
  signalUsed: 5,
  agreed: [],
  evidence: ['indentation won alone', 'no corroborating signal fired'],
});

const node = (
  id: string,
  type: SpecNode['type'],
  meta: SpecNode['meta'] = {},
  children: SpecNode[] = []
): SpecNode => ({ id, type, text: 't', children, meta });

const tree = (parts: SpecNode[]): SpecTree => ({ id: 'e0f1a2b3-0000-4000-8000-000000000000', section: '01 10 00', title: 'T', parts });

describe('summarizeHierarchy', () => {
  it('buckets scored / unscored / belowThreshold and sorts lowConfidence worst-first', () => {
    const t = tree([
      node('p1', 'part', { inference: inf(0.95) }, [
        node('a1', 'article', { inference: inf(0.35) }),
        node('a2', 'article', { inference: inf(0.5) }),
        node('a3', 'article', {}), // unscored structural
        node('n1', 'note', {}), // non-structural — never counted
        node('c1', 'continuation', {}),
      ]),
    ]);
    const s = summarizeHierarchy(t, 'unknown');
    expect(s.counts).toEqual({ scored: 3, unscored: 1, belowThreshold: 2 });
    expect(s.lowConfidence.map((e) => e.nodeId)).toEqual(['a1', 'a2']); // ascending confidence
    expect(s.lowConfidence[0]).toMatchObject({ nodeType: 'article', ilvl: 1, confidence: 0.35 });
    expect(s.lowConfidence[0]?.evidence).toContain('indentation won alone');
  });

  it('vanish nodes are skipped entirely', () => {
    const t = tree([node('p1', 'part', { inference: inf(0.9) }, [
      node('a1', 'article', { vanish: true }),
    ])]);
    expect(summarizeHierarchy(t, 'unknown').counts).toEqual({
      scored: 1,
      unscored: 0,
      belowThreshold: 0,
    });
  });

  it('unscoredReason absent when everything is scored', () => {
    const t = tree([node('p1', 'part', { inference: inf(0.9) })]);
    expect(summarizeHierarchy(t, 'unknown').unscoredReason).toBeUndefined();
  });

  it('SEC source reads as explicit structure, never suspect', () => {
    const t = tree([node('p1', 'part', {})]);
    const s = summarizeHierarchy(t, 'ufgs');
    expect(s.counts).toEqual({ scored: 0, unscored: 1, belowThreshold: 0 });
    expect(s.unscoredReason).toContain('explicit structure');
    expect(s.unscoredReason).not.toMatch(/re-import/);
  });

  it('unscored DOCX carries the re-import upgrade path', () => {
    const t = tree([node('p1', 'part', {})]);
    expect(summarizeHierarchy(t, 'unknown').unscoredReason).toContain('re-import');
  });

  it('threshold boundary: exactly 0.6 is NOT low-confidence', () => {
    const t = tree([node('p1', 'part', { inference: inf(HIERARCHY_REVIEW_THRESHOLD) })]);
    expect(summarizeHierarchy(t, 'unknown').counts.belowThreshold).toBe(0);
  });

  it('empty tree → all-zero counts, empty list', () => {
    expect(summarizeHierarchy(tree([]), 'unknown')).toEqual({
      counts: { scored: 0, unscored: 0, belowThreshold: 0 },
      lowConfidence: [],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit src/lib/hierarchy-summary.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the summarizer**

```typescript
// src/lib/hierarchy-summary.ts
import type { NodeType, SpecNode, SpecTree } from '../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../ast/index.js';

/** Below this hierarchy-inference confidence a paragraph is surfaced for human
 *  review (ADR-055; mirrors editability's LOW_CONFIDENCE_THRESHOLD pattern). */
export const HIERARCHY_REVIEW_THRESHOLD = 0.6;

export interface HierarchyLowConfidenceEntry {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly ilvl: number;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

export interface HierarchySummary {
  readonly counts: {
    readonly scored: number;
    readonly unscored: number;
    readonly belowThreshold: number;
  };
  /** Present when unscored > 0 — why, never folded into another bucket (ADR-055). */
  readonly unscoredReason?: string;
  /** Scored paragraphs below the review threshold, worst-first. */
  readonly lowConfidence: readonly HierarchyLowConfidenceEntry[];
}

// Non-structural node types are never scored (same skip-set the renderers use);
// vanish nodes are skipped via the meta flag.
const NON_STRUCTURAL = new Set<NodeType>(['spec', 'note', 'continuation']);

const EXPLICIT_STRUCTURE_REASON =
  'explicit structure from source markup — no inference to score';
const PRE_PROVENANCE_REASON =
  'no inference provenance recorded (pre-provenance parse or manually inserted paragraph) — re-import the master to score';

interface Acc {
  scored: number;
  unscored: number;
  belowThreshold: number;
  readonly lowConfidence: HierarchyLowConfidenceEntry[];
}

function tally(n: SpecNode, acc: Acc, threshold: number): void {
  const inference = n.meta.inference;
  if (!inference) {
    acc.unscored += 1;
    return;
  }
  acc.scored += 1;
  if (inference.confidence < threshold) {
    acc.belowThreshold += 1;
    acc.lowConfidence.push({
      nodeId: n.id,
      nodeType: n.type,
      ilvl: nodeTypeToNormalizedIlvl(n.type),
      confidence: inference.confidence,
      evidence: inference.evidence,
    });
  }
}

function walk(nodes: readonly SpecNode[], acc: Acc, threshold: number): void {
  for (const n of nodes) {
    if (!NON_STRUCTURAL.has(n.type) && n.meta.vanish !== true) {
      tally(n, acc, threshold);
    }
    walk(n.children, acc, threshold);
  }
}

/**
 * Summarize hierarchy-inference confidence over a spec tree (ADR-055): counts of
 * scored/unscored/below-threshold structural paragraphs plus the worst-first
 * triage list. `source` is the spec's persisted source label — an explicit-
 * structure source ('ufgs' = SpecsIntact SEC markup) is unscored by design, not
 * suspect. Shared by the REST onboarding report and the MCP
 * `get_onboarding_report` tool so the two cannot drift.
 */
export function summarizeHierarchy(
  tree: SpecTree,
  source: string | null,
  threshold: number = HIERARCHY_REVIEW_THRESHOLD
): HierarchySummary {
  const acc: Acc = { scored: 0, unscored: 0, belowThreshold: 0, lowConfidence: [] };
  walk(tree.parts, acc, threshold);
  const lowConfidence = [...acc.lowConfidence].sort(
    (a, b) => a.confidence - b.confidence || a.nodeId.localeCompare(b.nodeId)
  );
  return {
    counts: { scored: acc.scored, unscored: acc.unscored, belowThreshold: acc.belowThreshold },
    ...(acc.unscored > 0
      ? { unscoredReason: source === 'ufgs' ? EXPLICIT_STRUCTURE_REASON : PRE_PROVENANCE_REASON }
      : {}),
    lowConfidence,
  };
}
```

- [ ] **Step 4: Wire the report type + REST builder**

In `src/lib/jobs.ts`, add `import type { HierarchySummary } from './hierarchy-summary.js';` and extend `OnboardingReport`:

```typescript
  readonly editability: EditabilitySummary;
  /** Hierarchy-inference confidence summary (ADR-055). */
  readonly hierarchy: HierarchySummary;
```

In `src/api/onboarding.ts`, extend imports (`summarizeHierarchy` from `../lib/hierarchy-summary.js`, `getSpecSource` from `../db/index.js`) and change `classifyAndSummarize`:

```typescript
async function classifyAndSummarize(
  jobId: string,
  specId: string
): Promise<Pick<OnboardingReport, 'editability' | 'hierarchy'>> {
  progress(jobId, 'classifying', 85);
  await reclassifySpec(specId, {});
  const treeResult = await getSpecTree(specId);
  if (!treeResult) throw new Error('classified spec vanished before summary');
  const source = await getSpecSource(specId);
  return {
    editability: summarizeEditability(treeResult.tree),
    hierarchy: summarizeHierarchy(treeResult.tree, source),
  };
}
```

and in `processOnboardingJob` replace `const editability = await classifyAndSummarize(...)` with `const summaries = await classifyAndSummarize(jobId, specId);` and build `report` with `editability: summaries.editability, hierarchy: summaries.hierarchy,`.

- [ ] **Step 5: Wire the MCP report**

In `src/mcp/onboarding-handlers.ts`: import `summarizeHierarchy` from `../lib/hierarchy-summary.js` and add `getSpecSource` to the existing `../db/index.js` import. `buildReport` gains a `source: string | null` parameter and the returned object gains `hierarchy: summarizeHierarchy(tree, source),` (after `editability`). In `handleGetOnboardingReport`, fetch `const source = await getSpecSource(specId);` beside the other lookups and pass it through.

In `src/mcp/onboarding-tools.ts`, extend the `get_onboarding_report` description: `…editability summary (counts + low-confidence nodes), hierarchy-inference confidence summary (scored/unscored/belowThreshold counts + worst-first low-confidence nodes; unscored carries its reason), assigned style source, …`.

- [ ] **Step 6: Integration assertions**

`src/api/onboarding.integration.test.ts` — in the DOCX import case:

```typescript
    expect(r.report.hierarchy.counts.scored).toBeGreaterThan(0);
    expect(r.report.hierarchy.counts.unscored).toBe(0);
    expect(r.report.hierarchy.counts.belowThreshold).toBeGreaterThanOrEqual(0);
```

In the SEC import case:

```typescript
    expect(r.report.hierarchy.counts.scored).toBe(0);
    expect(r.report.hierarchy.counts.unscored).toBeGreaterThan(0);
    expect(r.report.hierarchy.unscoredReason).toContain('explicit structure');
```

`src/mcp/onboarding.integration.test.ts` — in the `get_onboarding_report` success case, extend the parsed-data type with `hierarchy: { counts: Record<string, number> }` and assert:

```typescript
    expect(data.hierarchy.counts).toMatchObject({
      scored: expect.any(Number),
      unscored: expect.any(Number),
      belowThreshold: expect.any(Number),
    });
```

- [ ] **Step 7: Verify**

Run: `pnpm test && pnpm lint && pnpm test:integration`
Expected: PASS/clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/hierarchy-summary.ts src/lib/hierarchy-summary.test.ts src/lib/jobs.ts src/api/onboarding.ts src/mcp/onboarding-handlers.ts src/mcp/onboarding-tools.ts src/api/onboarding.integration.test.ts src/mcp/onboarding.integration.test.ts
git commit -m "feat(api): hierarchy section in onboarding report (REST + MCP)"
```

---

### Task 7: openapi.yaml contract (same PR, lockstep)

Two component additions, two reference sites. No new operations → ADR-044 contract map untouched. The Ajv gate (`src/api/contract.integration.test.ts`) validates the changed `OnboardingReport` automatically.

**Files:**
- Modify: `openapi.yaml` (components ~line 5083 after `SignalConflict`; `SpecNode.meta` ~line 5207; `EditabilitySummary` neighborhood ~line 5015)

**Interfaces:**
- Consumes: response shapes produced in Tasks 5–6 (must match exactly: required arrays, enum values, min/max).

- [ ] **Step 1: Add `SpecNodeInference` component** (directly after the `SignalConflict` schema):

```yaml
    SpecNodeInference:
      type: object
      required: [confidence, signalUsed, agreed, evidence]
      description: >-
        Hierarchy-inference confidence for this paragraph (ADR-055), derived at
        read time from persisted signal provenance and conflicts. Absent when
        the paragraph has no provenance (pre-provenance parse or non-DOCX
        source) or is non-structural (note/continuation/hidden).
      properties:
        confidence:
          type: number
          minimum: 0
          maximum: 1
        signalUsed:
          type: integer
          enum: [1, 2, 3, 4, 5]
          description: The winning inference signal (1 numbering.xml, 2 style chain, 3 document order, 4 text pattern, 5 indentation)
        agreed:
          type: array
          description: Signals whose vote matched the final resolved classification
          items:
            type: integer
            enum: [1, 2, 3, 4, 5]
        evidence:
          type: array
          description: Human-readable why-chain. Names signals, never source vendors.
          items:
            type: string
```

- [ ] **Step 2: Reference it from `SpecNode.meta`** (after the `editability` property):

```yaml
            inference:
              $ref: '#/components/schemas/SpecNodeInference'
```

- [ ] **Step 3: Add `HierarchySummary` component** (beside `EditabilitySummary`):

```yaml
    HierarchySummary:
      type: object
      required: [counts, lowConfidence]
      properties:
        counts:
          type: object
          required: [scored, unscored, belowThreshold]
          properties:
            scored: { type: integer }
            unscored: { type: integer }
            belowThreshold: { type: integer }
        unscoredReason:
          type: string
          description: >-
            Present when unscored > 0 — why those paragraphs carry no score
            (explicit-structure source vs pre-provenance parse). Never folded
            into another bucket.
        lowConfidence:
          type: array
          description: Scored paragraphs below the hierarchy review threshold (0.6), worst-first.
          items:
            type: object
            required: [nodeId, nodeType, ilvl, confidence, evidence]
            properties:
              nodeId: { type: string, format: uuid }
              nodeType:
                type: string
                enum: [part, article, pr1, pr2, pr3, pr4, pr5, pr6, pr7]
              ilvl: { type: integer, minimum: 0, maximum: 8 }
              confidence: { type: number, minimum: 0, maximum: 1 }
              evidence:
                type: array
                items: { type: string }
```

- [ ] **Step 4: Wire into `OnboardingReport`** — add `hierarchy` to its `required` list and properties:

```yaml
        hierarchy:
          $ref: '#/components/schemas/HierarchySummary'
```

- [ ] **Step 5: Verify the contract gate**

Run: `pnpm test:integration` (includes `src/api/contract.integration.test.ts`)
Expected: PASS — spec parses, structural coverage unchanged, response validation green.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml
git commit -m "docs(api): openapi contract for meta.inference + report hierarchy section"
```

---

### Task 8: ADR-055, architecture docs, full verification

**Files:**
- Create: `docs/adr/055-hierarchy-inference-confidence.md`
- Modify: `ARCHITECTURE.md` (5-Signal section, ~line 214 conflict-persistence paragraph; Module Boundaries db line)

- [ ] **Step 1: Write ADR-055** (Status / Context / Decision / Consequences, ~70 lines — ADR-054 is the length/format template):

```markdown
# ADR-055: Hierarchy-inference confidence — provenance jsonb + read-time scorer

## Status

Accepted (2026-07-07). Implements the approved design in
`docs/superpowers/specs/2026-07-07-hierarchy-confidence-design.md`.
(The design doc reserved "ADR-054"; 054 was taken by first-class-clients.)

## Context

The 5-signal DOCX inference engine records *disagreement* (`paragraphs.conflicts`
→ `meta.conflicts`) but not how strongly the winner was supported: a paragraph
classified by the indentation fallback alone looked identical to one nailed by
numbering.xml with full corroboration — both had empty conflicts. Editability
classification and style consensus already expose 0–1 confidence in the API
contract; hierarchy inference did not, so human review triage (onboarding
report, future review canvas #143) had nothing to rank by. The blind spot of
unanimous-but-weak wins is the point: disagreement alone is not enough.

## Decision

1. **Persist facts, derive the score at read time.** New nullable
   `paragraphs.signal_provenance` jsonb (migration 041):
   `{ signalUsed: 1–5, agreed: (1–5)[] }`. A signal is `agreed` when its vote
   matches the FINAL resolved (nodeType, normalizedIlvl) — post-
   `correctMisalignedArticle`. `scoreHierarchyConfidence`
   (`src/parser/docx/hierarchy-confidence.ts`) derives
   `{ confidence, signalUsed, agreed, evidence }` from provenance + conflicts at
   every read (render-derived house style) — formula v1's constants (base =
   signal reliability tier 0.95/0.85/0.6/0.6/0.35, corroboration weight 0.15,
   conflict penalty 0.1 + 0.02·ilvl-distance, clamp [0,1], review threshold 0.6)
   are acknowledged heuristics, tunable without migration or reparse.
2. **Unscored honesty.** NULL provenance (pre-provenance parse, non-DOCX source,
   manually inserted paragraph, non-structural node) never yields a number
   anywhere; the report's `unscored` bucket carries its reason, and an
   explicit-structure source (`ufgs`/SEC) reads as by-design, never suspect.
3. **Signal-derived, never vendor-keyed** (standing rule): scoring inputs and
   evidence strings name signals ("indentation won alone", "style chain
   disagreed: pr1 vs article"), never vendors.
4. **Surfaces in contract lockstep:** `meta.inference` on every paragraph read
   (`GET /specs/{id}`, paragraph write responses, MCP `get_paragraph`) and a
   `hierarchy` section in the onboarding report (REST job + MCP
   `get_onboarding_report`), mirrored on the editability summary pattern
   (`src/lib/hierarchy-summary.ts`). `conflicts` remains untouched — persisted,
   never dropped.
5. **db → parser (barrel-only) import accepted.** The read mappers derive
   `meta.inference` via `deriveInference` (`src/db/queries/inference-meta.ts`),
   which validates the raw jsonb (Zod, fail-loud) and calls the parser's pure
   scorer. Acyclic; precedent: `db/queries/reclassify.ts` already imports the
   conventions engine.

## Consequences

- Reparse/re-import is the upgrade path for pre-provenance rows (reclassify
  touches only the `classification` column); the report says so.
- A numbering-profile demotion (#317/#319) lands in `conflicts`, so the score
  drops naturally; profile-`tier` authority as a scoring input is deferred
  (#319 territory).
- Deferred (spec "out of scope"): spec-level aggregate rollup on spec reads,
  threshold configurability (env/profile), import-time quality gating.
- Zero classification drift proven by fixture A/B (`pnpm fixture:snapshot/diff`)
  over the local corpus: byte-identical renders before/after.
```

- [ ] **Step 2: Update ARCHITECTURE.md**

In the 5-Signal Inference Engine section, after the conflict-persistence paragraph, add:

```markdown
Winner provenance is persisted alongside conflicts (ADR-055): `paragraphs.signal_provenance` (nullable JSONB) records `{ signalUsed, agreed }` — which signal won and which independently agreed with the final resolution. A pure read-time scorer (`src/parser/docx/hierarchy-confidence.ts`, exported via the parser barrel) derives `meta.inference` = `{ confidence 0–1, signalUsed, agreed, evidence[] }` from provenance + conflicts on every read, so the formula can improve without migration or reparse. NULL provenance = honestly unscored (pre-provenance parse or explicit-structure source), never a fake number. The onboarding report's `hierarchy` section (`src/lib/hierarchy-summary.ts`, review threshold 0.6) triages scored paragraphs worst-first.
```

In Module Boundaries, extend the `db/` line comment:

```text
db/        ← knows about AST types and pg; domain engines only via barrels (conventions classify, parser read-time scorer — ADR-055)
```

- [ ] **Step 3: Full verification**

```bash
pnpm lint
pnpm test
pnpm test:integration          # Postgres up, migrated, seeded
pnpm fixture:snapshot after
pnpm fixture:diff before after # MUST print "0/N fixtures changed"
git diff main...HEAD --stat    # sanity: total real-code delta near the ~500 LOC target
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/055-hierarchy-inference-confidence.md ARCHITECTURE.md
git commit -m "docs(adr): ADR-055 hierarchy-inference confidence + architecture notes"
```

---

## Self-Review Notes (spec ↔ plan)

- Spec §Decisions 1–6 → Tasks 6 (triage consumer), 2+5 (winner provenance persisted), 3 (scalar+threshold), 5–7 (V1 surfaces, contract lockstep), 3+5 (Approach A), 3 (signal-named evidence).
- Spec §Edge cases: non-structural skip (Tasks 4, 6), SEC vs unscored-DOCX distinction (Task 6 `getSpecSource`), profile overrides land in conflicts → score drops naturally (no code needed; ADR notes), reparse repopulates (persistParsedSpec delete+reinsert; reclassify never touches the column — reason string says "re-import", deliberately correcting the spec's "reclassify to score" copy, since `reclassifySpec` only rewrites `classification`).
- Spec §Invariants 1–4 → Task 8 fixture A/B; Task 3 null→null + [0,1] + monotonicity tests; Task 3 vendor-name regex test.
- Spec §Chunking: if the final diff runs far past ~500 real LOC, split at the Task 5/Task 6 boundary (PR 1 = Tasks 1–5 + their openapi share; PR 2 = Tasks 6–7 report section). Both independently green.
