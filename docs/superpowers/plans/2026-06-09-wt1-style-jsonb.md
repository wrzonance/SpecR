# WT-1 PR-1a — JSONB Style Payload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `style_rules`' scalar style columns with one OOXML-faithful JSONB `properties` payload (ADR-021), updating the AST types, Zod schema, the `014` migration, and the query layer — so style storage is lossless and unknown OOXML properties can never overflow the schema.

**Architecture:** `style_rules` keeps its structural columns (`id`, `template_id`, `node_type`) plus a new `properties jsonb NOT NULL DEFAULT '{}'`. Migration `014` backfills the payload from the old columns, enriches `UFGS-Default` with the previously-unstorable line spacing + `numFmt`, then drops the scalar columns. Validation moves to an **open** Zod schema (`z.looseObject`) that types known keys and passes unknown ones through. This is **PR-1a of WT-1**; the #31 CRUD API (PR-1b) is a separate follow-on plan that consumes these shapes.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Zod v4 (`z.looseObject`), node-pg-migrate v8 (`.ts` migrations), PostgreSQL (jsonb), Vitest (`unit` + `integration` projects).

**Scope (this plan = PR-1a only):**
- IN: AST style types, Zod `StylePropertiesSchema`, migration `014`, query-layer rewrite, updated + new tests.
- OUT → PR-1b (separate plan): the six `/templates` HTTP endpoints, `pg-errors` extraction, bulk-upsert transaction.
- OUT → later WTs: generator applying style (WT-6), DOCX import (WT-3), override capture (WT-4/5).

**Prerequisites:**
- On worktree branch `feat/style-jsonb` (created at execution time via `superpowers:using-git-worktrees`).
- Postgres reachable for integration tests. Per project memory, nothing auto-loads `.env`; run an isolated PG (e.g. on 5434) and pass `DATABASE_URL` + `NODE_ENV=test` inline. Migrations + `UFGS-Default` seed come from migrations `010`/`011`/`014` (run via `pnpm migrate`), not `pnpm seed`.
- Commands: unit `pnpm test`; integration `pnpm test:integration`; migrate `pnpm migrate` / `pnpm migrate:down`; lint `pnpm lint`.

**Key reference values (from migration `011`, the `UFGS-Default` seed):** font `Courier New`, `sz=20` all levels; `part` bold+caps, `numbering_format='PART %1 -'`; `pr1` `indent=720`, `numbering_format='%3.'`; the seed comment records `SpecNormal line=360` for `pr1`–`pr5` that the old columns could not store. Generator `numFmt` by level: part/article/pr2/pr4 `decimal`, pr1 `upperLetter`, pr3/pr5 `lowerLetter`.

---

## Task 1: Relocate `StyleNodeType` + add open style schema/types to the AST layer

This task is additive + a relocation. The old `StyleRule` shape stays intact, so the repo stays green.

**Files:**
- Modify: `src/ast/schemas.ts` (add `StyleNodeTypeSchema` + `StylePropertiesSchema` and sub-schemas)
- Modify: `src/ast/types.ts` (derive `StyleProperties`, `StyleNodeType`; add `STYLE_NODE_TYPES`)
- Modify: `src/db/queries/templates.ts` (import + re-export from `ast/`; delete local `StyleNodeType`/`STYLE_NODE_TYPES`)
- Modify: `src/db/index.ts` (barrel: add `StyleProperties` to template type re-exports)
- Test: `src/ast/style-schemas.test.ts` (new, unit)

- [ ] **Step 1: Write the failing unit test**

Create `src/ast/style-schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { StylePropertiesSchema } from './schemas.js';

describe('StylePropertiesSchema (ADR-021 open style payload)', () => {
  it('parses a known OOXML-faithful definition unchanged', () => {
    const input = {
      rPr: { rFonts: { ascii: 'Courier New' }, sz: 20, b: true, caps: true },
      pPr: { spacing: { before: 0, after: 120 }, ind: { left: 0 } },
      numbering: { ilvl: 0, numFmt: 'decimal', lvlText: 'PART %1 -' },
    };
    expect(StylePropertiesSchema.parse(input)).toEqual(input);
  });

  it('preserves UNKNOWN OOXML properties at every level (footgun closed)', () => {
    const input = {
      rPr: { sz: 24, unknownRunProp: 'x' },
      pPr: { pBdr: { top: { val: 'single', sz: 4 } }, vendorExt: { foo: 1 } },
      topLevelUnknown: true,
    };
    // Unknown keys must round-trip byte-for-byte — nothing rejected, nothing stripped.
    expect(StylePropertiesSchema.parse(input)).toEqual(input);
  });

  it('rejects a structurally-wrong KNOWN key (sz must be an integer)', () => {
    expect(() => StylePropertiesSchema.parse({ rPr: { sz: 'big' } })).toThrow();
  });

  it('allows a negative left indent (signed OOXML unit — never reject the source)', () => {
    const input = { pPr: { ind: { left: -360 } } };
    expect(StylePropertiesSchema.parse(input)).toEqual(input);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/ast/style-schemas.test.ts`
Expected: FAIL — `StylePropertiesSchema` is not exported from `./schemas.js`.

- [ ] **Step 3: Add the open Zod schemas to `src/ast/schemas.ts`**

Append to `src/ast/schemas.ts` (after the existing exports):

```typescript
// ── Style properties (ADR-021): OOXML-faithful, OPEN (unknown keys preserved) ──
// `z.looseObject` keeps keys not listed here at runtime AND adds an index
// signature to the inferred type — this is the footgun fix. Numeric fields use
// `z.number().int()` only (no sign/range bound): per ADR-021 we capture the
// author's truth (e.g. a negative left indent) and warn elsewhere, never reject.

export const StyleNodeTypeSchema = z.enum([
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
]);

const RunPropertiesSchema = z.looseObject({
  rFonts: z
    .looseObject({
      ascii: z.string().exactOptional(),
      hAnsi: z.string().exactOptional(),
      cs: z.string().exactOptional(),
      eastAsia: z.string().exactOptional(),
    })
    .exactOptional(),
  sz: z.number().int().exactOptional(),
  b: z.boolean().exactOptional(),
  i: z.boolean().exactOptional(),
  caps: z.boolean().exactOptional(),
  smallCaps: z.boolean().exactOptional(),
  u: z.string().exactOptional(),
  strike: z.boolean().exactOptional(),
  color: z.string().exactOptional(),
  highlight: z.string().exactOptional(),
});

const ParagraphPropertiesSchema = z.looseObject({
  spacing: z
    .looseObject({
      before: z.number().int().exactOptional(),
      after: z.number().int().exactOptional(),
      line: z.number().int().exactOptional(),
      lineRule: z.enum(['auto', 'exact', 'atLeast']).exactOptional(),
      contextualSpacing: z.boolean().exactOptional(),
    })
    .exactOptional(),
  ind: z
    .looseObject({
      left: z.number().int().exactOptional(),
      right: z.number().int().exactOptional(),
      firstLine: z.number().int().exactOptional(),
      hanging: z.number().int().exactOptional(),
    })
    .exactOptional(),
  jc: z.enum(['left', 'center', 'right', 'both', 'distribute', 'start', 'end']).exactOptional(),
});

const NumberingDefSchema = z.looseObject({
  ilvl: z.number().int().exactOptional(),
  numFmt: z.string().exactOptional(),
  lvlText: z.string().exactOptional(),
  start: z.number().int().exactOptional(),
});

export const StylePropertiesSchema = z.looseObject({
  rPr: RunPropertiesSchema.exactOptional(),
  pPr: ParagraphPropertiesSchema.exactOptional(),
  numbering: NumberingDefSchema.exactOptional(),
});
```

> If the installed Zod build lacks `z.looseObject`, the equivalent is
> `z.object({...}).catchall(z.unknown())` — same behavior (keep unknown keys + index signature).
> Confirm by running the Step-1 test; the "preserves UNKNOWN" case is the gate.

- [ ] **Step 4: Add the derived types to `src/ast/types.ts`**

In `src/ast/types.ts`, extend the existing import from `./schemas.js` and add the style types:

```typescript
// change the existing import line to include the two new schemas:
import { NodeTypeSchema, SecRefSchema, StyleNodeTypeSchema, StylePropertiesSchema } from './schemas.js';

// ...existing types unchanged...

// ── Style (ADR-021) ─────────────────────────────────────────────────────────
// StyleNodeType / STYLE_NODE_TYPES relocated here from db/queries/templates.ts:
// ast/ is the foundational layer (db/ depends on ast/, never the reverse).
export type StyleNodeType = z.infer<typeof StyleNodeTypeSchema>;
export const STYLE_NODE_TYPES = StyleNodeTypeSchema.options;

/**
 * OOXML-faithful per-NodeType visual style, stored as the `style_rules.properties`
 * JSONB payload. Typed keys are the ones we understand; the loose schema preserves
 * any other OOXML key a real document carries (the type carries an index signature).
 */
export type StyleProperties = z.infer<typeof StylePropertiesSchema>;
```

- [ ] **Step 5: Re-point `src/db/queries/templates.ts` at the relocated symbols**

In `src/db/queries/templates.ts`, **delete** the local `StyleNodeType` type and `STYLE_NODE_TYPES`
const (lines defining them), and replace the top of the file:

```typescript
import { pool, DatabaseError } from '../index.js';
import type { StyleNodeType, StyleProperties } from '../../ast/types.js';
import { STYLE_NODE_TYPES } from '../../ast/types.js';

// Re-export the relocated symbols (local bindings — NOT `export ... from`, which
// would duplicate the imported identifiers) so existing importers (db/index.ts
// barrel, integration tests) keep resolving them from this module.
export type { StyleNodeType, StyleProperties };
export { STYLE_NODE_TYPES };
```

`StyleNodeType` is used internally (old + new `StyleRule`); `StyleProperties` and
`STYLE_NODE_TYPES` are "used" via the re-export, so no `no-unused-vars` error. Leave the rest
of `templates.ts` (old `StyleRule`/`upsertStyleRule`) unchanged in this task.

- [ ] **Step 6: Add `StyleProperties` to the `src/db/index.ts` barrel**

In `src/db/index.ts`, extend the template type re-export:

```typescript
export type {
  StyleNodeType,
  StyleRule,
  Template,
  TemplateMeta,
  StyleProperties,
} from './queries/templates.js';
```

- [ ] **Step 7: Run unit test + type-check**

Run: `pnpm test src/ast/style-schemas.test.ts`
Expected: PASS (all four cases).
Run: `pnpm lint`
Expected: PASS (no type errors; no unused symbols).

- [ ] **Step 8: Commit**

```bash
git add src/ast/schemas.ts src/ast/types.ts src/ast/style-schemas.test.ts \
        src/db/queries/templates.ts src/db/index.ts
git commit -m "feat(ast): open StyleProperties schema + relocate StyleNodeType (ADR-021)"
```

---

## Task 2: Migration `014` + query-layer rewrite (co-changed to stay green)

The migration drops columns the old query layer reads, so the migration and the query rewrite
**must land together**. Write the integration tests first (red), then migration + queries (green).

**Files:**
- Create: `src/db/migrations/014_style_rules_jsonb.ts`
- Modify: `src/db/queries/templates.ts` (`StyleRule`, `StyleRuleRow`, `mapRuleRow`, `loadRules`, `upsertStyleRule`)
- Test: `src/db/queries/templates.integration.test.ts` (update old-shape cases; add backfill + footgun cases)

- [ ] **Step 1: Rewrite the existing integration test to the new shape + add new cases (red)**

Edit `src/db/queries/templates.integration.test.ts`. Replace the `part rule has correct
UFGS-extracted values` test, the `upsertStyleRule` block's `ruleFor`, the two `indentTwips`
assertions, and the FK-cascade rule object, and add two new tests. Concretely:

Replace the `part rule…` test (was asserting `fontFamily`/`bold`/etc. as columns):

```typescript
  it('part rule carries UFGS-extracted values in the JSONB payload', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const part = tpl!.rules.find((r) => r.nodeType === 'part');
    expect(part).toBeDefined();
    expect(part!.properties.rPr?.rFonts?.ascii).toBe('Courier New');
    expect(part!.properties.rPr?.sz).toBe(20);
    expect(part!.properties.rPr?.b).toBe(true);
    expect(part!.properties.rPr?.caps).toBe(true);
    expect(part!.properties.numbering?.lvlText).toBe('PART %1 -');
  });

  it('migration 014 enriched UFGS-Default pr1 with the previously-lost line spacing', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const pr1 = tpl!.rules.find((r) => r.nodeType === 'pr1');
    expect(pr1!.properties.pPr?.spacing?.line).toBe(360);
    expect(pr1!.properties.pPr?.spacing?.lineRule).toBe('auto');
    expect(pr1!.properties.numbering?.numFmt).toBe('upperLetter');
    expect(pr1!.properties.pPr?.ind?.left).toBe(720);
  });
```

Replace the `upsertStyleRule` describe block's `ruleFor` + assertions:

```typescript
describe('upsertStyleRule', () => {
  function ruleFor(nodeType: StyleNodeType, indent: number): StyleRule {
    return { nodeType, properties: { pPr: { ind: { left: indent } } } };
  }

  it('inserts on first call, updates on second call (idempotent)', async () => {
    const name = trackName(`upsert-test-${Date.now()}`);
    const meta = await createTemplate(name);

    await upsertStyleRule(meta.id, ruleFor('pr1', 720));
    const first = await getTemplate(meta.id);
    expect(first!.rules).toHaveLength(1);
    expect(first!.rules[0]!.properties.pPr?.ind?.left).toBe(720);

    await upsertStyleRule(meta.id, ruleFor('pr1', 1440));
    const second = await getTemplate(meta.id);
    expect(second!.rules).toHaveLength(1); // still one row
    expect(second!.rules[0]!.properties.pPr?.ind?.left).toBe(1440); // updated
  });

  it('round-trips an UNKNOWN OOXML property through jsonb (footgun closed)', async () => {
    const name = trackName(`footgun-test-${Date.now()}`);
    const meta = await createTemplate(name);
    // Build via the schema so `properties` has exactly the inferred type (avoids an
    // excess-property error on the unknown key) and so this also proves a
    // schema-validated payload — including its unknown key — survives the DB round-trip.
    const properties = StylePropertiesSchema.parse({
      rPr: { rFonts: { ascii: 'Arial' }, sz: 24, i: true },
      pPr: { spacing: { line: 360, lineRule: 'auto' }, ind: { left: 720, hanging: 360 } },
      numbering: { ilvl: 2, numFmt: 'upperLetter', lvlText: '%3.' },
      pBdrUnknown: { top: 'single' }, // not modelled — must survive
    });
    await upsertStyleRule(meta.id, { nodeType: 'pr1', properties });
    const loaded = await getTemplate(meta.id);
    const rule = loaded!.rules.find((r) => r.nodeType === 'pr1');
    expect(rule!.properties).toEqual(properties);
  });
});
```

Also add this import at the top of the test file (used by the footgun test above):

```typescript
import { StylePropertiesSchema } from '../../ast/schemas.js';
```

Replace the FK-cascade test's inline rule object with the new shape:

```typescript
    await upsertStyleRule(meta.id, { nodeType: 'pr1', properties: {} });
```

- [ ] **Step 2: Run the integration tests to verify they fail**

Run: `pnpm test:integration src/db/queries/templates.integration.test.ts`
Expected: FAIL — old `StyleRule` shape no longer compiles / `properties` column missing.

- [ ] **Step 3: Write migration `014`**

Create `src/db/migrations/014_style_rules_jsonb.ts`:

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ADR-021: replace the scalar style columns on style_rules with one OOXML-faithful
 * JSONB `properties` payload. Backfill from the old columns, enrich UFGS-Default with
 * the line spacing the old schema could not hold (migration 011 documented line=360),
 * then drop the scalar columns. Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('style_rules', {
    properties: { type: 'jsonb', notNull: true, default: '{}' },
  });

  // Backfill from scalar columns. jsonb_strip_nulls drops null-valued keys recursively
  // so absent data does not become `null` noise.
  pgm.sql(`
    UPDATE style_rules SET properties = jsonb_strip_nulls(jsonb_build_object(
      'rPr', jsonb_strip_nulls(jsonb_build_object(
        'rFonts', CASE WHEN font_family IS NULL THEN NULL
                       ELSE jsonb_build_object('ascii', font_family) END,
        'sz', font_size_half_pt,
        'b', CASE WHEN bold THEN true ELSE NULL END,
        'caps', CASE WHEN caps THEN true ELSE NULL END
      )),
      'pPr', jsonb_strip_nulls(jsonb_build_object(
        'spacing', jsonb_strip_nulls(jsonb_build_object(
          'before', space_before_twips,
          'after', space_after_twips
        )),
        'ind', jsonb_strip_nulls(jsonb_build_object('left', indent_twips))
      )),
      'numbering', jsonb_strip_nulls(jsonb_build_object('lvlText', numbering_format))
    ))
  `);

  // Enrich UFGS-Default: SpecNormal line spacing on pr1..pr5, and numFmt + ilvl per
  // level (matches generator buildSpecNumberingConfig). Never fabricate beyond this.
  pgm.sql(`
    UPDATE style_rules sr SET properties = jsonb_set(
      jsonb_set(sr.properties, '{pPr,spacing,line}', '360'::jsonb, true),
      '{pPr,spacing,lineRule}', '"auto"'::jsonb, true
    )
    FROM style_templates st
    WHERE sr.template_id = st.id AND st.name = 'UFGS-Default'
      AND sr.node_type IN ('pr1','pr2','pr3','pr4','pr5')
  `);
  pgm.sql(`
    UPDATE style_rules sr SET properties = jsonb_set(
      sr.properties, '{numbering}',
      COALESCE(sr.properties->'numbering', '{}'::jsonb)
        || jsonb_build_object('numFmt', v.fmt, 'ilvl', v.ilvl),
      true
    )
    FROM style_templates st, (VALUES
      ('part','decimal',0),('article','decimal',1),('pr1','upperLetter',2),
      ('pr2','decimal',3),('pr3','lowerLetter',4),('pr4','decimal',5),('pr5','lowerLetter',6)
    ) AS v(node_type, fmt, ilvl)
    WHERE sr.template_id = st.id AND st.name = 'UFGS-Default' AND sr.node_type = v.node_type
  `);

  pgm.dropConstraint('style_rules', 'style_rules_non_negative_ooxml_units_check');
  pgm.dropColumns('style_rules', [
    'font_family',
    'font_size_half_pt',
    'bold',
    'caps',
    'indent_twips',
    'space_before_twips',
    'space_after_twips',
    'numbering_format',
  ]);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.addColumns('style_rules', {
    font_family: { type: 'text' },
    font_size_half_pt: { type: 'integer' },
    bold: { type: 'boolean', notNull: true, default: false },
    caps: { type: 'boolean', notNull: true, default: false },
    indent_twips: { type: 'integer' },
    space_before_twips: { type: 'integer' },
    space_after_twips: { type: 'integer' },
    numbering_format: { type: 'text' },
  });
  // Best-effort back-projection (enrichment-only values like line=360 are dropped —
  // the old columns cannot hold them).
  pgm.sql(`
    UPDATE style_rules SET
      font_family        = properties #>> '{rPr,rFonts,ascii}',
      font_size_half_pt  = (properties #>> '{rPr,sz}')::int,
      bold               = COALESCE((properties #>> '{rPr,b}')::boolean, false),
      caps               = COALESCE((properties #>> '{rPr,caps}')::boolean, false),
      indent_twips       = (properties #>> '{pPr,ind,left}')::int,
      space_before_twips = (properties #>> '{pPr,spacing,before}')::int,
      space_after_twips  = (properties #>> '{pPr,spacing,after}')::int,
      numbering_format   = properties #>> '{numbering,lvlText}'
  `);
  pgm.addConstraint('style_rules', 'style_rules_non_negative_ooxml_units_check', {
    check: `
      (font_size_half_pt IS NULL OR font_size_half_pt >= 0) AND
      (indent_twips IS NULL OR indent_twips >= 0) AND
      (space_before_twips IS NULL OR space_before_twips >= 0) AND
      (space_after_twips IS NULL OR space_after_twips >= 0)
    `,
  });
  pgm.dropColumns('style_rules', ['properties']);
};
```

- [ ] **Step 4: Rewrite the query layer in `src/db/queries/templates.ts`**

Replace the `StyleRule` interface, `StyleRuleRow` interface, `mapRuleRow`, `loadRules`, and
`upsertStyleRule` with the JSONB shapes (everything else in the file stays):

```typescript
export interface StyleRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}

// ...TemplateMeta / Template / TemplateRow unchanged...

interface StyleRuleRow {
  readonly node_type: StyleNodeType;
  readonly properties: StyleProperties; // pg returns jsonb already parsed
}

function mapRuleRow(row: StyleRuleRow): StyleRule {
  return { nodeType: row.node_type, properties: row.properties };
}

async function loadRules(templateId: string): Promise<readonly StyleRule[]> {
  const result = await pool.query<StyleRuleRow>(
    `SELECT node_type, properties
     FROM style_rules WHERE template_id = $1
     ORDER BY node_type`,
    [templateId]
  );
  return result.rows.map(mapRuleRow);
}

export async function upsertStyleRule(templateId: string, rule: StyleRule): Promise<void> {
  try {
    // node-postgres JSON.stringifies a plain object param into the jsonb column.
    await pool.query(
      `INSERT INTO style_rules (template_id, node_type, properties)
       VALUES ($1, $2, $3)
       ON CONFLICT (template_id, node_type) DO UPDATE SET properties = EXCLUDED.properties`,
      [templateId, rule.nodeType, rule.properties]
    );
  } catch (err) {
    throw new DatabaseError('failed to upsert style rule', { cause: err });
  }
}
```

- [ ] **Step 5: Apply the migration**

Run: `pnpm migrate`
Expected: migration `014_style_rules_jsonb` runs; "Migrations complete".

- [ ] **Step 6: Run the integration tests to verify they pass**

Run: `pnpm test:integration src/db/queries/templates.integration.test.ts`
Expected: PASS — including `migration 014 enriched UFGS-Default pr1…` and
`round-trips an UNKNOWN OOXML property…`.

- [ ] **Step 7: Type-check + lint**

Run: `pnpm lint`
Expected: PASS (no `any`, no unused, file under 400 lines).

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/014_style_rules_jsonb.ts \
        src/db/queries/templates.ts \
        src/db/queries/templates.integration.test.ts
git commit -m "feat(db): JSONB style payload + migration 014 (replaces scalar style columns, ADR-021)"
```

---

## Task 3: Verify reversibility + full green sweep

**Files:** none (verification only).

- [ ] **Step 1: Verify the migration is reversible**

Run: `pnpm migrate` (ensure `014` applied)
Run: `pnpm migrate:down`
Expected: `014` down runs clean — scalar columns restored, `properties` dropped, no error.
Run: `pnpm migrate`
Expected: `014` up re-runs clean.

- [ ] **Step 2: Full sweep**

Run: `pnpm lint && pnpm test && pnpm test:integration`
Expected: all green.

- [ ] **Step 3: Confirm no stray references to the dropped columns**

Run: `git grep -nE 'fontSizeHalfPt|spaceBeforeTwips|spaceAfterTwips|indentTwips|numberingFormat|font_size_half_pt|space_before_twips|indent_twips' -- src ':!src/db/migrations'`
Expected: no matches outside `src/db/migrations/` (the migrations legitimately reference the old column names). If any appear, update them to the `properties` shape.

- [ ] **Step 4: Commit (only if Step 3 required fixes)**

```bash
git add -A && git commit -m "refactor(db): drop residual scalar-style-column references"
```

---

## Done criteria (PR-1a)

- [ ] `pnpm lint`, `pnpm test`, `pnpm test:integration` all green.
- [ ] `UFGS-Default` `pr1` exposes `properties.pPr.spacing.line === 360` (the value the old schema lost).
- [ ] An unknown OOXML property survives an `upsertStyleRule` → `getTemplate` round-trip unchanged.
- [ ] `pnpm migrate` → `pnpm migrate:down` → `pnpm migrate` runs clean (reversible).
- [ ] No `console.log`, `any`, `as unknown as`, or non-null assertions added outside tests.

**Next:** PR-1b (#31 template CRUD API over the JSONB payload) — its own plan, derived from
`docs/superpowers/specs/2026-05-20-issue-031-design.md` adapted to open validation.
