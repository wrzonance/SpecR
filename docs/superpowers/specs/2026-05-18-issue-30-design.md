# Issue #30 — Phase 2c-i: style_templates + style_rules + default seed

**Status:** Approved 2026-05-18 — ready for plan + implementation
**Issue:** https://github.com/wrzonance/SpecR/issues/30
**Branch:** `feat/issue-30`
**Assigned migration numbers:** 010 (schema), 011 (seed)

## Context

Generator currently hardcodes the CSI MasterFormat numbering format (`PART %1 -`, `%1.%2`, etc.) in `src/generator/numbering.ts::buildCsiNumberingConfig()` and emits library-default run properties (font/size/bold) via `dolanmiu/docx`. This PR introduces the DB schema for per-firm style templates so future PRs can override defaults per firm without touching code.

Downstream PRs (out of scope here):

- **#31** — template CRUD HTTP endpoints
- **#32** — generator reads `style_rules` from DB and applies font/size/indent/spacing/bold/caps
- **#42** — UI for firm template management
- **#81** — extending paragraph depth beyond pr5 (filed 2026-05-18)

## Schema (migration 010)

`src/db/migrations/010_style_templates.ts` — node-pg-migrate `.ts` migration with `up` and `down`.

```sql
CREATE TABLE style_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  owner TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE style_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES style_templates(id) ON DELETE CASCADE,
  node_type VARCHAR(20) NOT NULL,        -- 'part' | 'article' | 'pr1'..'pr5'
  font_family TEXT,
  font_size_half_pt INTEGER,             -- OOXML native unit: 20 = 10pt
  bold BOOLEAN NOT NULL DEFAULT false,
  caps BOOLEAN NOT NULL DEFAULT false,
  indent_twips INTEGER,
  space_before_twips INTEGER,
  space_after_twips INTEGER,
  numbering_format TEXT,
  UNIQUE (template_id, node_type)
);
CREATE INDEX style_rules_template_idx ON style_rules (template_id);
```

### Schema decisions vs original issue body

| Field | Original | Final | Reason |
|-------|----------|-------|--------|
| `font_size_pt` | NUMERIC | `font_size_half_pt INTEGER` | OOXML native unit; no float drift |
| `space_before_pt`, `space_after_pt` | NUMERIC | `*_twips INTEGER` | OOXML native unit |
| `caps` | absent | `BOOLEAN NOT NULL DEFAULT false` | UFGS PART/Article use `w:caps` |
| `(template_id, node_type)` | no constraint | `UNIQUE` | one rule per type per template |
| `style_templates.name` | no constraint | `UNIQUE` | stable lookup by name (`UFGS-Default`) |
| `template_id` | implicit | `NOT NULL` | every rule belongs to a template |
| `bold` | nullable | `NOT NULL DEFAULT false` | tri-state has no use; default false |

`down` migration: `DROP TABLE style_rules; DROP TABLE style_templates;` (CASCADE handled by FK).

## Seed (migration 011)

`src/db/migrations/011_seed_default_style_rules.ts` — node-pg-migrate `.ts` migration.

Inserts:

1. One row in `style_templates`: `name = 'UFGS-Default'`, `owner = NULL`.
2. Seven rows in `style_rules` (one per NodeType), values extracted from the UFGS fixture below.

### Extraction methodology

Source fixture: `docs/references/UFGS/DIVISION_27/27080001.docx`. **Not committed** — added to `.gitignore` (see [Gitignore](#gitignore)). Implementing agent must have the file present locally to extract values.

Extraction commands:

```bash
unzip -p docs/references/UFGS/DIVISION_27/27080001.docx word/styles.xml    > /tmp/specr-styles.xml
unzip -p docs/references/UFGS/DIVISION_27/27080001.docx word/numbering.xml > /tmp/specr-numbering.xml
```

For each NodeType, resolve `basedOn` chain in `styles.xml` and `numPr → numId → abstractNum → ilvl` in `numbering.xml`. Record the resolved values in a markdown comment block at the top of `011_seed_default_style_rules.ts` so future reviewers can verify mapping without re-running extraction.

| NodeType | UFGS style id | numId / ilvl | Expected fields |
|----------|---------------|--------------|-----------------|
| part     | `PART`        | numId=2, ilvl=0 | font=Courier New, sz=20, bold=true, caps=true |
| article  | `Article`     | (resolve from Level list, likely ilvl=1) | caps=true, bold=false |
| pr1      | (Level list ilvl=2) | resolve | from numbering.xml ilvl=2 |
| pr2      | (Level list ilvl=3) | resolve | from numbering.xml ilvl=3 |
| pr3      | (Level list ilvl=4) | resolve | from numbering.xml ilvl=4 |
| pr4      | (Level list ilvl=5) | resolve | from numbering.xml ilvl=5 |
| pr5      | (Level list ilvl=6) | resolve | from numbering.xml ilvl=6 |

Indent: `w:ind w:start` lookup order — abstractNum level override → paragraph style → `null`.
Spacing: `w:spacing w:before/w:after` lookup order — paragraph style → `null`.
`numbering_format`: from `w:lvlText` at the resolved ilvl (e.g. `'PART %1 -'`, `'%1.%2'`, `'%3.'`, etc.). Must match values currently in `buildSpecNumberingConfig()` after rename.

If extraction yields no value for a column, write `NULL` — do not fabricate.

### Why a separate migration (011) for the seed

Keeps the schema concern (010) reversible without losing the seed authoring history. Matches existing repo pattern: every numbered concern gets its own file. `pnpm migrate:down` rolls 011 back first (delete seed rows), then 010 (drop tables).

## Queries (`src/db/queries/templates.ts`)

```typescript
export interface StyleRule {
  nodeType: string;
  fontFamily: string | null;
  fontSizeHalfPt: number | null;
  bold: boolean;
  caps: boolean;
  indentTwips: number | null;
  spaceBeforeTwips: number | null;
  spaceAfterTwips: number | null;
  numberingFormat: string | null;
}

export interface Template {
  id: string;
  name: string;
  owner: string | null;
  createdAt: Date;
  rules: readonly StyleRule[];
}

export interface TemplateMeta {
  id: string;
  name: string;
  owner: string | null;
  createdAt: Date;
}

export async function getTemplate(id: string): Promise<Template | null>;
export async function getTemplateByName(name: string): Promise<Template | null>;
export async function listTemplates(): Promise<readonly TemplateMeta[]>;
export async function createTemplate(name: string, owner?: string): Promise<TemplateMeta>;
export async function upsertStyleRule(templateId: string, rule: StyleRule): Promise<void>;
```

Re-export all five from `src/db/index.ts` (barrel pattern per CLAUDE.md).

Rationale:

- `getTemplateByName` — #32 generator needs stable lookup by `'UFGS-Default'`, not UUID.
- `listTemplates` returns metadata only (`TemplateMeta`) — small payload for future UI dropdowns; full template via `getTemplate(id)`.
- `Template.rules` is `readonly StyleRule[]` — immutability per coding-style.md.
- `upsertStyleRule` uses `ON CONFLICT (template_id, node_type) DO UPDATE` — idempotent.

## Csi rename (in scope)

| File | Change |
|------|--------|
| `src/generator/numbering.ts` | `buildCsiNumberingConfig` → `buildSpecNumberingConfig`; `'csi-numbering'` literal → `'spec-numbering'` |
| `src/generator/index.ts` | `CSI_NUM_REF` const → `SPEC_NUM_REF` with value `'spec-numbering'`; update import |
| `src/generator/*.test.ts` | Update any references |
| Any other grep hits in `src/` | Update |

Verification:

```bash
grep -rn 'csi-numbering\|buildCsiNumberingConfig\|CSI_NUM_REF' src/
# zero hits required
```

**Not** touched: conceptual references like "CSI MasterFormat" / "canonical CSI AST" in comments and docs — those name the standards body, not internal types.

## Gitignore

Append to `.gitignore`:

```
# UFGS source fixtures — extracted at implementation time, values encoded in migrations
docs/references/UFGS/**/*.docx
```

Rationale: fixture is third-party content; values that matter are captured in `011_seed_default_style_rules.ts`. Avoids accidental commit of the source `.docx`.

## Tests

### Integration (`src/db/queries/templates.integration.test.ts`)

- `pnpm migrate` applies 010 + 011 in test setup; clean teardown
- `getTemplateByName('UFGS-Default')` returns template with **exactly 7 rules**
- Each NodeType (`part`, `article`, `pr1`..`pr5`) present **once**
- Specific assertions on `part` row:
  - `fontFamily === 'Courier New'`
  - `fontSizeHalfPt === 20`
  - `bold === true`
  - `caps === true`
  - `numberingFormat === 'PART %1 -'`
- `createTemplate('test-firm', 'Acme')` creates a new row with the given name + owner
- `upsertStyleRule` inserts on first call for `(templateId, 'pr1')`, updates on second call (verify by reading back changed field)
- `listTemplates()` includes at minimum `'UFGS-Default'`
- Deleting template via raw SQL cascades to all linked rules (FK behavior smoke test)
- Migration down: `pnpm migrate:down` twice removes seed then schema; re-apply succeeds

### Unit (`src/generator/numbering.test.ts`)

- `buildSpecNumberingConfig().reference === 'spec-numbering'`
- Level configs unchanged (existing test assertions migrate)

### Generator smoke

- Existing `src/generator/index.test.ts` passes unchanged (output is functionally identical; only the internal reference string renamed)

## Doc updates

- `ARCHITECTURE.md`: add `style_templates` and `style_rules` to the Database Schema section
- No `openapi.yaml` changes (no endpoints yet — those land in #31)

## Acceptance criteria

- [ ] `pnpm migrate` succeeds; `pnpm migrate:down` reverses cleanly through both 010 and 011
- [ ] Default `UFGS-Default` template seeded with 7 `style_rules` rows
- [ ] `getTemplate(id)`, `getTemplateByName(name)`, `listTemplates()`, `createTemplate(...)`, `upsertStyleRule(...)` all behave per spec
- [ ] `grep -rn 'csi-numbering\|buildCsiNumberingConfig\|CSI_NUM_REF' src/` returns zero hits
- [ ] `pnpm lint` clean, `pnpm test` and `pnpm test:integration` pass
- [ ] PR LOC delta under 500 (target ~350)
- [ ] `docs/references/UFGS/**/*.docx` gitignored; fixture not committed

## Out of scope (deferred)

| Excluded | Tracked by |
|----------|-----------|
| Template CRUD HTTP endpoints | #31 |
| Generator applying style_rules to DOCX output | #32 |
| Run properties (`w:rPr`) emission for bold/caps/font | #32 |
| UI for firm template management | #42 |
| Paragraph nesting beyond pr5 | #81 |
| Multi-tenant `owner` isolation (auth-scoped queries) | #43 |

## Risk notes

- **Fixture availability:** Agent must have `27080001.docx` locally. If absent, fail loudly during migration authoring (do not invent values). The `.docx` is in working tree from prior session and is gitignored by this PR.
- **Numbering format mismatch:** If extracted `numbering_format` strings differ from `buildSpecNumberingConfig` values, that is a real discrepancy — surface it in PR description for review rather than silently picking one source.
- **Migration ordering with #46:** #46 is assigned migration 012 (after 010 + 011). If #46 ships first, the agent must re-number — coordinated via parallel-issues skill prompt.
