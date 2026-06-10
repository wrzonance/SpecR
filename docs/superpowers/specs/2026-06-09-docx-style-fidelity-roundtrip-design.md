# DOCX Style-Fidelity Round-Trip — Design

**Status:** Approved (brainstormed 2026-06-09)
**Owner decision driver:** round-trip DOCX *with the source document's visual style preserved*
**Relates to:** ADR-021 (extensible JSONB style storage), ADR-003 (canonical AST), issues
#30 (closed), #31, #32, #34–#37, #56, #81
**Supersedes:** the column-storage portions of `2026-05-20-issue-031-design.md` (the CRUD
endpoint design, validation philosophy, transaction flow, and module refactors from that
spec are retained and adapted below).

---

## 1. Problem & vision

We want a full loop: **import a DOCX → capture its style → store a definition (never the raw
file) → edit paragraphs/specs in Postgres → regenerate a DOCX that preserves the style plus
the edits.** Today the parser extracts *structure only* (hierarchy, text, numbering) and
discards every `w:rPr`/`w:pPr` visual property; the generator emits plain runs with hardcoded
numbering; nothing stores style. This program closes that gap.

The work decomposes into **three layers**:

### Layer 1 — Style template, seeded by importing a source-of-truth DOCX
An intentional, opt-in step: a user hits a dedicated endpoint with the canonical document,
and we **translate it into a `style_template` + per-`NodeType` style definitions**, then
discard the bytes. This is the firm's "house style," and it becomes the rendering source for
round-trip output. (This is the `.dotx`/styles.xml import that #31 explicitly deferred.)

### Layer 2 — Per-paragraph / per-run override capture (deviations from the template)
When a working spec is parsed, detect where the author *deviated* from the established
template — a deliberately bolded word, a coloured phrase, a manual indent — and capture only
those **deltas** as an overlay. Used both for a future WYSIWYG view and for emitting exactly
what the author put in. Requires an **effective-style resolver** (Layer-1 dependency, reused
here) and character-span addressability for sub-paragraph fidelity.

### Layer 3 — Clean-up / normalization
Distinguish **intent** (a meaningful bold word → preserve) from **artifact** (a hand-typed
"1.1" duplicating the auto-list, a broken default style → offer to normalize). Builds on the
inference engine's existing Signal 4 (literal-number text detection) and the #56 conflict
surface. Principle: *capture everything, classify each deviation, never silently discard.*

This spec **locks the data model for all three layers** and **fully specifies Layer 1's first
worktree (WT-1)**. Layers 2 and 3 are sketched here for ordering only and get their own
brainstorm → spec cycles.

---

## 2. Data model (locked) — see ADR-021

Style is stored as an **OOXML-faithful JSONB payload**, one definition per CSI paragraph type,
**not** as rigid columns. Rationale and full decision: ADR-021. Summary:

- `style_rules` row = structural columns (`id`, `template_id`, `node_type`) + `properties jsonb`.
- `properties` mirrors `w:pPr`/`w:rPr` (+ `numbering`), tidied names, native units.
- **Open validation**: known keys typed in Zod, unknown keys passed through (never rejected
  or stripped). No max-bound rejection — warn, never boom.
- Generator renders the subset it can express; the rest is preserved.
- Same shape reused for Layer-2 override deltas (narrower scope, identical structure).

### 2.1 `StyleProperties` shape (TypeScript intent)

```typescript
// src/ast/types.ts (style sub-tree — names mirror OOXML, lightly tidied)
interface StyleProperties {
  readonly rPr?: RunProperties;          // run / character formatting
  readonly pPr?: ParagraphProperties;    // paragraph formatting
  readonly numbering?: NumberingDef;      // level numbering for this NodeType
  // unknown OOXML keys preserved at every level (Zod passthrough / catchall)
}

interface RunProperties {
  readonly rFonts?: { ascii?: string; hAnsi?: string; cs?: string; eastAsia?: string };
  readonly sz?: number;       // half-points (20 = 10pt)
  readonly b?: boolean;       // bold
  readonly i?: boolean;       // italic
  readonly caps?: boolean;
  readonly smallCaps?: boolean;
  readonly u?: string;        // underline val: 'single' | 'double' | 'none' | ...
  readonly strike?: boolean;
  readonly color?: string;    // 'RRGGBB' | 'auto'
  readonly highlight?: string;
  // + passthrough unknowns
}

interface ParagraphProperties {
  readonly spacing?: {
    before?: number; after?: number;       // twips
    line?: number; lineRule?: 'auto' | 'exact' | 'atLeast';
    contextualSpacing?: boolean;
  };
  readonly ind?: { left?: number; right?: number; firstLine?: number; hanging?: number }; // twips
  readonly jc?: 'left' | 'center' | 'right' | 'both' | 'distribute' | 'start' | 'end';
  // pBdr, shd, tabs, etc. preserved via passthrough — captured, not yet rendered
  // + passthrough unknowns
}

interface NumberingDef {
  readonly ilvl?: number;
  readonly numFmt?: string;   // 'decimal' | 'upperLetter' | 'lowerLetter' | ...
  readonly lvlText?: string;  // 'PART %1 -'
  readonly start?: number;
}
```

> **Zod (v4) note:** model each object with its known keys typed and an open/loose mode so
> unknown keys survive validation untouched (e.g. `z.looseObject({...})` or
> `.catchall(z.unknown())`). The *passthrough of unknowns is a hard requirement* — it is the
> mechanism that closes the footgun, and it gets an explicit regression test (§4).

### 2.2 Worked examples (grounded in the real UFGS-Default seed)

```jsonc
// node_type = "part"
{
  "rPr": { "rFonts": { "ascii": "Courier New" }, "sz": 20, "b": true, "caps": true },
  "pPr": { "spacing": { "before": 0, "after": 120 }, "ind": { "left": 0 } },
  "numbering": { "ilvl": 0, "numFmt": "decimal", "lvlText": "PART %1 -" }
}

// node_type = "pr1"  — line spacing finally has a home; numbering keeps both numFmt + lvlText
{
  "rPr": { "rFonts": { "ascii": "Courier New" }, "sz": 20 },
  "pPr": {
    "spacing": { "before": 0, "after": 0, "line": 360, "lineRule": "auto" },
    "ind": { "left": 720 }
  },
  "numbering": { "ilvl": 2, "numFmt": "upperLetter", "lvlText": "%3." }
}
```

An unmodelled property (say `pPr.pBdr` or a `w:extLst` vendor blob) simply appears as another
key under `pPr`/`rPr` — no schema change, no data loss.

---

## 3. Worktree decomposition (program ordering)

Each worktree is one demonstrable sub-MVP, branched from `main`, PR'd back, ≤500 in-source LOC
(stacked PRs where a single worktree exceeds that). Phases are gates: a worktree starts only
after its dependency is merged.

| WT | Branch(es) | Delivers | Depends on |
|----|-----------|----------|------------|
| **WT-1** | `feat/style-jsonb` → `feat/issue-31` | JSONB style payload + migration `013`; #31 template CRUD over the payload | #30 (merged) |
| **WT-2** | `feat/effective-style-resolver` | Pure OOXML cascade resolver: `docDefaults → style basedOn chain → direct props` → effective `StyleProperties` | — (parser-internal) |
| **WT-3** | `feat/template-import-docx` | Opt-in `POST /templates/import` (multipart DOCX) → derive per-NodeType definitions → persist → discard bytes; return derived rules + flagged anomalies | WT-1, WT-2 |
| WT-4 (Layer 2a) | `feat/paragraph-style-overrides` | Capture paragraph-level deviations from the active template as `properties` deltas on `paragraphs`; persist + surface | WT-2, WT-3 |
| WT-5 (Layer 2b) | `feat/run-span-fidelity` | Character-span-addressable run overrides (the "one bold word" case) | WT-4 |
| WT-6 (generator) | `feat/generator-apply-style` (advances #32) | Generator applies template `properties` + overrides on export | WT-1 (+WT-4 for overrides) |
| WT-7 (Layer 3) | `feat/style-cleanup-classifiers` | Classify deviations as intent vs artifact; normalize/surface (extends Signal 4 + #56) | WT-4 |

**Out of scope for the whole program (for now):** byte-exact raw-OOXML round-trip; storing
raw `.docx` artifacts; auth/multi-tenancy (#43); tables/drawings/embedded-object fidelity;
`note` styling. Revisit per real fixture need.

---

## 4. WT-1 — detailed spec (the immediately-actionable worktree)

**Goal:** replace the scalar style columns with the JSONB payload and expose #31's template
CRUD over it, so a template's full visual definition can be created, read, edited, and deleted
via REST — and so nothing a future importer captures can overflow the schema.

Lands as **two stacked PRs** on the worktree branch (keeps each within the 500-LOC sub-MVP
rule):

### PR-1a — `feat(db): JSONB style payload + migration 013`

**Migration `013_style_rules_jsonb.ts`** (reversible):
- `up`:
  1. Add `properties jsonb NOT NULL DEFAULT '{}'` to `style_rules`.
  2. **Backfill** `properties` from the existing columns via
     `jsonb_strip_nulls(jsonb_build_object(...))`, nesting into `rPr` / `pPr` / `numbering`:
     - `font_family → rPr.rFonts.ascii`
     - `font_size_half_pt → rPr.sz`
     - `bold → rPr.b`, `caps → rPr.caps`
     - `indent_twips → pPr.ind.left`
     - `space_before_twips → pPr.spacing.before`, `space_after_twips → pPr.spacing.after`
     - `numbering_format → numbering.lvlText`
  3. **Enrich** the UFGS-Default rows with values the old schema could not hold but migration
     `011` already documented: `pPr.spacing.line = 360`, `lineRule = "auto"` for the
     `SpecNormal`-based levels (`pr1`–`pr5`), and `numbering.numFmt` per level
     (`decimal`/`upperLetter`/`lowerLetter`, matching `buildSpecNumberingConfig`). Where the
     original extraction yielded nothing, write nothing — never fabricate.
  4. **Drop** the scalar style columns: `font_family`, `font_size_half_pt`, `bold`, `caps`,
     `indent_twips`, `space_before_twips`, `space_after_twips`, `numbering_format`. Drop the
     now-obsolete `style_rules_non_negative_ooxml_units_check`. Keep `node_type`,
     `(template_id, node_type)` unique, `node_type` CHECK, and the `template_id` index.
- `down`: recreate the dropped columns + the non-negative CHECK, back-project values out of
  `properties` (`properties->'rPr'->>'sz'` etc.), then drop `properties`.

**`src/ast/types.ts`** — add `StyleProperties`, `RunProperties`, `ParagraphProperties`,
`NumberingDef`. **Relocate** `StyleNodeType` + `STYLE_NODE_TYPES` here from
`db/queries/templates.ts` (per #31 spec — `ast/` is the foundational layer; `db/` re-exports
for back-compat).

**`src/ast/schemas.ts`** — add `StylePropertiesSchema` (known keys typed, unknowns preserved
via loose/catchall) and `StyleNodeTypeSchema`.

**`src/db/queries/templates.ts`** — `StyleRule` becomes
`{ nodeType: StyleNodeType; properties: StyleProperties }`. Update `StyleRuleRow`, `mapRuleRow`,
`loadRules` (SELECT `properties`), and `upsertStyleRule` (INSERT/UPDATE `properties` as jsonb).

### PR-1b — `feat(api): template CRUD API (#31) over JSONB`

Implements the six endpoints from the `2026-05-20-issue-031-design.md` spec, **unchanged in
shape**, now carrying `properties` instead of scalar fields:

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/templates` | `{ name, owner? }` | `TemplateMeta` |
| GET | `/templates` | — | `TemplateMeta[]` |
| GET | `/templates/:id` | — | `Template` (incl. rules with `properties`) |
| PATCH | `/templates/:id` | `{ name?, owner? }` | `TemplateMeta` |
| DELETE | `/templates/:id` | — | (204) |
| POST | `/templates/:id/rules` | `{ rules: [{ nodeType, properties }] }` | `Template` |

Retained from the #31 spec: `ApiResponse<T>` envelope; **structural** Zod validation
(now: valid `nodeType`, well-formed `properties` with unknowns preserved — **no** policy
bounds); `pgErrorToHttp` mapping (`23505→409`, `23503→404`; `23514→422` retained for the
remaining structural constraints); `FOR UPDATE` + transactional all-or-nothing bulk upsert;
PATCH dynamic-field update with nullable `owner`; DELETE cascade. Module refactors retained:
extract `getPgCode`/`pgErrorToHttp` → `src/lib/pg-errors.ts`; `loadRules`/`selectTemplateMeta`
accept an optional `PoolClient`.

**Adapted from #31:** validation is **open** — the footgun fix. The `properties` schema must
accept and round-trip unknown keys.

### 4.1 Tests (TDD — red first)

- **Migration reversibility:** `up` then `down` restores the prior column shape; UFGS-Default
  data survives the round-trip (integration, real PG).
- **Backfill correctness:** after `013`, UFGS-Default `pr1` has
  `properties.pPr.spacing.line === 360` and `properties.numbering.numFmt === 'upperLetter'`.
- **Query round-trip:** `upsertStyleRule` then `loadRules` returns the identical
  `StyleProperties` object (jsonb in/out fidelity).
- **#31 endpoint contracts:** the case matrix from the #31 spec (POST/GET/PATCH/DELETE/rules:
  happy paths, duplicate-name 409, unknown-UUID 404, invalid-UUID 400, empty-PATCH 400,
  cascade-on-DELETE, atomic bulk upsert) — bodies now carry `properties`.
- **★ Footgun regression (the decisive test):** `POST /templates/:id/rules` with a rule whose
  `properties.pPr` contains an **unmodelled** key (e.g. `pBdr` / a `w:extLst`-style blob);
  then `GET /templates/:id` returns that key **byte-identical**. Named:
  `templates: unknown OOXML property survives store + load (footgun closed)`.

### 4.2 Acceptance criteria

- [ ] Migration `013` up/down both run clean; CI `migrate → seed → test → test:integration` green.
- [ ] UFGS-Default's previously-unstorable `line=360` is present in `properties` after migrate.
- [ ] All six #31 endpoints behave per the contract matrix, carrying `properties`.
- [ ] An unknown OOXML property survives a store→load round-trip unchanged (★ test passes).
- [ ] No `console.log`, `any`, `as unknown as`, or non-null assertions added.
- [ ] Lint, type-check, unit, integration all green.
- [ ] Each PR within sub-MVP scope. LOC-check is advisory (CI warns >500). #31's CRUD is
      ~575 in-source per its original spec — acceptable under reviewer enforcement, or split
      the `POST /:id/rules` bulk endpoint into its own PR if review prefers.

### 4.3 Open items deferred (not WT-1)

- Generator applying `properties` on export → WT-6 (advances #32).
- Importing a DOCX to *populate* `properties` → WT-3 (needs WT-2 resolver).
- Per-paragraph/run override deltas → WT-4/WT-5.

---

## 5. Risks & notes

- **Migration on shipped schema.** `013` rewrites a table #30 shipped. Only UFGS-Default data
  exists today, so backfill risk is low; still, the down path is tested for reversibility.
- **`011` runs before `013` on fresh DBs.** `011` seeds the scalar columns, `013` converts then
  drops them — correct ordering, no edit to the immutable `011`.
- **Zod v4 open-object API.** Confirm the exact loose/catchall form during implementation; the
  requirement (preserve unknowns) is fixed, the API spelling is an implementation detail.
- **Generator gap is real.** Until WT-6, stored `properties` are not yet rendered — WT-1 proves
  storage + API only. State this in the WT-1 PR so it is not mistaken for end-to-end fidelity.
