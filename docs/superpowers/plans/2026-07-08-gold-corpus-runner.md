# Private Local Gold-Corpus Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private, local-only binary veto (`pnpm gold:verify`) that fails when any reference-corpus file's parse drifts from a maintainer-blessed structural + confidence-band fingerprint, plus `pnpm gold:bless` to author those baselines.

**Architecture:** A pure fingerprint layer (`gold-fingerprint.ts`) reuses WS2's `buildHierarchyReport` and the existing `fixtureRecord` primitive to reduce a parsed `SpecTree` to coarse facts. A pure persistence layer (`gold-store.ts`) reads/writes the committed, Zod-validated `gold/expectations.json`. A pure decision layer (`gold-verify.ts`) diffs computed fingerprints against blessed entries and computes bless upserts. A thin CLI (`scripts/gold.ts`) does the I/O (glob → parse → compute) and prints/exits. Unit tests run on synthetic trees so they pass in CI without the gitignored corpus.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` relative imports), Zod v4, `node:fs/promises` `glob`, `tsx` for the script, vitest (unit project).

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400/file, `no-console` = error (relaxed only in `scripts/**` and `*.test.ts`), `@typescript-eslint/no-explicit-any` = error.
- TS strict+: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (`import type` for type-only), `noImplicitReturns`. No `any`, no `as unknown as` in `src/` non-test, no non-null `!` outside tests.
- **Immutability:** never mutate an input object — build a new one (`{ ...store }`).
- Local-only: **never** wire `gold:verify` into `.github/**` CI. The runner is a maintainer command.
- `gold/expectations.json` is **committed** (fingerprints are facts — Feist). The `.docx` corpus stays gitignored; do not commit any `.docx`.
- Reuse, don't duplicate: fingerprint parts/note-leak counts come from `fixtureRecord` (`src/lib/fixture-snapshot.ts`); confidence bands come from `buildHierarchyReport` (`src/lib/hierarchy-report.ts`). Do not re-implement note-leak or render logic.
- Module boundary: `src/lib/*` may import from `../ast/index.js`, `../parser/index.js`, and sibling `./` lib files — never a submodule internal.
- Every bug-fix/edge-case gets a regression test whose name states the symptom.

---

### Task 1: Fingerprint layer — `computeFingerprint` + `diffFingerprint`

**Files:**
- Create: `src/lib/gold-fingerprint.ts`
- Test: `src/lib/gold-fingerprint.test.ts`

**Interfaces:**
- Consumes: `fixtureRecord(tree, refs)` from `./fixture-snapshot.js` (returns `{ parts, noteLeaks, ... }`); `buildHierarchyReport(tree, source)` from `./hierarchy-report.js` (returns `{ paragraphs: {confidence}[] }`); `HIERARCHY_REVIEW_THRESHOLD` (= 0.6) from `./hierarchy-summary.js`; `nodeTypeToNormalizedIlvl` from `../ast/index.js` (part=0, article=1, pr1=2 … pr7=8; throws for non-structural).
- Produces:
  - `interface GoldFingerprint { readonly section: string; readonly parts: number; readonly noteLeaks: number; readonly maxDepth: number; readonly partShape: readonly (readonly number[])[]; readonly confidenceBands: ConfidenceBands }`
  - `interface ConfidenceBands { readonly high: number; readonly review: number; readonly low: number }`
  - `interface FingerprintDelta { readonly field: string; readonly expected: string; readonly actual: string }`
  - `computeFingerprint(tree: SpecTree, refs: readonly SecRef[]): GoldFingerprint`
  - `diffFingerprint(expected: GoldFingerprint, actual: GoldFingerprint): FingerprintDelta[]`
  - `const LOW_CONFIDENCE_BAND = 0.3`

**Design notes for the implementer (read before coding):**
- `source` is intentionally NOT a parameter of `computeFingerprint`. `buildHierarchyReport`'s `source` arg only drives its `unscoredReason` string, which is not fingerprinted; the `paragraphs`/bands are source-independent. Pass `null` internally.
- Bands: `low` = `confidence < LOW_CONFIDENCE_BAND` (0.3); `review` = `0.3 ≤ confidence < 0.6`; `high` = `confidence ≥ 0.6`. This is coarse on purpose so benign score jitter never forces a re-bless.
- The vanish/non-structural skip-set must match the renderers exactly: skip `meta.vanish === true` subtrees and node types `spec | note | continuation` (they have no normalized ilvl and would throw).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/gold-fingerprint.test.ts
import { describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  diffFingerprint,
  LOW_CONFIDENCE_BAND,
  type GoldFingerprint,
} from './gold-fingerprint.js';
import { HIERARCHY_REVIEW_THRESHOLD } from './hierarchy-summary.js';
import type { SpecNode, SpecNodeInference, SpecTree } from '../ast/index.js';

const inf = (confidence: number): SpecNodeInference => ({
  confidence,
  signalUsed: 4,
  agreed: [1],
  evidence: ['e'],
});

function node(
  id: string,
  type: SpecNode['type'],
  text: string,
  children: SpecNode[],
  meta: SpecNode['meta'] = {}
): SpecNode {
  return { id, type, text, children, meta };
}

// PART 1 GENERAL → { Article SUMMARY → pr1 (low 0.28); Article REFERENCES (review 0.55) },
// PART 2 PRODUCTS (high 0.95). An interleaved note must not change any count.
function sampleTree(): SpecTree {
  return {
    id: 't',
    section: '09 91 23',
    title: 'PAINTING',
    parts: [
      node('p1', 'part', 'GENERAL', [
        node('nx', 'note', 'editorial', []),
        node('a1', 'article', 'SUMMARY', [
          node('x1', 'pr1', 'Provide unit prices', [], { inference: inf(0.28) }),
        ], { inference: inf(0.9) }),
        node('a2', 'article', 'REFERENCES', [], { inference: inf(0.55) }),
      ], { inference: inf(0.95) }),
      node('p2', 'part', 'PRODUCTS', [], { inference: inf(0.95) }),
    ],
  } as SpecTree;
}

describe('computeFingerprint', () => {
  it('captures section, visible part count, and per-part structural shape', () => {
    const fp = computeFingerprint(sampleTree(), []);
    expect(fp.section).toBe('09 91 23');
    expect(fp.parts).toBe(2);
    // PART 1: [2 articles, 1 pr1] → [2, 1]; PART 2: no descendants → [].
    expect(fp.partShape).toEqual([[2, 1], []]);
    expect(fp.maxDepth).toBe(2); // deepest normalized ilvl reached: pr1 = 2
  });

  it('buckets scored paragraphs into low/review/high confidence bands', () => {
    const fp = computeFingerprint(sampleTree(), []);
    // 0.28 < 0.3 → low; 0.55 in [0.3,0.6) → review; 0.9,0.95,0.95 ≥ 0.6 → high.
    expect(fp.confidenceBands).toEqual({ high: 3, review: 1, low: 1 });
    expect(LOW_CONFIDENCE_BAND).toBeLessThan(HIERARCHY_REVIEW_THRESHOLD);
  });

  it('is deterministic — the same tree yields an identical fingerprint', () => {
    expect(computeFingerprint(sampleTree(), [])).toEqual(computeFingerprint(sampleTree(), []));
  });

  it('excludes a vanished part and its subtree from parts/shape', () => {
    const t = sampleTree();
    const parts = [...t.parts];
    parts[1] = { ...parts[1]!, meta: { vanish: true } };
    const fp = computeFingerprint({ ...t, parts } as SpecTree, []);
    expect(fp.parts).toBe(1);
    expect(fp.partShape).toEqual([[2, 1]]);
  });
});

describe('diffFingerprint', () => {
  const base = (): GoldFingerprint => computeFingerprint(sampleTree(), []);

  it('returns no deltas for identical fingerprints', () => {
    expect(diffFingerprint(base(), base())).toEqual([]);
  });

  it('flags a changed part count as a single delta', () => {
    const changed: GoldFingerprint = { ...base(), parts: 3 };
    const deltas = diffFingerprint(base(), changed);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.field).toBe('parts');
  });

  it('flags a band shift and a shape change independently', () => {
    const changed: GoldFingerprint = {
      ...base(),
      confidenceBands: { high: 2, review: 2, low: 1 },
      partShape: [[3, 1], []],
    };
    const fields = diffFingerprint(base(), changed).map((d) => d.field).sort();
    expect(fields).toEqual(['confidenceBands', 'partShape']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/gold-fingerprint.test.ts`
Expected: FAIL — `Cannot find module './gold-fingerprint.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/gold-fingerprint.ts
import type { NodeType, SecRef, SpecNode, SpecTree } from '../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../ast/index.js';
import { fixtureRecord } from './fixture-snapshot.js';
import { buildHierarchyReport } from './hierarchy-report.js';
import { HIERARCHY_REVIEW_THRESHOLD } from './hierarchy-summary.js';

/** Below this confidence a scored paragraph lands in the `low` band; `[LOW, THRESHOLD)`
 *  is `review`; `>= THRESHOLD` is `high`. Coarser than a raw score so benign jitter
 *  never forces a re-bless. */
export const LOW_CONFIDENCE_BAND = 0.3;

// The renderers' skip-set — no normalized ilvl, never counted (mirrors
// hierarchy-summary.ts / the markdown renderer).
const NON_STRUCTURAL = new Set<NodeType>(['spec', 'note', 'continuation']);

export interface ConfidenceBands {
  readonly high: number;
  readonly review: number;
  readonly low: number;
}

export interface GoldFingerprint {
  readonly section: string;
  readonly parts: number;
  readonly noteLeaks: number;
  readonly maxDepth: number;
  readonly partShape: readonly (readonly number[])[];
  readonly confidenceBands: ConfidenceBands;
}

export interface FingerprintDelta {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

// Tally structural, non-vanish descendants of `node` (inclusive) into `counts`,
// indexed by normalized ilvl. Prunes vanish subtrees and skips non-structural types.
function bucketByIlvl(node: SpecNode, counts: number[]): void {
  if (node.meta.vanish === true) return;
  if (!NON_STRUCTURAL.has(node.type)) {
    const ilvl = nodeTypeToNormalizedIlvl(node.type);
    counts[ilvl] = (counts[ilvl] ?? 0) + 1;
  }
  for (const child of node.children) bucketByIlvl(child, counts);
}

function trimTrailingZeros(counts: readonly number[]): number[] {
  let end = counts.length;
  while (end > 0 && (counts[end - 1] ?? 0) === 0) end -= 1;
  return counts.slice(0, end);
}

// Per-part shape = descendant counts by ilvl BELOW the part (index 0 = articles,
// index 1 = pr1, …), trailing zeros trimmed. counts[0] is the part itself → dropped.
function partShapeOf(part: SpecNode): number[] {
  const counts: number[] = [];
  bucketByIlvl(part, counts);
  return trimTrailingZeros(counts.slice(1));
}

function maxDepthOf(tree: SpecTree): number {
  const counts: number[] = [];
  for (const part of tree.parts) bucketByIlvl(part, counts);
  return trimTrailingZeros(counts).length - 1; // highest ilvl present; -1 if none
}

function computeBands(tree: SpecTree): ConfidenceBands {
  const { paragraphs } = buildHierarchyReport(tree, null);
  let high = 0;
  let review = 0;
  let low = 0;
  for (const p of paragraphs) {
    if (p.confidence < LOW_CONFIDENCE_BAND) low += 1;
    else if (p.confidence < HIERARCHY_REVIEW_THRESHOLD) review += 1;
    else high += 1;
  }
  return { high, review, low };
}

function visibleParts(tree: SpecTree): SpecNode[] {
  return tree.parts.filter((n) => n.type === 'part' && n.meta.vanish !== true);
}

/**
 * Coarse structural + confidence-band fingerprint of a parsed spec (WS3, #426).
 * Pure — no I/O. Reuses `fixtureRecord` for the parts/note-leak facts and
 * `buildHierarchyReport` for the confidence bands so it can never drift from the
 * renderers or the WS2 scoring report.
 */
export function computeFingerprint(tree: SpecTree, refs: readonly SecRef[]): GoldFingerprint {
  const { parts, noteLeaks } = fixtureRecord(tree, refs);
  return {
    section: tree.section,
    parts,
    noteLeaks,
    maxDepth: maxDepthOf(tree),
    partShape: visibleParts(tree).map(partShapeOf),
    confidenceBands: computeBands(tree),
  };
}

const FINGERPRINT_FIELDS: readonly (keyof GoldFingerprint)[] = [
  'section',
  'parts',
  'noteLeaks',
  'maxDepth',
  'partShape',
  'confidenceBands',
];

/** Field-by-field diff of two fingerprints; `[]` when identical. Values are
 *  JSON-stringified for a stable, printable comparison of the nested shapes. */
export function diffFingerprint(
  expected: GoldFingerprint,
  actual: GoldFingerprint
): FingerprintDelta[] {
  const deltas: FingerprintDelta[] = [];
  for (const field of FINGERPRINT_FIELDS) {
    const e = JSON.stringify(expected[field]);
    const a = JSON.stringify(actual[field]);
    if (e !== a) deltas.push({ field, expected: e, actual: a });
  }
  return deltas;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/gold-fingerprint.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint**

Run: `pnpm exec eslint src/lib/gold-fingerprint.ts src/lib/gold-fingerprint.test.ts && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gold-fingerprint.ts src/lib/gold-fingerprint.test.ts
git commit -m "feat(gold-corpus): fingerprint layer — computeFingerprint + diffFingerprint (#426)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Persistence layer — `gold-store.ts`

**Files:**
- Create: `src/lib/gold-store.ts`
- Test: `src/lib/gold-store.test.ts`

**Interfaces:**
- Consumes: `GoldFingerprint` from `./gold-fingerprint.js`; `SpecrError` from `./errors.js`; `node:fs/promises` (`readFile`, `writeFile`, `mkdir`), `node:fs` (`existsSync`), `node:path` (`dirname`); `zod`.
- Produces:
  - `interface GoldEntry { readonly fingerprint: GoldFingerprint; readonly source: string | null; readonly blessedAt: string; readonly note?: string }`
  - `type GoldStore = Record<string, GoldEntry>`
  - `const GOLD_STORE_PATH = 'gold/expectations.json'`
  - `readGoldStore(path?: string): Promise<GoldStore>` — missing file → `{}`; invalid → throws `SpecrError`.
  - `writeGoldStore(store: GoldStore, path?: string): Promise<void>` — sorted keys, 2-space indent, trailing newline.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/gold-store.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoldStore, writeGoldStore, type GoldStore } from './gold-store.js';
import { SpecrError } from './errors.js';

const TMP = join(tmpdir(), 'specr-gold-store-test');

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const entry = (section: string) => ({
  fingerprint: {
    section,
    parts: 3,
    noteLeaks: 0,
    maxDepth: 2,
    partShape: [[1], [2], []],
    confidenceBands: { high: 5, review: 1, low: 0 },
  },
  source: 'ARCAT',
  blessedAt: '2026-07-08T00:00:00.000Z',
});

describe('gold-store', () => {
  it('missing file reads back as an empty store (first-run safe)', async () => {
    expect(await readGoldStore(join(TMP, 'nope.json'))).toEqual({});
  });

  it('round-trips a store through write then read', async () => {
    const store: GoldStore = { 'ARCAT/a.docx': entry('09 91 23') };
    const path = join(TMP, 'expectations.json');
    await writeGoldStore(store, path);
    expect(await readGoldStore(path)).toEqual(store);
  });

  it('writes sorted keys with a trailing newline (stable git diffs)', async () => {
    const store: GoldStore = { 'B/b.docx': entry('2'), 'A/a.docx': entry('1') };
    const path = join(TMP, 'expectations.json');
    await writeGoldStore(store, path);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.indexOf('A/a.docx')).toBeLessThan(raw.indexOf('B/b.docx'));
  });

  it('fails loud (SpecrError) on a structurally invalid store', async () => {
    const path = join(TMP, 'bad.json');
    await mkdir(TMP, { recursive: true });
    await writeFile(path, JSON.stringify({ 'x.docx': { fingerprint: { parts: 'three' } } }));
    await expect(readGoldStore(path)).rejects.toBeInstanceOf(SpecrError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/gold-store.test.ts`
Expected: FAIL — `Cannot find module './gold-store.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/gold-store.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as z from 'zod';
import { SpecrError } from './errors.js';
import type { GoldFingerprint } from './gold-fingerprint.js';

/** Repo-relative path of the committed blessed-fingerprint store. */
export const GOLD_STORE_PATH = 'gold/expectations.json';

export interface GoldEntry {
  readonly fingerprint: GoldFingerprint;
  readonly source: string | null;
  readonly blessedAt: string;
  // string | undefined (not just optional): a store read back from disk is
  // Zod-validated and z.string().optional() admits an explicit undefined.
  readonly note?: string | undefined;
}

/** Keyed by corpus-relative file path (POSIX). Section number is NOT the key —
 *  ARCAT and CPI both ship "09 91 26", which would collide. */
export type GoldStore = Record<string, GoldEntry>;

const ConfidenceBandsSchema = z.object({
  high: z.number(),
  review: z.number(),
  low: z.number(),
});
const GoldFingerprintSchema = z.object({
  section: z.string(),
  parts: z.number(),
  noteLeaks: z.number(),
  maxDepth: z.number(),
  partShape: z.array(z.array(z.number())),
  confidenceBands: ConfidenceBandsSchema,
});
const GoldEntrySchema = z.object({
  fingerprint: GoldFingerprintSchema,
  source: z.string().nullable(),
  blessedAt: z.string(),
  note: z.string().optional(),
});
const GoldStoreSchema: z.ZodType<GoldStore> = z.record(z.string(), GoldEntrySchema);

/** Read + validate the store. A missing file is an empty store (first-run safe);
 *  a corrupt/invalid one fails loud rather than silently gating on garbage. */
export async function readGoldStore(path: string = GOLD_STORE_PATH): Promise<GoldStore> {
  if (!existsSync(path)) return {};
  const parsed = GoldStoreSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) {
    throw new SpecrError(`invalid gold store: ${path}`, { cause: parsed.error });
  }
  return parsed.data;
}

/** Write the store with sorted keys, 2-space indent, and a trailing newline so a
 *  bless produces a minimal, reviewable git diff. */
export async function writeGoldStore(
  store: GoldStore,
  path: string = GOLD_STORE_PATH
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sorted: GoldStore = {};
  for (const key of Object.keys(store).sort((a, b) => a.localeCompare(b))) {
    const value = store[key];
    if (value !== undefined) sorted[key] = value;
  }
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/gold-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `pnpm exec eslint src/lib/gold-store.ts src/lib/gold-store.test.ts && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gold-store.ts src/lib/gold-store.test.ts
git commit -m "feat(gold-corpus): committed, Zod-validated gold store (#426)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Decision layer — `verifyCorpus` + `blessEntries`

**Files:**
- Create: `src/lib/gold-verify.ts`
- Test: `src/lib/gold-verify.test.ts`

**Interfaces:**
- Consumes: `diffFingerprint`, `GoldFingerprint`, `FingerprintDelta` from `./gold-fingerprint.js`; `GoldStore`, `GoldEntry` from `./gold-store.js`.
- Produces:
  - `type CorpusResult = { readonly path: string; readonly ok: true; readonly fingerprint: GoldFingerprint } | { readonly path: string; readonly ok: false; readonly error: string }`
  - `interface VerifyFailure { readonly path: string; readonly deltas: readonly FingerprintDelta[] }`
  - `interface VerifyResult { readonly failures: readonly VerifyFailure[]; readonly gated: number; readonly ungated: number; readonly missingLocally: readonly string[] }`
  - `verifyCorpus(results: readonly CorpusResult[], store: GoldStore): VerifyResult`
  - `interface BlessMeta { readonly blessedAt: string; readonly sourceOf: (path: string) => string | null }`
  - `interface BlessResult { readonly store: GoldStore; readonly blessed: readonly string[]; readonly skipped: readonly { readonly path: string; readonly error: string }[] }`
  - `blessEntries(store: GoldStore, results: readonly CorpusResult[], meta: BlessMeta): BlessResult`

**Design notes:**
- `verifyCorpus` gates ONLY blessed paths. Un-blessed file → `ungated` (not a failure). A blessed path whose file is absent from `results` → `missingLocally`. A blessed path that now fails to parse → a failure carrying a synthetic `parse` delta.
- `blessEntries` is a pure upsert: build a new store (`{ ...store }`), never mutate the input. Preserve an existing entry's `note`. A parse failure can't be blessed → `skipped`. `blessedAt` is injected (keeps the function pure/testable).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/gold-verify.test.ts
import { describe, expect, it } from 'vitest';
import { verifyCorpus, blessEntries, type CorpusResult } from './gold-verify.js';
import type { GoldFingerprint } from './gold-fingerprint.js';
import type { GoldStore } from './gold-store.js';

const fp = (parts: number): GoldFingerprint => ({
  section: '09 91 23',
  parts,
  noteLeaks: 0,
  maxDepth: 2,
  partShape: [[1], [2], []],
  confidenceBands: { high: 5, review: 1, low: 0 },
});
const blessed = (parts: number): GoldStore['x'] => ({
  fingerprint: fp(parts),
  source: 'ARCAT',
  blessedAt: '2026-07-08T00:00:00.000Z',
});
const ok = (path: string, parts: number): CorpusResult => ({ path, ok: true, fingerprint: fp(parts) });
const fail = (path: string, error: string): CorpusResult => ({ path, ok: false, error });

describe('verifyCorpus', () => {
  it('passes when a blessed file matches its fingerprint', () => {
    const store: GoldStore = { 'a.docx': blessed(3) };
    const r = verifyCorpus([ok('a.docx', 3)], store);
    expect(r.failures).toEqual([]);
    expect(r.gated).toBe(1);
    expect(r.ungated).toBe(0);
  });

  it('fails when a blessed file drifts', () => {
    const store: GoldStore = { 'a.docx': blessed(3) };
    const r = verifyCorpus([ok('a.docx', 4)], store);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.deltas[0]!.field).toBe('parts');
  });

  it('counts an un-blessed file as ungated, not a failure', () => {
    const r = verifyCorpus([ok('new.docx', 3)], {});
    expect(r.failures).toEqual([]);
    expect(r.ungated).toBe(1);
  });

  it('reports a blessed file that is absent locally', () => {
    const store: GoldStore = { 'gone.docx': blessed(3) };
    const r = verifyCorpus([], store);
    expect(r.missingLocally).toEqual(['gone.docx']);
    expect(r.failures).toEqual([]);
  });

  it('fails a blessed file that no longer parses', () => {
    const store: GoldStore = { 'a.docx': blessed(3) };
    const r = verifyCorpus([fail('a.docx', 'boom')], store);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.deltas[0]!.actual).toContain('boom');
  });
});

describe('blessEntries', () => {
  const meta = { blessedAt: '2026-07-08T12:00:00.000Z', sourceOf: () => 'CPI' as string | null };

  it('inserts a new entry with the current fingerprint and stamped metadata', () => {
    const { store, blessed: names } = blessEntries({}, [ok('a.docx', 3)], meta);
    expect(names).toEqual(['a.docx']);
    expect(store['a.docx']!.fingerprint.parts).toBe(3);
    expect(store['a.docx']!.source).toBe('CPI');
    expect(store['a.docx']!.blessedAt).toBe('2026-07-08T12:00:00.000Z');
  });

  it('does not mutate the input store (immutability)', () => {
    const input: GoldStore = {};
    blessEntries(input, [ok('a.docx', 3)], meta);
    expect(input).toEqual({});
  });

  it('preserves an existing note on re-bless', () => {
    const input: GoldStore = {
      'a.docx': { ...blessed(3), note: 'known CPI offset' },
    };
    const { store } = blessEntries(input, [ok('a.docx', 9)], meta);
    expect(store['a.docx']!.note).toBe('known CPI offset');
    expect(store['a.docx']!.fingerprint.parts).toBe(9);
  });

  it('skips (does not bless) a file that fails to parse', () => {
    const { store, blessed: names, skipped } = blessEntries({}, [fail('bad.docx', 'boom')], meta);
    expect(names).toEqual([]);
    expect(store).toEqual({});
    expect(skipped).toEqual([{ path: 'bad.docx', error: 'boom' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/gold-verify.test.ts`
Expected: FAIL — `Cannot find module './gold-verify.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/gold-verify.ts
import { diffFingerprint } from './gold-fingerprint.js';
import type { FingerprintDelta, GoldFingerprint } from './gold-fingerprint.js';
import type { GoldStore } from './gold-store.js';

/** One corpus file's parse outcome: a fingerprint, or a parse error. */
export type CorpusResult =
  | { readonly path: string; readonly ok: true; readonly fingerprint: GoldFingerprint }
  | { readonly path: string; readonly ok: false; readonly error: string };

export interface VerifyFailure {
  readonly path: string;
  readonly deltas: readonly FingerprintDelta[];
}

export interface VerifyResult {
  readonly failures: readonly VerifyFailure[];
  readonly gated: number;
  readonly ungated: number;
  readonly missingLocally: readonly string[];
}

function parseErrorDelta(error: string): FingerprintDelta {
  return { field: 'parse', expected: 'parseable (blessed)', actual: `parse-error: ${error}` };
}

/** Compare each parsed corpus file to its blessed entry. Only blessed paths gate;
 *  un-blessed files are counted (`ungated`), blessed-but-absent files are reported
 *  (`missingLocally`), and any deviation from a blessed entry is a `failure`. */
export function verifyCorpus(results: readonly CorpusResult[], store: GoldStore): VerifyResult {
  const failures: VerifyFailure[] = [];
  let gated = 0;
  let ungated = 0;
  const seen = new Set<string>();
  for (const result of results) {
    seen.add(result.path);
    const entry = store[result.path];
    if (entry === undefined) {
      ungated += 1;
      continue;
    }
    gated += 1;
    const deltas = result.ok
      ? diffFingerprint(entry.fingerprint, result.fingerprint)
      : [parseErrorDelta(result.error)];
    if (deltas.length > 0) failures.push({ path: result.path, deltas });
  }
  const missingLocally = Object.keys(store)
    .filter((path) => !seen.has(path))
    .sort((a, b) => a.localeCompare(b));
  return { failures, gated, ungated, missingLocally };
}

export interface BlessMeta {
  readonly blessedAt: string;
  readonly sourceOf: (path: string) => string | null;
}

export interface BlessResult {
  readonly store: GoldStore;
  readonly blessed: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly error: string }[];
}

/** Pure upsert of blessed fingerprints into a NEW store (input untouched). An
 *  existing entry's `note` is preserved; unparseable files are skipped. */
export function blessEntries(
  store: GoldStore,
  results: readonly CorpusResult[],
  meta: BlessMeta
): BlessResult {
  const next: GoldStore = { ...store };
  const blessed: string[] = [];
  const skipped: { path: string; error: string }[] = [];
  for (const result of results) {
    if (!result.ok) {
      skipped.push({ path: result.path, error: result.error });
      continue;
    }
    const existingNote = next[result.path]?.note;
    next[result.path] = {
      fingerprint: result.fingerprint,
      source: meta.sourceOf(result.path),
      blessedAt: meta.blessedAt,
      ...(existingNote !== undefined ? { note: existingNote } : {}),
    };
    blessed.push(result.path);
  }
  return { store: next, blessed, skipped };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/gold-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `pnpm exec eslint src/lib/gold-verify.ts src/lib/gold-verify.test.ts && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gold-verify.ts src/lib/gold-verify.test.ts
git commit -m "feat(gold-corpus): verify + bless decision layer (#426)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: CLI runner — `scripts/gold.ts` + pnpm scripts + empty store

**Files:**
- Create: `scripts/gold.ts`
- Create: `gold/expectations.json` (content: `{}\n`)
- Modify: `package.json` (add two scripts under the existing `"fixture:diff"` line)

**Interfaces:**
- Consumes: `parse` from `../src/parser/index.js`; `computeFingerprint` from `../src/lib/gold-fingerprint.js`; `readGoldStore`, `writeGoldStore`, `GOLD_STORE_PATH` from `../src/lib/gold-store.js`; `verifyCorpus`, `blessEntries`, `CorpusResult` from `../src/lib/gold-verify.js`; `node:fs/promises` `glob`/`readFile`, `node:fs` `existsSync`, `node:path` `join`/`relative`.
- Produces: a CLI with `verify` and `bless [glob]` subcommands. `scripts/**` is exempt from `no-console` and line caps (see `eslint.config.js`) — `console.log` is the intended output channel here, mirroring `scripts/fixture-ab.ts`.

**Design notes:**
- Mirror `scripts/fixture-ab.ts` structure exactly (same `main().then(process.exit)` tail, same `existsSync('docs/references')` no-op guard).
- `sourceOf(rel)` = the first path segment under `docs/references/` (the vendor folder, e.g. `ARCAT`), or `null` if the file sits directly in the ref dir. Annotation only — never gated.

- [ ] **Step 1: Write the CLI**

```typescript
// scripts/gold.ts
import { readFile, glob } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '../src/parser/index.js';
import { computeFingerprint } from '../src/lib/gold-fingerprint.js';
import { readGoldStore, writeGoldStore, GOLD_STORE_PATH } from '../src/lib/gold-store.js';
import { verifyCorpus, blessEntries, type CorpusResult } from '../src/lib/gold-verify.js';

const PROJECT_ROOT = process.cwd();
const REF_DIR = 'docs/references';
const CORPUS_GLOB = `${REF_DIR}/**/*.{docx,sec,SEC}`;

function sourceOf(rel: string): string | null {
  const [first, ...rest] = relative(REF_DIR, rel).split(/[/\\]/);
  return rest.length > 0 && first ? first : null;
}

async function fingerprintCorpus(pattern: string): Promise<CorpusResult[]> {
  const results: CorpusResult[] = [];
  for await (const rel of glob(pattern, { cwd: PROJECT_ROOT })) {
    const abs = join(PROJECT_ROOT, rel);
    try {
      const { tree, refs } = await parse(await readFile(abs), abs);
      results.push({ path: rel, ok: true, fingerprint: computeFingerprint(tree, refs) });
    } catch (err) {
      results.push({ path: rel, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function verify(): Promise<number> {
  if (!existsSync(REF_DIR)) {
    console.log(`${REF_DIR} not present — gold:verify is a no-op (corpus is local-only).`);
    return 0;
  }
  const results = await fingerprintCorpus(CORPUS_GLOB);
  const { failures, gated, ungated, missingLocally } = verifyCorpus(results, await readGoldStore());
  for (const f of failures) {
    console.log(`\n✗ ${f.path}`);
    for (const d of f.deltas) console.log(`    ${d.field}: blessed ${d.expected} → got ${d.actual}`);
  }
  for (const path of missingLocally) console.log(`\n? ${path} (blessed but absent locally)`);
  console.log(
    `\n${gated} gated, ${ungated} ungated, ${missingLocally.length} missing-locally, ${failures.length} FAILED`
  );
  return failures.length > 0 ? 1 : 0;
}

async function bless(patternArg?: string): Promise<number> {
  if (!existsSync(REF_DIR)) {
    console.log(`${REF_DIR} not present — nothing to bless.`);
    return 0;
  }
  const results = await fingerprintCorpus(patternArg ?? CORPUS_GLOB);
  const { store, blessed, skipped } = blessEntries(await readGoldStore(), results, {
    blessedAt: new Date().toISOString(),
    sourceOf,
  });
  await writeGoldStore(store);
  for (const p of blessed) console.log(`✓ blessed ${p}`);
  for (const s of skipped) console.log(`⤫ skipped ${s.path} (${s.error})`);
  console.log(`\nblessed ${blessed.length}, skipped ${skipped.length} → ${GOLD_STORE_PATH}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'verify') return verify();
  if (cmd === 'bless') return bless(rest[0]);
  console.error('Usage: gold verify | gold bless [glob]');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
```

- [ ] **Step 2: Create the committed empty store**

Create `gold/expectations.json` with exactly:

```json
{}
```

(Ensure a trailing newline.)

- [ ] **Step 3: Add pnpm scripts**

In `package.json`, immediately after the `"fixture:diff": "tsx scripts/fixture-ab.ts diff",` line, add:

```json
    "gold:verify": "tsx scripts/gold.ts verify",
    "gold:bless": "tsx scripts/gold.ts bless",
```

- [ ] **Step 4: Verify the no-op path and lint**

Run: `pnpm exec eslint scripts/gold.ts && pnpm exec tsc --noEmit`
Expected: no errors.

Run (proves the CLI wires up and the no-corpus guard works — this is the CI-safe path):
`node -e "process.chdir(require('os').tmpdir())" ` is not needed; instead run from a dir without the corpus is impractical. Verify the store round-trips instead:
Run: `pnpm gold:verify`
Expected (corpus present locally): prints an `N gated, M ungated, …` summary and exits 0 (nothing blessed yet → 0 gated, all ungated, 0 FAILED). Confirm exit code is 0: `echo $?`.

- [ ] **Step 5: Commit**

```bash
git add scripts/gold.ts gold/expectations.json package.json
git commit -m "feat(gold-corpus): gold:verify / gold:bless CLI runner (#426)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Docs — ADR-057 + README workflow section

**Files:**
- Create: `docs/adr/057-gold-corpus-runner.md`
- Modify: `README.md` (add a "Gold-corpus regression gate" subsection near the existing testing/fixture docs)

**Design notes:** No code. The ADR follows the existing Status / Context / Decision / Consequences shape of `docs/adr/056-logging-observability-hardening.md`. Record the four locked decisions: local-only (never cloud), structural + confidence-band fingerprint, user-validated gold per file, CLI bless.

- [ ] **Step 1: Write ADR-057**

Create `docs/adr/057-gold-corpus-runner.md`:

```markdown
# ADR-057: Private local gold-corpus regression gate

## Status

Accepted (2026-07-08). Pressure-phase WS3. Implements #426. Builds on ADR-055
(hierarchy-inference confidence) and the WS2 hierarchy-scoring report (#424).

## Context

The copyrighted `.docx` reference corpus is gitignored (`docs/references/**/*.docx`),
so the two existing inference safety nets — the `corpus-parts` integration test and
the `fixture:snapshot`/`fixture:diff` A/B harness — skip in cloud CI and run only
where the docs are present. A change that breaks real-spec parsing can therefore pass
CI green, and there is no absolute, maintainer-blessed baseline to veto against.

## Decision

Add a private, local-only runner:

- **`pnpm gold:verify`** parses every corpus file, reduces each to a coarse
  `GoldFingerprint` (`section`, visible `parts`, `noteLeaks`, `maxDepth`, per-part
  structural `partShape`, and low/review/high `confidenceBands`), and compares it to a
  blessed baseline. It exits non-zero on any deviation from a blessed entry — a binary
  veto the maintainer runs before merging inference changes.
- **`pnpm gold:bless [glob]`** writes the current fingerprint as the blessed baseline,
  run only after the maintainer has visually confirmed a parse in the web UI.
- The baseline lives in **committed** `gold/expectations.json`. Fingerprints are facts
  (Feist v. Rural — facts are not copyrightable), so committing them is clean while the
  source docs stay gitignored. Only blessed entries gate; coverage grows as files are
  blessed.
- **Never wired into cloud CI.** The corpus isn't present there and must not be shipped;
  `gold:verify` is a maintainer command that no-ops when `docs/references` is absent.

The fingerprint reuses `fixtureRecord` (parts/note-leak) and `buildHierarchyReport`
(confidence bands) rather than duplicating either, so it cannot drift from the renderers
or the WS2 report.

## Consequences

- Inference regressions on real specs are caught locally by an explicit veto, not left
  to a test that silently skips.
- Bands and counts are coarse by design, so benign score jitter or whitespace changes do
  not force a re-bless; a genuine structural or confidence-distribution shift does.
- The maintainer must bless deliberately (after visual confirmation); an un-blessed file
  is reported but never gates.
- Complementary to `fixture:diff`: that answers "did my change move any fixture?" (A/B,
  no ground truth); `gold:verify` answers "does the corpus still match blessed truth?".

## Out of scope (deferred)

A public synthetic-DOCX CI tier, a web-UI bless button, and a git pre-push hook.
```

- [ ] **Step 2: Add the README section**

Add to `README.md` (near the fixture/testing docs) a subsection:

```markdown
### Gold-corpus regression gate (local, maintainer-only)

The `.docx` reference corpus is gitignored, so its inference safety nets skip in CI.
`gold:verify` is a local binary veto against a maintainer-blessed baseline
(`gold/expectations.json`, committed — fingerprints are facts, the docs are not):

```bash
pnpm gold:verify              # before merging any inference change — non-zero exit on drift
pnpm gold:bless               # after confirming parses in the web UI — bless the whole corpus
pnpm gold:bless 'docs/references/ARCAT/**/*.docx'   # bless one vendor/section
```

Bless loop: open a spec in the demo → confirm the parse is correct → `gold:bless <glob>`.
Only blessed files gate; an un-blessed file is reported, not failed. See ADR-057.
```

(Use the repo's existing README fence style; if README already nests fenced blocks, adjust the inner fence to match.)

- [ ] **Step 3: Verify docs lint (prettier, if it covers md) and links**

Run: `pnpm exec prettier --check 'docs/adr/057-gold-corpus-runner.md' 'README.md'` (if prettier is configured for markdown; otherwise skip). Fix any formatting.
Confirm the ADR number is unused: `ls docs/adr/057-*` should show only the new file.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/057-gold-corpus-runner.md README.md
git commit -m "docs(gold-corpus): ADR-057 + README workflow for the gold-corpus gate (#426)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm test` (unit project) — all green, including the 3 new test files.
- [ ] `pnpm lint` — eslint + `tsc --noEmit` + prettier clean.
- [ ] `pnpm gold:verify && echo "exit $?"` — runs against the local corpus, exits 0 (nothing blessed yet).
- [ ] `pnpm gold:bless 'docs/references/**/*.docx'` on a couple of known-good files, then `pnpm gold:verify` → still 0; then hand-edit one blessed `parts` value in `gold/expectations.json` and re-run → non-zero with a clear `parts` delta (proves the veto bites). Revert the hand-edit.
- [ ] Confirm no `.docx` is staged and `gold/expectations.json` is the only new committed data file.

## Self-Review (completed during planning)

- **Spec coverage:** Components 1–5 of the spec map to Tasks 1–5. `computeFingerprint` (C1) → T1; `gold/expectations.json` + schema (C2) → T2 (schema) + T4 (file); `gold:verify` (C3) + `gold:bless` (C4) → T3 (pure logic) + T4 (CLI); ADR + workflow doc (C5) → T5. Invariants 1–7 map to T1 (1, 6), T3 (2, 3, 4), T2 (5), and the CLI no-op (7 → T4 Step 4).
- **Deliberate deviation from spec:** `computeFingerprint` drops the `source` param — analysis shows `buildHierarchyReport`'s `source` only feeds `unscoredReason`, which is not fingerprinted, so threading it would be a meaningless argument (violates `code.md`'s over-abstraction bar). Noted in T1.
- **Type consistency:** `CorpusResult`, `GoldFingerprint`, `GoldStore`, `GoldEntry`, `FingerprintDelta` names are used identically across T1→T4. `GOLD_STORE_PATH` defined in T2, consumed in T4.
- **No placeholders:** every code step carries full source; every run step names the exact command and expected result.
```
