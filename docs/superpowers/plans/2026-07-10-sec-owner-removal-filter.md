# SEC Owner-Removal Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `.SEC` egress renderer filter owner-removed (`meta.vanish`) body paragraphs and their subtrees, matching the DOCX and Markdown renderers, so removed content never appears in a `.SEC` export.

**Architecture:** `generateSec` (`src/generator/sec/index.ts`) already suppresses vanished *continuations* and vanished *roots*, but renders vanished structural body nodes (`pr1`–`pr7` and articles) as ordinary `<SPT>/<LST>/<ITM>`. Introduce a single `isHidden(node)` predicate ("a non-note node flagged `vanish` is filtered — note always stays as `<NTE>`") and apply it at the two remaining render sites (`renderChildren` for pr-tiers, `renderPart` for articles). This is a **filter** decision, not **encode**: SEC's `vanish` column already means "specifier note" (`<NTE>`), so encoding owner-removal would require inventing a non-standard marker; filtering matches the two owner-facing renderers and the intent of #251 removal.

**Tech Stack:** TypeScript / Node 22, vitest, ESM.

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, no `console`, no `any`, no non-null `!` outside tests.
- TypeScript strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (`import type` for type-only imports, `.js` extensions on relative imports).
- Coverage is a diagnostic, not a target. Pin the fix with a regression test named for the symptom.
- Commit scope = module changed: `feat(generator): …`. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `openapi.yaml` is authoritative; any prose that becomes false must be fixed in the same PR (the `/removal` description's SEC "Known limitation" paragraph).
- Non-obvious approach choice (filter vs encode) → ADR-060.

---

### Task 1: Filter vanished body nodes from SEC egress

**Files:**
- Modify: `src/generator/sec/index.ts` (add `isHidden`; guard `renderChildren` and `renderPart`; fix now-false comments)
- Test: `src/generator/sec/index.test.ts` (replace the `KNOWN LIMITATION (#278)` test with a filter regression; add an article + subtree case)
- Modify: `openapi.yaml` (`/removal` description — SEC is now removal-aware)
- Create: `docs/adr/060-sec-egress-filters-owner-removal.md`

**Interfaces:**
- Produces: `isHidden(node: SpecNode): boolean` — `node.type !== 'note' && node.meta.vanish === true`. Internal to `src/generator/sec/index.ts`.
- No change to the exported `generateSec(tree, refs?)` signature.

**Invariant to pin:** for any tree, `generateSec` emits no element (and no descendant element) for a non-note node whose `meta.vanish === true`; a `note` node always emits `<NTE>` regardless of `vanish`; PART ordinals are unaffected (already covered by existing tests).

- [ ] **Step 1: Rewrite the failing test.** Replace the `KNOWN LIMITATION (#278)` test in `index.test.ts` (currently asserting a vanished `pr1` reappears) with a regression asserting the removed paragraph and its subtree are absent from the SEC output and from the re-parsed tree. Add a sibling case for a vanished *article* carrying children, asserting the whole subtree is filtered while a visible sibling survives.

```typescript
it('SEC egress: owner-removal (vanish) filters a body paragraph and its subtree (#278)', () => {
  const tree: SpecTree = {
    id: 't1', section: '27 10 00', title: 'BUILDING TELECOMMUNICATIONS CABLING SYSTEM',
    parts: [{ id: 'p1', type: 'part', text: 'GENERAL', meta: {}, children: [
      { id: 's1', type: 'article', text: 'SUMMARY', meta: {}, children: [
        { id: 'keep', type: 'pr1', text: 'Kept paragraph.', children: [], meta: {} },
        { id: 'r1', type: 'pr1', text: 'Removed paragraph.', meta: { vanish: true }, children: [
          { id: 'r1a', type: 'pr2', text: 'Removed child.', children: [], meta: {} },
        ]},
      ]},
    ]}],
  };
  const xml = generateSec(tree);
  expect(xml).not.toContain('Removed paragraph.');
  expect(xml).not.toContain('Removed child.');
  expect(xml).toContain('Kept paragraph.');
  const after = parseSec(xml).tree;
  const summary = after.parts[0]?.children[0];
  expect(summary?.children.map((c) => c.text)).toEqual(['Kept paragraph.']);
});

it('SEC egress: a vanished article and its whole subtree are filtered; visible peers survive (#278)', () => {
  const tree: SpecTree = {
    id: 't2', section: '27 10 00', title: 'T',
    parts: [{ id: 'p1', type: 'part', text: 'GENERAL', meta: {}, children: [
      { id: 'hidden', type: 'article', text: 'REMOVED ARTICLE', meta: { vanish: true }, children: [
        { id: 'x', type: 'pr1', text: 'child of removed article', children: [], meta: {} },
      ]},
      { id: 'shown', type: 'article', text: 'KEPT ARTICLE', meta: {}, children: [] },
    ]}],
  };
  const xml = generateSec(tree);
  expect(xml).not.toContain('REMOVED ARTICLE');
  expect(xml).not.toContain('child of removed article');
  expect(xml).toContain('<TTL>KEPT ARTICLE</TTL>');
});
```

- [ ] **Step 2: Run the tests, verify they fail.** `pnpm test -- src/generator/sec/index.test.ts` — expect the two new tests RED (removed text still present).

- [ ] **Step 3: Implement the filter.** In `src/generator/sec/index.ts`:
  - Add `isHidden`:
    ```typescript
    // A non-note node flagged vanish is owner-removed (#251/#278) or hidden (#296):
    // it — and its subtree — are filtered from SEC egress, matching the DOCX and
    // Markdown renderers. A note is never suppressed: SEC notes are vanish by
    // definition and always export as <NTE>.
    function isHidden(node: SpecNode): boolean {
      return node.type !== 'note' && node.meta.vanish === true;
    }
    ```
  - `renderChildren`: after the `note` branch, skip hidden children uniformly, then keep the visible-continuation and structural branches:
    ```typescript
    for (const child of node.children) {
      if (child.type === 'note') out.push(renderNote(child));
      else if (isHidden(child)) continue; // #278/#296: owner-removed or hidden — drop node + subtree
      else if (child.type === 'continuation') out.push(`<TXT>${escape(child.text)}</TXT>`);
      else if (tierOf(child.type) !== null) out.push(renderStructuralChild(child, tier, refs));
    }
    ```
  - `renderPart` body: skip hidden children (articles) after the `note` branch:
    ```typescript
    .map((child) => {
      if (child.type === 'note') return renderNote(child);
      if (isHidden(child)) return ''; // #278: owner-removed article — drop node + subtree
      if (tierOf(child.type) !== null) return renderSpt(child, refs);
      return '';
    })
    ```
  - `renderRoot`: keep behavior, but reuse `isHidden` for the single-source rule (`if (isHidden(node)) return ''` in place of the raw `node.meta.vanish === true` check).
  - Fix the now-false comments in `renderChildren` (lines ~88–91) and the `KNOWN LIMITATION (adjacent to #278)` comment on `renderRoot` so they describe the filter behavior; drop the "still-lossy #278" claim.

- [ ] **Step 4: Run tests, verify GREEN.** `pnpm test -- src/generator/sec/index.test.ts` — all pass, including the existing note/#296/UFGS-fixture round-trip tests (unchanged).

- [ ] **Step 5: Update openapi `/removal` prose.** In `openapi.yaml`, replace the "Known limitation: the canonical `.SEC` serialization is not yet removal-aware…" sentence with prose stating `.SEC` egress now filters owner-removed body paragraphs (consistent with DOCX/Markdown), so removed content does not appear in a `.SEC` export; note this is filter (not lossless encode), and that there is still no `.SEC` export endpoint.

- [ ] **Step 6: Write ADR-060.** `docs/adr/060-sec-egress-filters-owner-removal.md` (Status/Context/Decision/Consequences): decision = filter vanished non-note body nodes from SEC egress; rejected alternative = encode a distinct owner-removal marker (rejected: would collide with the `<NTE>`/`vanish` note mapping, invent a non-standard SEC marker, and no lossless-reversibility requirement exists — SEC is import-only today). Reinforces ADR-048 (model-driven egress: all renderers derive from the canonical AST and honor `vanish`).

- [ ] **Step 7: Full lint + unit suite.** `pnpm lint && pnpm test`. Expected: green.

- [ ] **Step 8: Commit.**
```bash
git add src/generator/sec/index.ts src/generator/sec/index.test.ts openapi.yaml docs/adr/060-sec-egress-filters-owner-removal.md docs/superpowers/plans/2026-07-10-sec-owner-removal-filter.md
git commit -m "feat(generator): filter owner-removed (vanish) body nodes from SEC egress (#278)"
```

## Self-Review

- **Spec coverage:** AC1 (SEC export does not emit owner-removed body paragraphs) → Steps 1–4. AC2 (regression test) → Step 1. AC3 (update `/removal` openapi + docstrings) → Step 5 + comment fixes in Step 3. Filter-vs-encode decision documented → Step 6 (ADR) + PR body.
- **Placeholder scan:** none — all code shown.
- **Type consistency:** `isHidden(node: SpecNode): boolean`; `SpecNode`, `SpecTree` already imported; `parseSec` already imported in the test.
