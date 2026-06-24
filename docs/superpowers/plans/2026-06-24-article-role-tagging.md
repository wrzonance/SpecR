# Semantic Article-Role Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministically classify each PART child `article` node by its CSI role (Related Sections / References / Submittals / Summary / Quality Assurance / …) and surface that role as an optional `meta.articleRole` through the read API and MCP `get_spec`, without mutating any existing field.

**Architecture:** `articleRole` is a **pure derived field**, not stored state — it is a deterministic function of the article's heading text. A single pure deriver lives in `src/ast/` (the foundational layer both `parser/` and `db/` import). It is applied at two chokepoints so every SpecTree carries the role consistently: (1) a post-parse tree transform in `parser/index.ts` so freshly-parsed trees carry it, and (2) `db/queries/specs.ts buildNodeTree` so DB-reconstructed trees (the path `get_spec` and `GET /specs/:id/tree` use) carry it. No migration, no DB column — mirrors how `editability`/`conflicts` are shaped on read. The deriver is tolerant of CSI numbering prefixes, so it works whether or not a given parser already stripped the prefix; because the 5-signal inference engine normalizes the CPI ilvl offset into `node_type='article'` *before* the deriver ever runs, the deriver is inherently ilvl-agnostic.

**Tech Stack:** TypeScript (ESM, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes), Zod v4, vitest. No new dependencies.

## Global Constraints

- ESM (`"type":"module"`): relative imports use `.js` extensions; `verbatimModuleSyntax` → `import type` for type-only imports.
- ESLint ENFORCED: `complexity` ≤10, `sonarjs/cognitive-complexity` ≤10, `max-lines-per-function` ≤50, `max-lines` ≤400 (file cap 400), `no-console`=error, `@typescript-eslint/no-explicit-any`=error. No `any`, no `as unknown as`, no non-null `!` outside tests.
- Module boundaries are HARD: import only from a sibling's `index.ts` barrel. `ast/` is the foundational leaf — `parser/` and `db/` may import from it; it imports from nothing but `lib/` and `zod`.
- Typed errors per module; chain `cause`. Validate external input with Zod.
- No `console.*` in `src/` (outside test/scripts) — use `src/lib/logger.ts`.
- `openapi.yaml` is the CI-ENFORCED API contract (`src/api/contract.integration.test.ts`): the new optional `meta.articleRole` MUST be documented in the `SpecNode` schema in the SAME PR.
- Conventional Commits, scope = module changed. End each commit with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- The new field is OPTIONAL: unknown/non-standard articles carry NO `articleRole` (absent), never a wrong one. Never mutate existing `meta` fields.
- Document genuinely ambiguous headings IN A TEST marked `// KNOWN AMBIGUITY: <desc>` — never silently pick.

---

## File Structure

- **Create** `docs/adr/033-article-role-tagging.md` — the required ADR (keystone modeling decision).
- **Create** `src/ast/article-role.ts` — the pure deriver: `ArticleRole` union, `ARTICLE_ROLE_RULES` data table, `deriveArticleRole(text): ArticleRole | undefined`, and `tagArticleRoles(nodes): SpecNode[]` tree transform. Schema (`ArticleRoleSchema`) added to `src/ast/schemas.ts`; both re-exported from `src/ast/index.ts`.
- **Modify** `src/ast/schemas.ts` — add `ArticleRoleSchema` (closed enum) and add `articleRole` to `SpecNodeMetaSchema` (optional).
- **Modify** `src/ast/types.ts` — add `articleRole?: ArticleRole` to `SpecNodeMeta`; export `ArticleRole`.
- **Modify** `src/ast/index.ts` — export `ArticleRole`, `ArticleRoleSchema`, `deriveArticleRole`, `tagArticleRoles`, `ARTICLE_ROLE_RULES`.
- **Modify** `src/parser/index.ts` — apply `tagArticleRoles` to the tree in `parse()` for all three formats.
- **Modify** `src/db/queries/specs.ts` — in `buildNodeTree`, set `meta.articleRole` on `article` rows via `deriveArticleRole(row.text)`.
- **Modify** `openapi.yaml` — add `articleRole` to the `SpecNode.meta` properties.
- **Create** tests: `src/ast/article-role.test.ts` (deriver unit tests), `src/parser/article-role.test.ts` (parse-path integration over synthetic trees), and a `skipIf`-gated real-fixture assertion appended to the ARCAT/CPI integration tests.

---

## Task 0: ADR-033 — the role-tagging modeling decision

**Files:**
- Create: `docs/adr/033-article-role-tagging.md`

**Interfaces:**
- Produces: the locked decisions every later task implements (where role lives, how derived, how unknowns are represented, interaction with `note`/`continuation`).

- [ ] **Step 1: Write the ADR**

Create `docs/adr/033-article-role-tagging.md`:

```markdown
# ADR-033: Semantic article-role tagging

## Status

Accepted

## Context

The canonical CSI AST (ADR-003) is semantic-light: every PART child is a generic
`article` node (`src/ast/types.ts` — 12 node types, none role-typed). There is no
deterministic way to ask "which article is *Related Sections*? *References*?
*Submittals*?". Wishlist items decomposed from #256 are blocked on this: A2/A3
(Related Sections ↔ body), B2 (References ↔ body), and D (the submittal register).
This is the single most reusable foundation, so it lands first (keystone / Task-0).

CSI article headings are written to a strong convention ("RELATED SECTIONS",
"REFERENCES", "SUBMITTALS", "SUMMARY", "QUALITY ASSURANCE", …), but with three
sources of variance: (1) a leading CSI numbering prefix that may or may not have
been stripped by the parser ("1.1 REFERENCES" vs "REFERENCES"); (2) common title
variants ("Related Requirements" for Related Sections, "Reference Standards" for
References); (3) casing/whitespace noise. A handful of headings are genuinely
ambiguous and must not be force-classified.

## Decision

1. **Role is a pure derived field, not stored state.** `articleRole` is a
   deterministic function of the article's heading text. No DB column, no
   migration — it is shaped on read exactly like `meta.editability` and
   `meta.conflicts` are. The single source of truth is one pure deriver,
   `deriveArticleRole(text)`, in `src/ast/article-role.ts` (the foundational
   layer both `parser/` and `db/` already import from).

2. **Two application chokepoints, one function.** The deriver is applied (a) as a
   post-parse tree transform in `parser/index.ts` so freshly-parsed trees carry
   the role, and (b) in `db/queries/specs.ts buildNodeTree` so DB-reconstructed
   trees — the path `get_spec` and `GET /specs/:id/tree` use — carry it. Same
   pure function, two call sites; no drift possible.

3. **Surfaced as optional `meta.articleRole`.** Added to `SpecNodeMeta` without
   touching any existing field. A closed enum of recognized roles. Surfaces
   automatically through `get_spec` / `GET /specs/:id/tree` because both serialize
   the `SpecTree` directly; the optional field is documented in the `SpecNode`
   schema in `openapi.yaml`.

4. **Unknowns are absent, never wrong.** An article whose heading matches no rule
   carries NO `articleRole` (the key is omitted). We never guess. Genuinely
   ambiguous headings are recorded as `// KNOWN AMBIGUITY:` test cases (per the
   OOXML ambiguity rule) rather than silently resolved.

5. **Tolerant matching.** The deriver strips an optional leading CSI numbering
   prefix, uppercases, and collapses whitespace before matching a data table of
   role rules (canonical title + variants). This makes it robust whether or not a
   given parser stripped the prefix, and ilvl-agnostic — the 5-signal engine
   already normalizes the CPI ilvl offset into `node_type='article'` before the
   deriver runs, so CPI and ARCAT articles classify identically.

6. **Only `article` nodes are classified.** `note` and `continuation` nodes are
   never assigned a role: `tagArticleRoles` matches strictly on
   `node.type === 'article'`. A `note` whose text happens to read "REFERENCES"
   stays a `note` with no role. Role is orthogonal to the editorial-visibility
   axis (`vanish`/`note`).

## Consequences

- Downstream coordination checks (#256 A2/A3/B2) and the submittal register (D)
  can locate the Related Sections / References / Submittals article
  deterministically, with no heuristics of their own.
- Zero migration and zero new persisted state: re-deriving on every read is
  negligible (a few regex tests per article) and guarantees the role always
  reflects the current heading text — editing a heading re-classifies for free.
- The role vocabulary is a closed enum; adding a role is a one-line table + enum
  change plus a test, never a schema migration.
- Rejected alternative — a persisted `paragraphs.article_role` column: it would
  add a migration, a write path, and a staleness risk (a heading edit would leave
  the column wrong until re-written) for no benefit, since derivation is cheap and
  deterministic.
- Rejected alternative — a dedicated `role` node-type sibling to `article`: it
  would fork every existing `article` consumer (generator, markdown, merge) and
  conflate structure with semantics. `meta.articleRole` is additive and ignorable.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/033-article-role-tagging.md
git commit -m "docs(adr): ADR-033 — semantic article-role tagging (derived, not stored)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: The pure role deriver (`src/ast/article-role.ts`)

**Files:**
- Create: `src/ast/article-role.ts`
- Test: `src/ast/article-role.test.ts`

**Interfaces:**
- Produces:
  - `type ArticleRole = 'summary' | 'references' | 'definitions' | 'related-sections' | 'submittals' | 'quality-assurance' | 'delivery-storage-handling' | 'warranty'`
  - `const ARTICLE_ROLE_RULES: readonly ArticleRoleRule[]` (data table)
  - `function deriveArticleRole(text: string): ArticleRole | undefined`
  - `function tagArticleRoles(nodes: readonly SpecNode[]): readonly SpecNode[]` (deep, immutable; only touches `type === 'article'`)
- Consumes: `SpecNode` from `./types.js`.

- [ ] **Step 1: Write the failing test**

Create `src/ast/article-role.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveArticleRole, tagArticleRoles } from './article-role.js';
import type { SpecNode } from './types.js';

function article(text: string, children: readonly SpecNode[] = []): SpecNode {
  return { id: 'a', type: 'article', text, children, meta: {} };
}

describe('deriveArticleRole — canonical CSI headings', () => {
  it('classifies bare canonical headings', () => {
    expect(deriveArticleRole('RELATED SECTIONS')).toBe('related-sections');
    expect(deriveArticleRole('REFERENCES')).toBe('references');
    expect(deriveArticleRole('SUBMITTALS')).toBe('submittals');
    expect(deriveArticleRole('SUMMARY')).toBe('summary');
    expect(deriveArticleRole('QUALITY ASSURANCE')).toBe('quality-assurance');
    expect(deriveArticleRole('DEFINITIONS')).toBe('definitions');
    expect(deriveArticleRole('WARRANTY')).toBe('warranty');
    expect(deriveArticleRole('DELIVERY, STORAGE AND HANDLING')).toBe(
      'delivery-storage-handling'
    );
  });

  it('tolerates a leading CSI numbering prefix (ARCAT "1.1 X" form)', () => {
    expect(deriveArticleRole('1.1 RELATED SECTIONS')).toBe('related-sections');
    expect(deriveArticleRole('1.3 SUBMITTALS')).toBe('submittals');
  });

  it('tolerates a CPI-style numbering prefix and offset (same logical article)', () => {
    // CPI reserves low ilvls for Schedule/PDS; the inference engine normalizes
    // the offset into node_type='article' before the deriver runs, so the only
    // thing the deriver sees is the heading text — prefix or not, it classifies.
    expect(deriveArticleRole('1.02 REFERENCES')).toBe('references');
    expect(deriveArticleRole('REFERENCES')).toBe('references');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(deriveArticleRole('  related   sections ')).toBe('related-sections');
    expect(deriveArticleRole('References')).toBe('references');
  });

  it('accepts documented variants', () => {
    expect(deriveArticleRole('RELATED REQUIREMENTS')).toBe('related-sections');
    expect(deriveArticleRole('REFERENCE STANDARDS')).toBe('references');
    expect(deriveArticleRole('1.4 RELATED WORK')).toBe('related-sections');
  });

  it('returns undefined for unknown/non-standard headings (never a wrong role)', () => {
    expect(deriveArticleRole('SYSTEM DESCRIPTION')).toBeUndefined();
    expect(deriveArticleRole('PERFORMANCE REQUIREMENTS')).toBeUndefined();
    expect(deriveArticleRole('')).toBeUndefined();
    expect(deriveArticleRole('1.7 MAINTENANCE')).toBeUndefined();
  });

  // KNOWN AMBIGUITY: "REFERENCES" as a sub-list heading inside another article
  // (e.g. a manufacturer's reference drawings) reads identically to the PART-1
  // References article. The deriver classifies on heading text alone and cannot
  // see nesting depth, so it WILL tag such a heading 'references'. Callers that
  // need PART-1-only roles must filter by tree position; the deriver does not
  // guess position. Asserted here so the behavior is explicit, not silent.
  it('KNOWN AMBIGUITY: a nested "REFERENCES" heading also classifies as references', () => {
    expect(deriveArticleRole('REFERENCES')).toBe('references');
  });
});

describe('tagArticleRoles — immutable tree transform', () => {
  it('sets meta.articleRole on matching article nodes only', () => {
    const input: readonly SpecNode[] = [
      {
        id: 'p1',
        type: 'part',
        text: 'GENERAL',
        meta: {},
        children: [
          article('REFERENCES'),
          article('SYSTEM DESCRIPTION'),
          { id: 'n', type: 'note', text: 'REFERENCES', children: [], meta: {} },
        ],
      },
    ];
    const out = tagArticleRoles(input);
    const part = out[0];
    expect(part?.children[0]?.meta.articleRole).toBe('references');
    expect(part?.children[1]?.meta.articleRole).toBeUndefined();
    // note node with "REFERENCES" text is NOT a role-bearing article
    expect(part?.children[2]?.meta.articleRole).toBeUndefined();
  });

  it('does not mutate the input (immutability)', () => {
    const input: readonly SpecNode[] = [article('REFERENCES')];
    const out = tagArticleRoles(input);
    expect(input[0]?.meta.articleRole).toBeUndefined();
    expect(out[0]?.meta.articleRole).toBe('references');
    expect(out).not.toBe(input);
  });

  it('preserves existing meta fields when adding the role', () => {
    const input: readonly SpecNode[] = [
      { id: 'a', type: 'article', text: 'REFERENCES', children: [], meta: { vanish: true } },
    ];
    const out = tagArticleRoles(input);
    expect(out[0]?.meta.vanish).toBe(true);
    expect(out[0]?.meta.articleRole).toBe('references');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ast/article-role.test.ts`
Expected: FAIL — cannot resolve `./article-role.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/ast/article-role.ts`:

```typescript
// Pure, deterministic CSI article-role classifier (ADR-033). Role is DERIVED
// from the article heading, never stored. One source of truth, applied at parse
// (parser/index.ts) and on read (db buildNodeTree). Tolerant of a leading CSI
// numbering prefix so it works whether or not a parser already stripped it, and
// ilvl-agnostic (the inference engine normalizes the CPI offset into
// node_type='article' before this runs).

import type { ArticleRole } from './types.js';
import type { SpecNode } from './types.js';

export type { ArticleRole } from './types.js';

interface ArticleRoleRule {
  readonly role: ArticleRole;
  /** Exact normalized-heading strings (uppercased, prefix-stripped) that map here. */
  readonly titles: readonly string[];
}

// Data table: canonical CSI title + documented variants. Order does not matter —
// titles are matched exactly against the normalized heading, so no rule shadows
// another. Add a role by adding one row here and one enum member in types.ts.
export const ARTICLE_ROLE_RULES: readonly ArticleRoleRule[] = [
  { role: 'summary', titles: ['SUMMARY', 'SECTION INCLUDES'] },
  {
    role: 'related-sections',
    titles: ['RELATED SECTIONS', 'RELATED REQUIREMENTS', 'RELATED WORK', 'RELATED DOCUMENTS'],
  },
  { role: 'references', titles: ['REFERENCES', 'REFERENCE STANDARDS', 'REFERENCED STANDARDS'] },
  { role: 'definitions', titles: ['DEFINITIONS'] },
  { role: 'submittals', titles: ['SUBMITTALS', 'ACTION SUBMITTALS', 'INFORMATIONAL SUBMITTALS'] },
  { role: 'quality-assurance', titles: ['QUALITY ASSURANCE'] },
  {
    role: 'delivery-storage-handling',
    titles: [
      'DELIVERY, STORAGE AND HANDLING',
      'DELIVERY, STORAGE, AND HANDLING',
      'DELIVERY STORAGE AND HANDLING',
    ],
  },
  { role: 'warranty', titles: ['WARRANTY'] },
];

const LOOKUP: ReadonlyMap<string, ArticleRole> = new Map(
  ARTICLE_ROLE_RULES.flatMap((rule) => rule.titles.map((t) => [t, rule.role] as const))
);

// Leading CSI numbering prefix: "1.1", "1.02", "1.1.1", optionally trailed by a
// separator. Stripped before lookup so "1.1 REFERENCES" === "REFERENCES".
const NUMBER_PREFIX_RE = /^\d+(?:\.\d+)*\s*[-–—.)]?\s*/;

function normalizeHeading(text: string): string {
  return text.replace(NUMBER_PREFIX_RE, '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Resolve a CSI article role from its heading text, or undefined if unknown. */
export function deriveArticleRole(text: string): ArticleRole | undefined {
  return LOOKUP.get(normalizeHeading(text));
}

/** Deep, immutable: set meta.articleRole on every `article` node whose heading
 *  resolves to a role. Non-article nodes (note/continuation/part/pr*) untouched. */
export function tagArticleRoles(nodes: readonly SpecNode[]): readonly SpecNode[] {
  return nodes.map((node) => {
    const children = tagArticleRoles(node.children);
    if (node.type !== 'article') {
      return children === node.children ? node : { ...node, children };
    }
    const role = deriveArticleRole(node.text);
    if (role === undefined) {
      return children === node.children ? node : { ...node, children };
    }
    return { ...node, children, meta: { ...node.meta, articleRole: role } };
  });
}
```

- [ ] **Step 4: Add `ArticleRole` to `src/ast/types.ts`**

In `src/ast/types.ts`, after the `NodeType` export (line ~10), add:

```typescript
export type ArticleRole = z.infer<typeof ArticleRoleSchema>;
```

and add `ArticleRoleSchema` to the import block from `./schemas.js` (lines 2-8):

```typescript
import {
  NodeTypeSchema,
  ArticleRoleSchema,
  SecRefSchema,
  StyleNodeTypeSchema,
  StylePropertiesSchema,
  SpecNodeEditabilitySchema,
} from './schemas.js';
```

Then add the optional field to `SpecNodeMeta` (after `associations`, line ~86):

```typescript
  /** Semantic CSI role of this article (ADR-033). Absent === unknown/non-article. */
  readonly articleRole?: ArticleRole;
```

- [ ] **Step 5: Add `ArticleRoleSchema` to `src/ast/schemas.ts`**

In `src/ast/schemas.ts`, after `NodeTypeSchema` (line ~18), add:

```typescript
// Closed enum of recognized CSI article roles (ADR-033). Kebab-case values are
// stable identifiers consumed by coordination checks — not display labels.
export const ArticleRoleSchema = z.enum([
  'summary',
  'references',
  'definitions',
  'related-sections',
  'submittals',
  'quality-assurance',
  'delivery-storage-handling',
  'warranty',
]);
```

Then add to `SpecNodeMetaSchema` (after `editability`, line ~163):

```typescript
  articleRole: ArticleRoleSchema.exactOptional(),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run src/ast/article-role.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Run lint to verify the schema/types compile clean**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/ast/article-role.ts src/ast/article-role.test.ts src/ast/types.ts src/ast/schemas.ts
git commit -m "feat(ast): pure CSI article-role deriver + optional meta.articleRole

Deterministic role classification from the article heading (ADR-033). No DB
column — derived, like editability/conflicts. Tolerant of CSI numbering
prefixes; only 'article' nodes are tagged. Unknown headings carry no role.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Export the deriver from the `ast/` barrel

**Files:**
- Modify: `src/ast/index.ts`

**Interfaces:**
- Consumes: `deriveArticleRole`, `tagArticleRoles`, `ARTICLE_ROLE_RULES`, `ArticleRole`, `ArticleRoleSchema`.
- Produces: those names on the `src/ast/index.js` barrel for `parser/` and `db/` to import.

- [ ] **Step 1: Write the failing test**

Append to `src/ast/article-role.test.ts`:

```typescript
import * as astBarrel from './index.js';

describe('ast barrel re-exports', () => {
  it('exposes the deriver and tree transform', () => {
    expect(typeof astBarrel.deriveArticleRole).toBe('function');
    expect(typeof astBarrel.tagArticleRoles).toBe('function');
    expect(Array.isArray(astBarrel.ARTICLE_ROLE_RULES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/ast/article-role.test.ts`
Expected: FAIL — `astBarrel.deriveArticleRole` is undefined.

- [ ] **Step 3: Add the exports**

In `src/ast/index.ts`, in the type-export block from `./types.js`, add `ArticleRole`. Then add a new export pair:

```typescript
export { deriveArticleRole, tagArticleRoles, ARTICLE_ROLE_RULES } from './article-role.js';
```

and add `ArticleRoleSchema` to the value-export block from `./schemas.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/ast/article-role.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ast/index.ts src/ast/article-role.test.ts
git commit -m "feat(ast): export article-role deriver from the ast barrel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Tag roles at parse time (`parser/index.ts`)

**Files:**
- Modify: `src/parser/index.ts`
- Test: `src/parser/article-role.test.ts`

**Interfaces:**
- Consumes: `tagArticleRoles` from `../ast/index.js`.
- Produces: every `ParseResult.tree` (sec/docx/txt) carries `meta.articleRole` on its standard articles.

- [ ] **Step 1: Write the failing test**

Create `src/parser/article-role.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from './index.js';

// A minimal SpecsIntact .SEC document with two PART-1 articles: one standard
// (REFERENCES → references) and one non-standard (no role). The real .SEC
// grammar nests articles as <SPT><TTL>…</TTL></SPT> inside <PRT> (see
// src/parser/sec/index.test.ts WITH_PARTS). Exercises the parse chokepoint
// end-to-end without binary fixtures.
const SEC = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 09 91 26</SCN>
  <STL>INTERIOR PAINTING</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
    <SPT>
      <TTL>SYSTEM DESCRIPTION</TTL>
      <TXT>Describes the painting system.</TXT>
    </SPT>
  </PRT>
</SEC>`;

describe('parse() tags article roles on the .SEC path', () => {
  it('sets meta.articleRole on the REFERENCES article, none on the unknown one', async () => {
    const { tree } = await parse(Buffer.from(SEC), 'test.sec');
    const articles = tree.parts.flatMap((p) => p.children).filter((n) => n.type === 'article');
    const refs = articles.find((a) => /REFERENCES/i.test(a.text));
    const other = articles.find((a) => /SYSTEM/i.test(a.text));
    expect(refs?.meta.articleRole).toBe('references');
    expect(other?.meta.articleRole).toBeUndefined();
  });
});
```

> Grammar confirmed against `src/parser/sec/index.test.ts` (WITH_PARTS): `<SPT>`
> at PART depth 0 → `type:'article'`, titled by its `<TTL>` (prefix already
> bare). The `parse()` dispatcher runs `assertSecSafe` then `parseSec`; this
> fixture passes the safety gate (small, well-formed). If the real article text
> retains casing/whitespace, the deriver normalizes it.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/parser/article-role.test.ts`
Expected: FAIL — `refs.meta.articleRole` is undefined (parser does not tag yet).

- [ ] **Step 3: Apply `tagArticleRoles` in `parse()`**

In `src/parser/index.ts`, import the transform:

```typescript
import { tagArticleRoles } from '../ast/index.js';
```

Add a helper near `applyInference` (keeps each branch ≤ a line):

```typescript
function withArticleRoles(tree: SpecTree): SpecTree {
  return { ...tree, parts: tagArticleRoles(tree.parts) };
}
```

Then wrap the returned tree in each branch. `.sec`:

```typescript
    return { tree: withArticleRoles(applyInference(tree, sectionInference)), refs, sectionInference };
```

`.docx` — apply to `finalTree` before refs extraction so refs still see the same text:

```typescript
    const finalTree = withArticleRoles(applyInference(tree, sectionInference));
    const refs = extractRefsFromTree(finalTree);
    return { tree: finalTree, refs, sectionInference };
```

`.txt`:

```typescript
    return { tree: withArticleRoles(tree), refs, sectionInference, capabilities };
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/parser/article-role.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full parser suite (no regressions)**

Run: `pnpm vitest run src/parser`
Expected: PASS (integration tests `skipIf`-skip when binary fixtures absent).

- [ ] **Step 6: Commit**

```bash
git add src/parser/index.ts src/parser/article-role.test.ts
git commit -m "feat(parser): tag article roles at parse time (all formats)

Apply the ast tagArticleRoles transform once in parse() so every freshly-parsed
SpecTree (.sec/.docx/.txt) carries meta.articleRole. DOCX applies before ref
extraction so refs see unchanged text.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Tag roles on the DB read path (`buildNodeTree`)

**Files:**
- Modify: `src/db/queries/specs.ts`
- Test: `src/db/queries/specs.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: `deriveArticleRole` from `../../ast/index.js`.
- Produces: `buildNodeTree` output `article` nodes carry `meta.articleRole`; surfaces through `getSpecTree` → `get_spec` and `GET /specs/:id/tree`.

- [ ] **Step 1: Write the failing test**

`buildNodeTree` is exported from `specs.ts` and is a pure function over rows (no DB) — testable as a unit. Create/append `src/db/queries/specs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildNodeTree, type ParagraphTreeRow } from './specs.js';

function row(p: Partial<ParagraphTreeRow> & Pick<ParagraphTreeRow, 'id' | 'node_type' | 'text'>): ParagraphTreeRow {
  return {
    parent_id: null,
    position: 0,
    vanish: false,
    conflicts: [],
    source_facts: {},
    classification: null,
    editability_override: null,
    ...p,
  };
}

describe('buildNodeTree derives meta.articleRole', () => {
  it('tags an article row whose text is a known CSI heading', () => {
    const nodes = buildNodeTree([row({ id: 'a', node_type: 'article', text: 'REFERENCES' })]);
    expect(nodes[0]?.meta.articleRole).toBe('references');
  });

  it('tolerates a retained numbering prefix on the stored text', () => {
    const nodes = buildNodeTree([row({ id: 'a', node_type: 'article', text: '1.1 SUBMITTALS' })]);
    expect(nodes[0]?.meta.articleRole).toBe('submittals');
  });

  it('omits the role on unknown headings and on non-article rows', () => {
    const nodes = buildNodeTree([
      row({ id: 'a', node_type: 'article', text: 'SYSTEM DESCRIPTION' }),
      row({ id: 'n', node_type: 'note', text: 'REFERENCES' }),
    ]);
    expect(nodes[0]?.meta.articleRole).toBeUndefined();
    expect(nodes[1]?.meta.articleRole).toBeUndefined();
  });
});
```

> Verify during implementation that `ParagraphTreeRow` is exported from
> `specs.ts` (it is — line ~107). If `buildNodeTree`/`ParagraphTreeRow` are not
> on the export surface this test imports, they are already module-internal
> exports (`export function buildNodeTree` line ~155); import them directly from
> `./specs.js` as shown — this is an in-module test, not a barrel consumer.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/db/queries/specs.test.ts`
Expected: FAIL — `articleRole` undefined for the REFERENCES article.

- [ ] **Step 3: Derive the role in `buildNode`**

In `src/db/queries/specs.ts`, add to the imports from `../../ast/index.js` (or wherever ast types are imported — confirm the existing import line): `deriveArticleRole`.

In `buildNode` (inside `buildNodeTree`), compute the role only for article rows and spread it into `meta`:

```typescript
    const editability = deriveEditability(row.classification, row.editability_override);
    const articleRole = row.node_type === 'article' ? deriveArticleRole(row.text) : undefined;
    return {
      id: row.id,
      type: row.node_type as NodeType,
      text: row.text,
      children,
      meta: {
        ...(row.vanish ? { vanish: true } : {}),
        ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
        ...(hasSourceFacts(row.source_facts) ? { sourceFacts: row.source_facts } : {}),
        ...(editability ? { editability } : {}),
        ...(articleRole !== undefined ? { articleRole } : {}),
      },
    };
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/db/queries/specs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/specs.ts src/db/queries/specs.test.ts
git commit -m "feat(db): derive meta.articleRole in buildNodeTree (read path)

So DB-reconstructed trees — the path get_spec and GET /specs/:id/tree use —
carry the role, using the same pure deriver as the parser. Article rows only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Document `articleRole` in the OpenAPI contract

**Files:**
- Modify: `openapi.yaml` (the `SpecNode.meta` properties, line ~3675)

**Interfaces:**
- Produces: contract-test green — the new optional response field is documented.

- [ ] **Step 1: Add the property**

In `openapi.yaml`, under `SpecNode` → `properties` → `meta` → `properties`, after the `associations` block (line ~3707), add:

```yaml
            articleRole:
              type: string
              description: >-
                Semantic CSI role of this article, derived from its heading
                (ADR-033). Present only on `article` nodes whose heading matches
                a recognized CSI role; absent for unknown/non-standard articles
                and all non-article nodes.
              enum:
                - summary
                - references
                - definitions
                - related-sections
                - submittals
                - quality-assurance
                - delivery-storage-handling
                - warranty
```

- [ ] **Step 2: Lint the spec**

Run: `pnpm exec redocly lint openapi.yaml`
Expected: no errors (warnings pre-existing in the repo are acceptable — compare against `git stash` baseline if unsure).

- [ ] **Step 3: Commit**

```bash
git add openapi.yaml
git commit -m "docs(api): document optional meta.articleRole in SpecNode schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Real-fixture verification (ARCAT + CPI), gated

**Files:**
- Modify: `src/parser/docx/arcat.integration.test.ts`
- Modify: `src/parser/docx/cpi.integration.test.ts`

**Interfaces:**
- Consumes: `parse` (already imported in these files) + `deriveArticleRole` / inspection of `meta.articleRole`.
- Produces: an end-to-end assertion that real ARCAT and CPI documents classify their References/Related/Submittals articles — `skipIf`-skipped when the copyrighted fixtures are absent (CI provides them).

- [ ] **Step 1: Add the ARCAT assertion**

In `src/parser/docx/arcat.integration.test.ts`, inside the existing `describe.skipIf(!FIXTURES_AVAILABLE)` block, add a test that parses one known fixture and asserts at least one standard role is present. Use the existing `allNodes` helper:

```typescript
  it('classifies standard article roles (REFERENCES at minimum)', async () => {
    const buffer = readFileSync(resolve(ARCAT_DIR, '07_21_00ksp.docx'));
    const { tree } = await parse(buffer, '07_21_00ksp.docx');
    const roles = allNodes(tree.parts)
      .filter((n) => n.type === 'article')
      .map((n) => n.meta.articleRole)
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    // ARCAT sections reliably carry a References article; assert role tagging fired.
    expect(roles).toContain('references');
    // No non-article node should ever carry a role.
    const badlyTagged = allNodes(tree.parts).filter(
      (n) => n.type !== 'article' && n.meta.articleRole !== undefined
    );
    expect(badlyTagged).toEqual([]);
  });
```

> If `07_21_00ksp.docx` happens not to contain a References article, swap to a
> fixture from `ARCAT_FIXTURES` that does (inspect with a quick local
> `parse → log article texts` during implementation). The assertion's intent —
> "a real ARCAT doc classifies at least its References article, and nothing
> non-article is tagged" — is what must hold.

- [ ] **Step 2: Add the CPI assertion (ilvl offset must not break it)**

In `src/parser/docx/cpi.integration.test.ts`, inside its `describe.skipIf` block, add a parallel test against `CPI_BUSBAR_CSIMFS.docx`:

```typescript
  it('classifies roles despite the CPI ilvl offset', async () => {
    const buffer = readFileSync(resolve(CPI_DIR, 'CPI_BUSBAR_CSIMFS.docx'));
    const { tree } = await parse(buffer, 'CPI_BUSBAR_CSIMFS.docx');
    const articleRoles = tree.parts
      .flatMap((p) => p.children)
      .filter((n) => n.type === 'article')
      .map((n) => n.meta.articleRole);
    // The CPI offset is normalized into node_type='article' before role
    // derivation, so a known CPI heading still classifies. At least one
    // recognized role must be present (regression guard for the offset path).
    expect(articleRoles.some((r) => r !== undefined)).toBe(true);
  });
```

> Confirm the helper to flatten CPI nodes during implementation; the existing
> CPI test imports `SpecNode` and walks the tree — reuse its pattern. If
> `tree.parts[].children` is not where CPI articles land (offset nesting), use a
> recursive `allNodes`-style walk as in the ARCAT test.

- [ ] **Step 3: Run the integration tests locally if fixtures present, else confirm skip**

Run: `pnpm vitest run src/parser/docx/arcat.integration.test.ts src/parser/docx/cpi.integration.test.ts`
Expected: PASS, or `skipped` (fixtures gitignored locally — CI runs them).

- [ ] **Step 4: Commit**

```bash
git add src/parser/docx/arcat.integration.test.ts src/parser/docx/cpi.integration.test.ts
git commit -m "test(parser): verify article-role tagging on real ARCAT + CPI fixtures

Gated by skipIf (copyrighted fixtures); CI exercises them. Asserts CPI ilvl
offset does not break classification and no non-article node is tagged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full build-green gate

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS (eslint + tsc --noEmit + prettier --check all clean).

- [ ] **Step 2: Unit tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Integration tests (worktree-unique DB to avoid contention)**

Run:
```bash
DATABASE_URL=postgres://specr:specr@localhost:5432/specr_258 pnpm migrate \
  && DATABASE_URL=postgres://specr:specr@localhost:5432/specr_258 pnpm seed \
  && DATABASE_URL=postgres://specr:specr@localhost:5432/specr_258 pnpm test:integration
```
Expected: PASS (the contract test confirms `articleRole` is a valid documented response field; `get_spec` integration still green).

- [ ] **Step 4: Format check**

Run: `pnpm format` then `git diff --exit-code` (no formatting drift to commit).

---

## Self-Review

**Spec coverage:**
- "Classify PART-1 articles by role, deterministically, title heuristic" → Task 1 (`deriveArticleRole` data table).
- "Tolerant of CSI numbering prefixes + variants" → Task 1 (`NUMBER_PREFIX_RE`, variant titles) + tests.
- "Expose on the node as `meta.articleRole`, optional, without mutating existing fields" → Task 1 (types/schemas, immutable transform; existing-meta-preservation test).
- "Untagged/unknown articles simply absent" → Task 1 (`deriveArticleRole` returns undefined; omit-when-undefined spread).
- "Surface through read API / MCP `get_spec`" → Task 4 (`buildNodeTree`) + Task 5 (openapi); `get_spec` and `GET /specs/:id/tree` serialize `getSpecTree` directly, so no handler change needed.
- "ARCAT + CPI both classify; CPI offset must not break" → Task 6 (gated integration) + Task 1 unit tests covering CPI-style prefixes.
- "Unknown carries no role rather than a wrong one" → Task 1 unit tests.
- "Genuine ambiguity documented in a test (`// KNOWN AMBIGUITY:`)" → Task 1 (nested-REFERENCES case).
- "ADR required" → Task 0 (ADR-033).
- "Interaction with note/continuation" → ADR-033 §6 + Task 1 transform (`type !== 'article'` skip) + test.

**Placeholder scan:** No TBD/TODO; every code step shows full code. The three `> Note:` callouts are *verification instructions* (confirm an element name / pick a fixture that contains the article), not deferred work — the assertions and implementation are fully specified.

**Type consistency:** `ArticleRole` union (Task 1) === `ArticleRoleSchema` enum (Task 1 schemas) === openapi enum (Task 5) — all eight values identical and in the same kebab-case. `deriveArticleRole(text: string): ArticleRole | undefined` and `tagArticleRoles(nodes): readonly SpecNode[]` referenced identically in Tasks 1–4. `ParagraphTreeRow` shape in Task 4's test matches the real interface (specs.ts:107).
