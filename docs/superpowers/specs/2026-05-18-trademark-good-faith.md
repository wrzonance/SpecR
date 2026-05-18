# Trademark Good-Faith Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add defensive trademark/copyright notices, document the public-domain provenance of seed data, and (optionally) rename internal `Csi*` identifiers to `Spec*` so the codebase has minimal trademark surface area.

**Architecture:** Three independent phases, each shippable as its own commit. Phase A adds a TRADEMARKS.md notice and ® symbols on first use in user-facing prose. Phase B adds an ADR proving the `csi_sections` seed derives exclusively from public-domain UFGS data. Phase C (optional, larger) renames `CsiNode` / `CsiTree` / `CsiSectionResult` types and the `csi_sections` table to `Spec*` equivalents so internal identifiers carry no third-party mark. Nominative descriptive references to "CSI MasterFormat" in MCP tool descriptions and README prose are RETAINED — those are protected fair use and identify what the product processes.

**Tech Stack:** Markdown, TypeScript, PostgreSQL migrations (node-pg-migrate), Zod, vitest.

**Out of scope:**
- Removing the term "CSI MasterFormat" from README/docs — those are nominative fair use and required to describe the product accurately.
- Renaming the project "SpecR" — no trademark conflict exists.
- Renaming the database column `division` or the value space of `section_number` — those store data, not marks.
- Licensing MasterFormat content from CSI — current data is UFGS-derived; the question only arises if SpecR later ingests CSI publications directly.
- Removing UFGS references — public domain, attribution suffices.

---

## File Structure

**Phase A — Notices and Disclaimers**

- Create: `TRADEMARKS.md` — Trademark + copyright attribution notice
- Modify: `README.md:3` — Add ® on first mention of CSI/MasterFormat + link to TRADEMARKS.md
- Modify: `package.json:4` — Refine description to use compatibility framing
- Modify: `LICENSE` if present (verify) — append pointer to TRADEMARKS.md, else skip

**Phase B — Seed Provenance ADR**

- Create: `docs/adr/013-csi-sections-seed-public-domain-derivation.md`
- Modify: `src/db/seed.ts:6` — Add short comment pointing to ADR-013
- Modify: `docs/references/UFGS/README.md` — Cross-link ADR-013

**Phase C — Optional Identifier Rename** (defer if scope feels heavy)

- Modify: `src/ast/types.ts` — Add `SpecNode` / `SpecTree` aliases; deprecate `CsiNode` / `CsiTree`
- Migration: `src/db/migrations/00X_rename_csi_sections.ts` — Rename table to `spec_sections`
- Modify: `src/db/queries/search.ts` — Update column/type refs
- Modify: ~30 src/ and test files via regex sweep (full list in Task C1)
- Update: README + ADRs to reflect new identifier names

---

## Phase A: Notices and Disclaimers

### Task A1: Create TRADEMARKS.md

**Files:**
- Create: `/home/adam/github/SpecR/TRADEMARKS.md`

- [ ] **Step 1: Write the file**

```markdown
# Trademark and Copyright Notices

SpecR is an independent open-source project distributed under the MIT License.
It is not affiliated with, endorsed by, or sponsored by any of the entities
named below.

## Third-Party Trademarks

The following are registered trademarks of their respective owners. Any
reference to these marks in SpecR's source code, documentation, MCP tool
descriptions, or output is **nominative fair use** — used solely to identify
the document formats and classification systems SpecR processes.

| Mark | Owner |
|---|---|
| CSI® | The Construction Specifications Institute, Inc. |
| MasterFormat® | The Construction Specifications Institute, Inc. |
| UniFormat® | The Construction Specifications Institute, Inc. |
| OmniClass® | The Construction Specifications Institute, Inc. |
| SectionFormat/PageFormat® | The Construction Specifications Institute, Inc. |
| MasterSpec® | The American Institute of Architects (published by Deltek) |
| Autodesk® and Revit® | Autodesk, Inc. |

## Copyrighted Works

CSI asserts copyright over the MasterFormat numbering scheme and section
titles. SpecR does **not** redistribute or embed CSI publications. The
`csi_sections` seed data is derived exclusively from the public-domain
Unified Facilities Guide Specifications (UFGS) corpus — see
[ADR-013](docs/adr/013-csi-sections-seed-public-domain-derivation.md).

The American Institute of Architects holds copyright on MasterSpec content.
SpecR does **not** ingest, redistribute, or embed MasterSpec source text.

## Public-Domain Works

- **UFGS specifications** (Unified Facilities Guide Specifications) are works
  of the United States Government — USACE / NAVFAC / AFCEC — and are in the
  public domain under [17 USC § 105](https://www.law.cornell.edu/uscode/text/17/105).
- **SpecsIntact** is software copyrighted by NASA. SpecR parses the
  SpecsIntact XML format (.SEC) but does not bundle, redistribute, or wrap
  the SpecsIntact application.

## Questions

If you believe SpecR's use of a mark or copyrighted work exceeds nominative
fair use, please open a GitHub issue or contact the maintainers.
```

- [ ] **Step 2: Verify file written**

Run: `test -f TRADEMARKS.md && wc -l TRADEMARKS.md`
Expected: `≥ 40 TRADEMARKS.md`

- [ ] **Step 3: Commit**

```bash
git add TRADEMARKS.md
git commit -m "docs: add TRADEMARKS.md nominative-use notice"
```

---

### Task A2: Refine package.json description + add ® on first use

**Files:**
- Modify: `package.json:4`

- [ ] **Step 1: Inspect current description**

Run: `grep '"description"' package.json`
Expected output: `"description": "Headless REST API for CSI MasterFormat specification document automation",`

- [ ] **Step 2: Replace with compatibility-framed description**

Edit `package.json` line 4 to:

```json
"description": "Headless REST API for round-trip automation of CSI MasterFormat®-compatible specification documents (UFGS, generic DOCX). Independent project; not affiliated with CSI.",
```

Note: `®` renders as ® in JSON.

- [ ] **Step 3: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json'))"`
Expected: no output (success)

- [ ] **Step 4: Verify lint still passes**

Run: `pnpm lint`
Expected: zero errors

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: reframe package.json description as nominative use"
```

---

### Task A3: Add ® on first mention in README and link TRADEMARKS.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README header**

Run: `head -10 README.md`

- [ ] **Step 2: Edit README**

Replace the first occurrence of "CSI MasterFormat" with "CSI® MasterFormat®". Replace subsequent occurrences with plain "CSI MasterFormat" or "MasterFormat" (one ® per mark per document is sufficient).

Append a Trademarks section at the end of README.md:

```markdown
## Trademarks

CSI® and MasterFormat® are registered trademarks of The Construction
Specifications Institute, Inc. SpecR is an independent project, not affiliated
with or endorsed by CSI. See [TRADEMARKS.md](TRADEMARKS.md) for full
attribution.
```

- [ ] **Step 3: Verify links resolve**

Run: `grep -c 'TRADEMARKS.md' README.md`
Expected: `≥ 1`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): add registered marks on first use + link TRADEMARKS"
```

---

## Phase B: Seed Provenance ADR

### Task B1: Write ADR-013 documenting UFGS-only seed derivation

**Files:**
- Create: `/home/adam/github/SpecR/docs/adr/013-csi-sections-seed-public-domain-derivation.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-013: csi_sections seed data derives exclusively from public-domain UFGS

## Status: Accepted

## Context

The `csi_sections` PostgreSQL table (created in `src/db/migrations/001_create_csi_sections.ts`) stores section numbers, titles, and division IDs that follow the CSI MasterFormat® classification scheme. CSI, Inc. asserts copyright on MasterFormat numbers + titles + classifications, and its EULA forbids embedding "any portion of the CSI Product into commercial construction software" without written permission.

SpecR ships open-source under MIT. If the seed contained content lifted from CSI publications, redistribution would violate the EULA regardless of license.

## Decision

The `csi_sections` seed is derived **exclusively** from the public-domain Unified Facilities Guide Specifications (UFGS) corpus under `docs/references/UFGS/`. Specifically:

1. `src/db/seed.ts` reads `.SEC` files from `docs/references/UFGS/DIVISION_*/`.
2. It extracts `<SCN>SECTION NN NN NN</SCN>` and `<STL>Title</STL>` tags via regex.
3. It upserts `(section_number, title, division)` triples into `csi_sections`.

No other data source feeds this table. ARCAT (`docs/references/ARCAT/`) and CPI (`docs/references/MANUFACTURER_CPI/`) reference dirs contain README-only stubs documenting how to obtain those third-party copyrighted specs for local testing; their content is **never committed** and **never feeds the seed**.

UFGS is a work of the U.S. Government (USACE / NAVFAC / AFCEC) and is in the public domain under 17 USC § 105. The numbering scheme used by UFGS follows CSI MasterFormat conventions under a separate arrangement between the federal government and CSI; SpecR inherits the public-domain status by parsing UFGS rather than CSI's own publications.

## Consequences

- SpecR can redistribute the seeded table data without a CSI license, because every row originated in a public-domain UFGS document.
- The coverage of `csi_sections` is bounded by UFGS coverage: divisions and sections the federal government does not publish are absent from the table. This is acceptable; the seed is reference data for parser/MCP convenience, not an authoritative MasterFormat index.
- The MCP tool description `list_sections` notes "CSI MasterFormat" in nominative use to identify the numbering scheme — this is descriptive fair use, not a claim of authoritative MasterFormat content.
- Future seed additions MUST come from public-domain or properly-licensed sources only. Adding a CSI-sourced publication to the seed pipeline would invalidate this ADR and require revisiting.

## Verification

Run `grep -rn 'INSERT INTO csi_sections\|FROM csi_sections' src/db/` to confirm `src/db/seed.ts` is the only writer. Run `cat docs/references/ARCAT/README.md` and `docs/references/MANUFACTURER_CPI/README.md` to confirm those dirs document "Not Included" status.
```

- [ ] **Step 2: Verify file**

Run: `ls docs/adr/013-csi-sections-seed-public-domain-derivation.md`
Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add docs/adr/013-csi-sections-seed-public-domain-derivation.md
git commit -m "docs(adr): document UFGS-only derivation of csi_sections seed (ADR-013)"
```

---

### Task B2: Cross-link ADR-013 from seed.ts and UFGS README

**Files:**
- Modify: `src/db/seed.ts:5-6`
- Modify: `docs/references/UFGS/README.md`

- [ ] **Step 1: Add provenance comment to seed.ts**

Insert one line above `const UFGS_DIR = ...` at `src/db/seed.ts:6`:

```typescript
// Provenance: see docs/adr/013-csi-sections-seed-public-domain-derivation.md
const UFGS_DIR = join(process.cwd(), 'docs/references/UFGS');
```

- [ ] **Step 2: Append cross-link to UFGS README**

Append to `docs/references/UFGS/README.md`:

```markdown

## Use in SpecR

UFGS is the **sole** source for the `csi_sections` reference table seed. See
[ADR-013](../../adr/013-csi-sections-seed-public-domain-derivation.md).
```

- [ ] **Step 3: Run lint to verify TypeScript still compiles**

Run: `pnpm lint`
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add src/db/seed.ts docs/references/UFGS/README.md
git commit -m "docs: cross-link ADR-013 from seed.ts and UFGS README"
```

---

## Phase C: Internal Identifier Rename (OPTIONAL)

> Defer this phase if scope feels heavy. Phases A + B already establish defensible posture. Phase C is architectural hygiene — removes "CSI" from internal identifiers entirely, freeing future expansion to non-CSI numbering systems (UK NBS, German DIN 276, etc.) and shrinking the trademark surface to zero in source code.

### Task C1: Add Spec-prefixed type aliases (non-breaking)

**Files:**
- Modify: `src/ast/types.ts`

- [ ] **Step 1: Read current types**

Run: `cat src/ast/types.ts`

- [ ] **Step 2: Add aliases at end of file**

Append to `src/ast/types.ts`:

```typescript
/**
 * Format-agnostic aliases. Prefer these in new code.
 * The Csi* names are retained for backward compatibility and will be removed
 * once all call sites migrate. See ADR-013 / TRADEMARKS.md for context.
 */
export type SpecNode = CsiNode;
export type SpecTree = CsiTree;
```

- [ ] **Step 3: Verify lint passes**

Run: `pnpm lint`
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add src/ast/types.ts
git commit -m "refactor(ast): add SpecNode/SpecTree aliases (non-breaking)"
```

---

### Task C2: Migrate all src/ + test references to Spec-prefixed types

**Files (~30):**
- All `src/**/*.ts` and `src/**/*.test.ts` files using `CsiNode` / `CsiTree` / `CsiSectionResult`
- Full list from `grep -rln 'Csi\(Node\|Tree\|SectionResult\)' src/`:
  - `src/parser/sec/index.ts`
  - `src/parser/refs/extract.ts`
  - `src/generator/markdown.ts`
  - `src/generator/index.test.ts`
  - `src/db/queries/specs.test.ts`
  - `src/db/queries/search.ts`
  - `scripts/parse-debug.ts`

- [ ] **Step 1: Write the failing test (regression guard)**

Add to `src/ast/types.test.ts` (create if absent):

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { SpecNode, SpecTree, CsiNode, CsiTree } from './types.js';

describe('ast type aliases', () => {
  it('SpecNode is identical to CsiNode', () => {
    expectTypeOf<SpecNode>().toEqualTypeOf<CsiNode>();
  });

  it('SpecTree is identical to CsiTree', () => {
    expectTypeOf<SpecTree>().toEqualTypeOf<CsiTree>();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (aliases already in place from C1)**

Run: `pnpm test -- types.test`
Expected: 2 passing

- [ ] **Step 3: Mechanical rename — types only**

Run the following sed sweep (verify each file's diff before staging):

```bash
git grep -l 'CsiNode\|CsiTree' -- 'src/**/*.ts' 'scripts/**/*.ts' | \
  xargs -I {} sed -i 's/\bCsiNode\b/SpecNode/g; s/\bCsiTree\b/SpecTree/g' {}
```

Then rename `CsiSectionResult` → `SpecSectionResult`:

```bash
git grep -l 'CsiSectionResult' -- 'src/**/*.ts' | \
  xargs -I {} sed -i 's/\bCsiSectionResult\b/SpecSectionResult/g' {}
```

- [ ] **Step 4: Remove now-unused aliases from types.ts**

In `src/ast/types.ts`, delete the alias block (the type system now uses `SpecNode`/`SpecTree` as primaries). Rename the original type declarations:

```typescript
// Before:
export interface CsiNode { ... }
export interface CsiTree { ... }

// After:
export interface SpecNode { ... }
export interface SpecTree { ... }
```

Drop the temporary aliases inserted in C1.

- [ ] **Step 5: Run full lint + tests**

Run: `pnpm lint && pnpm test`
Expected: zero errors, all unit tests pass

- [ ] **Step 6: Commit**

```bash
git add src/ scripts/
git commit -m "refactor: rename Csi{Node,Tree,SectionResult} types to Spec*"
```

---

### Task C3: Rename csi_sections table to spec_sections

**Files:**
- Create: `src/db/migrations/00X_rename_csi_sections_to_spec_sections.ts` (X = next number, currently 005 or higher — check `ls src/db/migrations/`)
- Modify: `src/db/queries/search.ts`
- Modify: `src/db/seed.ts`
- Modify: `src/db/seed.test.ts`

- [ ] **Step 1: Determine next migration number**

Run: `ls src/db/migrations/ | sort | tail -1`
Use the next integer.

- [ ] **Step 2: Write reversible migration**

Create `src/db/migrations/00X_rename_csi_sections_to_spec_sections.ts`:

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.renameTable('csi_sections', 'spec_sections');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.renameTable('spec_sections', 'csi_sections');
};
```

- [ ] **Step 3: Update all SQL references**

In `src/db/seed.ts`, `src/db/queries/search.ts`, and `src/db/seed.test.ts`, replace `csi_sections` with `spec_sections` in INSERT, SELECT, and LEFT JOIN SQL strings.

Run: `git grep -l 'csi_sections' src/`
Expected after edits: zero matches except migration files (`001_create_*` and the new rename migration).

- [ ] **Step 4: Run migration locally**

```bash
docker compose up -d postgres
pnpm migrate
```

Expected: migration succeeds, table is now `spec_sections`.

- [ ] **Step 5: Run integration tests**

```bash
pnpm seed && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 6: Update ADR-013 to note the rename**

Append to `docs/adr/013-csi-sections-seed-public-domain-derivation.md`:

```markdown

## Update 2026-05-18: Table renamed to spec_sections

Migration 00X renames `csi_sections` → `spec_sections` as part of the
trademark-hygiene pass (see ADR-014 if created, or commit history). Provenance
guarantees in this ADR continue to apply to the renamed table.
```

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/00X_rename_csi_sections_to_spec_sections.ts \
        src/db/seed.ts src/db/seed.test.ts src/db/queries/search.ts \
        docs/adr/013-csi-sections-seed-public-domain-derivation.md
git commit -m "refactor(db): rename csi_sections table to spec_sections"
```

---

### Task C4: Update documentation to reflect renames

**Files:**
- Modify: `CLAUDE.md` (references to `CsiNode`, `CsiTree`, `csi_sections`)
- Modify: `README.md` (architecture diagrams + AST type names)
- Modify: `docs/adr/` (any ADR referencing old names — at minimum `006-multi-tier-paragraph-libraries.md`, `008-markdown-parallel-output.md`, `012-ufgs-as-reference-not-authoritative-csi.md`)

- [ ] **Step 1: Inventory all doc references**

Run: `grep -rln 'CsiNode\|CsiTree\|CsiSectionResult\|csi_sections' docs/ CLAUDE.md README.md`

- [ ] **Step 2: For each file, replace identifier names**

Use targeted Edit calls per file (sed risks corrupting code blocks with regex special chars). Keep nominative prose ("CSI MasterFormat") unchanged — only rename code identifiers.

- [ ] **Step 3: Verify**

Run: `grep -rln 'CsiNode\|CsiTree\|csi_sections' docs/ CLAUDE.md README.md`
Expected: zero matches outside historical plan files in `docs/superpowers/plans/`.

(Historical plans are immutable execution records — leave them alone.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md docs/adr/
git commit -m "docs: align identifier names with refactored AST/db schema"
```

---

## Verification Plan

After all phases (or A + B only if C is deferred):

- [ ] `pnpm lint` — zero errors
- [ ] `pnpm test` — all unit tests pass
- [ ] `pnpm test:integration` — all integration tests pass (Phase C only — requires DB)
- [ ] `pnpm build` — TypeScript compiles
- [ ] `cat TRADEMARKS.md` — file exists, attributes all marks
- [ ] `cat docs/adr/013-csi-sections-seed-public-domain-derivation.md` — ADR exists
- [ ] `grep -c '®' README.md` — at least 2 (CSI, MasterFormat first uses)
- [ ] `grep -rn 'CsiNode\|CsiTree' src/` — Phase C: zero matches; Phase A+B only: unchanged

## Phase Gating

- Phase A: ship as one PR (3 commits). Reviewable in 5 minutes.
- Phase B: ship as one PR (2 commits). Reviewable in 5 minutes.
- Phase C: ship as a separate PR (4 commits, larger diff). Includes a migration → integration tests must pass on CI.

Recommended: open Phase A + B as a combined PR titled `chore: trademark good-faith notices (Phase A + B)`. Defer or split-PR Phase C.
