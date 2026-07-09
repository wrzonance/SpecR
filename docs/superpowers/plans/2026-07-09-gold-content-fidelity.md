# Gold-corpus content-fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the WS3 gold fingerprint with a `contentChars` dimension so `gold:verify` fails on silent real-paragraph text loss that structure alone misses.

**Architecture:** Add one field to `GoldFingerprint` — a whitespace-normalized character count over **real-content** nodes only (structural `part`/`article`/`pr1…pr7` + `continuation`; excluding `note`, any `vanish` subtree, and the `spec` root), aggregated per visible part (parallel to `partShape`). The interface, its helper walk, `FINGERPRINT_FIELDS`, and the gold-store Zod schema change together in one task (a lone interface change breaks `gold-store.ts`'s `z.ZodType<GoldStore>` type-check). A second task records the decision in ADR-058.

**Tech Stack:** TypeScript (strict+), Node 22, Vitest (unit project), Zod v4. Pure library code — no DB, no I/O, no API surface.

**Spec:** `docs/superpowers/specs/2026-07-09-gold-content-fidelity-design.md` · **Issue:** #428 · **Extends:** WS3 (#426, ADR-057).

## Global Constraints

- **ESM:** relative imports use `.js` extensions; type-only imports use `import type` (`verbatimModuleSyntax`).
- **TS strict+:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`. No `any`, no `as unknown as`, no type assertions across module boundaries, no non-null assertion (`!`) **outside tests** (test files may use `!`, and the existing test already does).
- **ESLint (enforced):** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400/file, `no-console` error in `src/`, `@typescript-eslint/no-explicit-any` error. Test files relax line/console caps.
- **Immutability:** never mutate inputs; construct new objects/arrays (the tests build modified trees by spreading).
- **Coupling (build-green):** adding `contentChars` to the `GoldFingerprint` interface makes `gold-store.ts` fail to type-check until `GoldFingerprintSchema` gains the field — so both move in Task 1; the build is green only at the end of Task 1, not between its file edits.
- **Lint command includes prettier:** the task's verification MUST run `pnpm lint` (= `eslint src/ && tsc --noEmit && prettier --check src/`). A prettier-only slip passes eslint+tsc but reddens CI (WS3 lesson) — `prettier --check` is mandatory before commit.
- **Do NOT run integration tests locally** — `:5432` may hold live demo data. Run **unit only**: `pnpm test` (= `vitest --project unit`, DB-free). A pre-existing 2-failure flake in `src/db/queries/open-comments.test.ts` (env autoload, reproduces on `origin/main`) is orthogonal — ignore it; it is not introduced by this work.
- **Facts stay commit-safe:** `contentChars` is a count (Feist fact); nothing about the copyrighted corpus is committed. No `gold/expectations.json` change (it is `{}` — zero blessed entries).

---

### Task 1: Add `contentChars` to the gold fingerprint

**Files:**
- Modify: `src/lib/gold-fingerprint.ts` (interface `GoldFingerprint`, add `NON_CONTENT`/`normalizedLen`/`contentCharsOf`, `computeFingerprint`, `FINGERPRINT_FIELDS`)
- Modify: `src/lib/gold-store.ts` (`GoldFingerprintSchema`)
- Test: `src/lib/gold-fingerprint.test.ts` (new content-fidelity tests)
- Test: `src/lib/gold-store.test.ts` (update the `entry()` fixture)

**Interfaces:**
- Consumes (existing, unchanged): `computeFingerprint(tree: SpecTree, refs: readonly SecRef[]): GoldFingerprint`; `diffFingerprint(expected, actual): FingerprintDelta[]`; `visibleParts(tree): SpecNode[]` (from `./fixture-snapshot.js`); the test helper `node(id, type, text, children, meta?)` and `sampleTree()` already in `gold-fingerprint.test.ts`.
- Produces: `GoldFingerprint` gains `readonly contentChars: readonly number[]` — one whitespace-normalized real-content character count per visible part, index-aligned with `partShape`. `diffFingerprint` automatically covers it (it iterates `FINGERPRINT_FIELDS`).

**Reference — expected values for `sampleTree()`** (used by the tests below). Real-content char sums, `note` excluded, per part:
- PART 1 `GENERAL`: `'GENERAL'`(7) + `'SUMMARY'`(7) + `'Provide unit prices'`(19) + `'REFERENCES'`(10) = **43** (the `'editorial'` note is excluded).
- PART 2 `PRODUCTS`: `'PRODUCTS'`(8) = **8**.
- So `contentChars` = `[43, 8]`.

- [ ] **Step 1: Write the failing tests**

Append these tests to `src/lib/gold-fingerprint.test.ts`. Put the first four inside the existing `describe('computeFingerprint', …)` block (before its closing `});` on line 94), and the last one inside the existing `describe('diffFingerprint', …)` block (before its closing `});`).

Add to `describe('computeFingerprint', …)`:

```typescript
  it('sums normalized real-content characters per visible part (contentChars)', () => {
    const fp = computeFingerprint(sampleTree(), []);
    // PART 1: 'GENERAL'(7)+'SUMMARY'(7)+'Provide unit prices'(19)+'REFERENCES'(10)=43;
    //   the 'editorial' note is excluded. PART 2: 'PRODUCTS'(8).
    expect(fp.contentChars).toEqual([43, 8]);
  });

  it('excludes note text from contentChars regardless of note size', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const children = p1.children.map((c) =>
      c.type === 'note' ? { ...c, text: 'x'.repeat(500) } : c
    );
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars[0]).toBe(43);
  });

  it('excludes a vanished subtree from contentChars', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    // Vanish the SUMMARY article: removes 'SUMMARY'(7) + 'Provide unit prices'(19) = 26.
    const children = p1.children.map((c) =>
      c.id === 'a1' ? { ...c, meta: { ...c.meta, vanish: true } } : c
    );
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars[0]).toBe(17); // 'GENERAL'(7) + 'REFERENCES'(10)
  });

  it('counts continuation body text as real content', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const a1 = p1.children.find((c) => c.id === 'a1')!;
    const a1cont = { ...a1, children: [...a1.children, node('c1', 'continuation', 'and more', [])] };
    const children = p1.children.map((c) => (c.id === 'a1' ? a1cont : c));
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars[0]).toBe(51); // 43 + 'and more'(8)
  });

  it('is immune to whitespace jitter in real-content text', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const a1 = p1.children.find((c) => c.id === 'a1')!;
    const jittered = { ...a1, children: [{ ...a1.children[0]!, text: '  Provide   unit\tprices  ' }] };
    const children = p1.children.map((c) => (c.id === 'a1' ? jittered : c));
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars).toEqual([43, 8]);
  });
```

Add to `describe('diffFingerprint', …)`:

```typescript
  it('flags text loss as a contentChars delta while structure stays quiet', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const a1 = p1.children.find((c) => c.id === 'a1')!;
    // Truncate the pr1 body (19 → 7); the node survives at the same level.
    const truncated = { ...a1, children: [{ ...a1.children[0]!, text: 'Provide' }] };
    const children = p1.children.map((c) => (c.id === 'a1' ? truncated : c));
    const actual = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    const fields = diffFingerprint(base(), actual).map((d) => d.field);
    expect(fields).toContain('contentChars'); // the loss is caught
    expect(fields).not.toContain('partShape'); // structure unchanged
    expect(fields).not.toContain('parts');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- gold-fingerprint`
Expected: FAIL — the new assertions read `fp.contentChars`, which is `undefined` (e.g. `expected undefined to deeply equal [ 43, 8 ]`). The existing tests still pass.

- [ ] **Step 3: Implement `contentChars` in `src/lib/gold-fingerprint.ts`**

3a. Add the real-content field to the interface. In `interface GoldFingerprint`, after the `confidenceBands: ConfidenceBands;` line, add:

```typescript
  readonly contentChars: readonly number[];
```

3b. Add the helpers. After the `NON_STRUCTURAL` set (near the top, after `LOW_CONFIDENCE_BAND`), add:

```typescript
// Real-content exclusions: a note's own text is editorial ("junk today"); the
// `spec` root is a wrapper. Unlike NON_STRUCTURAL, `continuation` is NOT here —
// its wrapped body text is real content that can be silently truncated.
const NON_CONTENT = new Set<NodeType>(['spec', 'note']);

// Normalized character length: whitespace runs collapsed to one space and
// trimmed, so benign reflow/whitespace jitter never changes the count.
function normalizedLen(text: string): number {
  return text.trim().replace(/\s+/g, ' ').length;
}

// Sum normalized real-content character length over `node` (inclusive) and its
// descendants. Prunes vanish subtrees; skips a note's/spec-root's OWN text but
// still recurses children — a real paragraph mis-nested under a note is still
// real content.
function contentCharsOf(node: SpecNode): number {
  if (node.meta.vanish === true) return 0;
  let sum = NON_CONTENT.has(node.type) ? 0 : normalizedLen(node.text);
  for (const child of node.children) sum += contentCharsOf(child);
  return sum;
}
```

3c. Populate the field in `computeFingerprint`. Replace the body so `visibleParts(tree)` is computed once and drives both `partShape` and `contentChars`:

```typescript
export function computeFingerprint(tree: SpecTree, refs: readonly SecRef[]): GoldFingerprint {
  const { parts, noteLeaks } = fixtureRecord(tree, refs);
  const visible = visibleParts(tree);
  return {
    section: tree.section,
    parts,
    noteLeaks,
    maxDepth: maxDepthOf(tree),
    partShape: visible.map(partShapeOf),
    confidenceBands: computeBands(tree),
    contentChars: visible.map(contentCharsOf),
  };
}
```

3d. Add the field to the diff coverage list. In `FINGERPRINT_FIELDS`, add `'contentChars'` after `'confidenceBands'`:

```typescript
const FINGERPRINT_FIELDS = [
  'section',
  'parts',
  'noteLeaks',
  'maxDepth',
  'partShape',
  'confidenceBands',
  'contentChars',
] as const satisfies readonly (keyof GoldFingerprint)[];
```

(The existing `_MissingFingerprintField extends never` guard forces this — without it the file will not type-check.)

- [ ] **Step 4: Update the gold-store schema in `src/lib/gold-store.ts`**

In `GoldFingerprintSchema`, after `confidenceBands: ConfidenceBandsSchema,`, add:

```typescript
  contentChars: z.array(z.number()),
```

This is required in the same task: `GoldStoreSchema: z.ZodType<GoldStore>` stops type-checking the moment `GoldFingerprint` has a field the schema lacks.

- [ ] **Step 5: Update the `entry()` fixture in `src/lib/gold-store.test.ts`**

In the `entry()` factory's `fingerprint` object, after `confidenceBands: { high: 5, review: 1, low: 0 },`, add:

```typescript
    contentChars: [42, 88, 0],
```

(Keeps the store round-trip/schema tests valid now that `contentChars` is a required schema field.)

- [ ] **Step 6: Run unit tests + full lint**

Run: `pnpm test -- gold-fingerprint gold-store`
Expected: PASS — all new and existing fingerprint/store tests green.

Run: `pnpm lint`
Expected: PASS — `eslint src/` clean, `tsc --noEmit` clean (the exhaustiveness guard and `z.ZodType<GoldStore>` both satisfied), `prettier --check src/` clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/gold-fingerprint.ts src/lib/gold-fingerprint.test.ts src/lib/gold-store.ts src/lib/gold-store.test.ts
git commit -m "feat(gold-corpus): add contentChars real-content fidelity to fingerprint (#428)

Whitespace-normalized character count over real-content nodes (structural
+ continuation; excludes note/vanish/spec-root), per visible part, so
gold:verify trips on silent intra-paragraph text loss that structure alone
misses. Interface + FINGERPRINT_FIELDS + gold-store schema move together to
keep the z.ZodType<GoldStore> type-check green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Record the decision — ADR-058

**Files:**
- Create: `docs/adr/058-gold-content-fidelity.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write the ADR**

Create `docs/adr/058-gold-content-fidelity.md` with exactly:

```markdown
# ADR-058: Gold-corpus content-fidelity dimension

**Status:** Accepted

## Context

The WS3 gold gate (ADR-057, `gold:verify`) reduces each corpus file to a coarse,
structural `GoldFingerprint` — `section, parts, noteLeaks, maxDepth, partShape,
confidenceBands`. It vetoes a real paragraph disappearing or being reclassified
as a note (counts change), but it is blind to a real paragraph whose text is
silently truncated while the node survives at the same level: no count changes,
the fingerprint stays green, content is lost. As the engine is iterated against a
more diverse/malformed corpus, the gate must also fail on lost words.

Constraints on any content measure: it must not red-herring when the parser
learns to strip junk better; it must survive benign edits (a typo fix must not
fail the gate); and it must remain a commit-safe fact (Feist), since the `.docx`
corpus stays gitignored.

## Decision

Add `contentChars: readonly number[]` to `GoldFingerprint` — a whitespace-
normalized character count aggregated per visible part.

- **Real content only.** Counts structural nodes (`part`/`article`/`pr1…pr7`) and
  `continuation` body text. Excludes `note` (specifier instructions), any
  `vanish` subtree, the `spec` root, and content outside any part (front matter —
  naturally excluded by the per-part aggregation). A whole-document count is
  rejected: it would trip the moment junk is stripped better.
- **Character count, whitespace-normalized** (`\s+` → single space, trimmed). Not a
  content hash — a hash trips on a single benign character change; the baseline
  must survive benign edits. Characters over words: more sensitive to partial-word
  truncation.
- **Per visible part**, parallel to `partShape`, so a diff localizes which part
  lost text and the measure is robust to intra-part reordering.

## Consequences

- `gold:verify` now trips on silent intra-paragraph text loss (a `contentChars`
  delta) while structure is unchanged — the failure the structural fingerprint
  could not see.
- **Re-bless on real-content change (accepted).** Because notes/junk are excluded,
  a correct future improvement that reclassifies currently-real-looking junk into
  a note (or strips it) lowers a part's `contentChars` and trips the gate — forcing
  a re-bless. This is the gold contract working (any change to blessed truth, better
  or worse, a human confirms once), and strictly better than a whole-document count
  that would trip on every junk-handling change.
- Tables (#300) and a "important tables vs. junk tables" model are deferred; when
  built they plug into the same real-content predicate.
- The committed store `gold/expectations.json` is `{}` (zero blessed entries), so
  the additive-required schema field needs no migration or re-bless of existing
  data.
- Extends ADR-057; the runner stays local-only, never wired into cloud CI.
```

- [ ] **Step 2: Verify the ADR renders and lint is unaffected**

Run: `pnpm lint`
Expected: PASS (ADR is markdown outside `src/`; this confirms nothing else regressed).

- [ ] **Step 3: Commit**

```bash
git add docs/adr/058-gold-content-fidelity.md
git commit -m "docs(adr): ADR-058 gold-corpus content-fidelity dimension (#428)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Spec "Component — extend `GoldFingerprint`" (`contentChars` field, `normalizedLen`, `contentCharsOf`, `FINGERPRINT_FIELDS`) → Task 1 steps 3a–3d. ✓
- Spec "Component — gold store schema" (`GoldFingerprintSchema += contentChars`, `entry()` fixture) → Task 1 steps 4–5. ✓
- Spec "Invariants → tests" 1 (per-part sums), 3 (note exclusion), 4 (vanish), 5 (continuation), 6 (whitespace immunity), 7 (text-loss trips) → Task 1 Step 1 tests. Invariant 2 (determinism) is already covered by the existing `toEqual` determinism test (now including `contentChars`); invariant 8 (Zod round-trip) by the existing gold-store round-trip test + the updated fixture. ✓
- Spec "File map" ADR-058 → Task 2. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code and exact expected values (`[43, 8]`, `17`, `51`). ✓

**3. Type consistency:** `contentChars: readonly number[]` (interface) ↔ `z.array(z.number())` (schema) ↔ `[42, 88, 0]` (fixture) ↔ `[43, 8]` (computed) all agree; `FINGERPRINT_FIELDS` literal `'contentChars'` matches the interface key (enforced by `satisfies readonly (keyof GoldFingerprint)[]` + the exhaustiveness guard). Helper names `NON_CONTENT`/`normalizedLen`/`contentCharsOf` are used consistently. ✓
