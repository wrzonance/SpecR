# WT-3 — Template Import from DOCX (Consensus Derivation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD: red before green.

**Goal:** The opt-in `POST /templates/import` endpoint: upload a source-of-truth DOCX → classify its paragraphs → resolve effective styles (WT-2) → derive one `StyleProperties` definition per CSI NodeType by **per-property robust consensus** (program spec §5) → persist as a `style_template` + rules (WT-1 storage) → **discard the bytes** → return the derived template + a derivation report.

**Architecture:** Three layers. (1) A parser seam `analyzeDocxStyles(buffer)` reusing the existing pipeline (numbering/styles/document/classify) plus `resolveStyleCascade`, returning classified paragraphs + per-styleId effective styles. (2) A **pure** derivation module `derive-template.ts` implementing §5: flatten effective styles to leaf paths, per-NodeType per-path voting (mode; dominant>50% wins; else intent = modal style's value; numeric-median fallback), absent-counts-as-a-vote, non-winning values recorded as rejected outliers, per-decision confidence + flags. (3) An API handler that validates the upload, runs (1)+(2), persists atomically via a new transactional `createTemplateWithRules`, and returns `{ template, report }`. The raw DOCX is never stored (ADR-021).

**Tech stack:** existing `multer` memory upload + `assertDocxSafe`; `JSZip` (tests build in-memory DOCX buffers); `resolveStyleCascade` (WT-2); `StyleProperties`/`StyleNodeTypeSchema`/`STYLE_NODE_TYPES` (WT-1); `pg` transaction per `specs.ts:182` pattern; Vitest.

**Known limitation (filed, NOT in scope):** theme fonts (`asciiTheme`) are not resolved by WT-2 — a theme-font document derives without `rFonts.ascii` until **#149** lands. Do not implement #149 here.

**Out of scope:** per-paragraph direct-formatting overrides (Layer 2, WT-4/5); clean-up classifiers (WT-7); generator application (WT-6); `.dotx`; multi-document pooling; the #31 CRUD endpoints (the import uses the query layer directly).

**Prerequisites:** worktree `worktree-feat+template-import-docx` (based on main `b46ee37`, has WT-1+WT-2). Integration DB: `DATABASE_URL='postgres://specr:specr@localhost:5434/specr_wt1' NODE_ENV=test` inline (DB already migrated through 014; if unsure run `pnpm migrate`). Unit: `pnpm test <file>`; integration: `pnpm test:integration <file>`; `pnpm lint`.

**File structure:**
- Modify: `src/parser/docx/index.ts` (extract `buildClassification` internal helper; add `analyzeDocxStyles`)
- Create: `src/parser/docx/derive-template.ts` + `derive-template.test.ts` (pure §5 consensus)
- Create: `src/parser/docx/analyze.integration.test.ts` (real-fixture, DB-free)
- Modify: `src/parser/index.ts` (re-export the new public functions/types)
- Modify: `src/db/queries/templates.ts` (+ `createTemplateWithRules` transactional) and `src/db/index.ts` barrel
- Create: `src/api/templates.ts` + integration test; Modify: `src/api/router.ts`
- Modify: `openapi.yaml`, `README.md` (docs; LOC-exempt)

---

## Task 1: Parser seam — `analyzeDocxStyles(buffer)`

**Files:** Modify `src/parser/docx/index.ts`; Create `src/parser/docx/analyze.integration.test.ts`.

- [ ] **Step 1 — failing test** (`src/parser/docx/analyze.integration.test.ts`; DB-free, runs under the integration project because it reads a fixture file):

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeDocxStyles } from './index.js';

const FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');

describe.skipIf(!existsSync(FIXTURE))('analyzeDocxStyles — real DOCX fixture', () => {
  it('returns classified paragraphs and effective styles from one buffer', async () => {
    const { classified, effectiveStyles } = await analyzeDocxStyles(readFileSync(FIXTURE));
    expect(classified.length).toBeGreaterThan(0);
    expect(effectiveStyles.size).toBeGreaterThan(0);
    // at least one paragraph classified to a styleable NodeType
    const styleable = classified.filter((c) =>
      ['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5'].includes(c.nodeType)
    );
    expect(styleable.length).toBeGreaterThan(0);
  });

  it('throws ParserError on a non-DOCX buffer', async () => {
    await expect(analyzeDocxStyles(Buffer.from('not a zip'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2 — run, expect FAIL:** `pnpm test:integration src/parser/docx/analyze.integration.test.ts` → `analyzeDocxStyles` not exported.

- [ ] **Step 3 — implement.** In `src/parser/docx/index.ts`:
  1. Extract the classification prefix of `runPipeline` (numbering → styles → articleIlvl → parseDocument → classifyParagraphs) into an internal helper so it is not duplicated:

```typescript
interface Classification {
  readonly classified: readonly ClassifiedParagraph[];
  readonly styleMap: StyleMap;
}

function buildClassification(entries: {
  numberingXml: string | null;
  stylesXml: string;
  documentXml: string;
}): Classification {
  const numberingMap = entries.numberingXml
    ? buildNumberingMap(entries.numberingXml)
    : emptyNumberingMap();
  const styleMap = buildStyleMap(entries.stylesXml);
  const articleIlvl = detectArticleIlvl(styleMap, numberingMap);
  const resolvedNumberingMap = withArticleIlvl(numberingMap, articleIlvl);
  const paragraphs = parseDocument(entries.documentXml, resolvedNumberingMap);
  if (paragraphs.length === 0) throw new ParserError('document contains no paragraphs');
  return { classified: classifyParagraphs(paragraphs, resolvedNumberingMap, styleMap), styleMap };
}
```

  Rewire `runPipeline` to call `buildClassification` (its tree-building tail is unchanged — `detectSource(styleMap)`, core metadata, `buildTree`, audit). Behavior must be identical: the full unit suite stays green.

  2. Add the new public seam (imports: `resolveStyleCascade` from `./resolver.js`, `ClassifiedParagraph` type from `./types.js`, `StyleProperties` from `../../ast/types.js`):

```typescript
export interface DocxStyleAnalysis {
  readonly classified: readonly ClassifiedParagraph[];
  readonly effectiveStyles: ReadonlyMap<string, StyleProperties>;
}

/**
 * Style-analysis seam for template import (WT-3): classify the document's
 * paragraphs AND resolve every paragraph style's effective StyleProperties.
 * The buffer is read once and discarded — nothing raw is persisted (ADR-021).
 */
export async function analyzeDocxStyles(buffer: Buffer): Promise<DocxStyleAnalysis> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParserError('failed to read DOCX archive', { cause: err });
  }
  const { numberingXml, stylesXml, documentXml } = await extractEntries(zip);
  if (!stylesXml) throw new ParserError('DOCX missing word/styles.xml');
  if (!documentXml) throw new ParserError('DOCX missing word/document.xml');
  const { classified } = buildClassification({ numberingXml, stylesXml, documentXml });
  return { classified, effectiveStyles: resolveStyleCascade(stylesXml, numberingXml) };
}
```

  Also export the `ClassifiedParagraph` type from `./types.js` via this index if not already (`export type { ClassifiedParagraph } from './types.js';`).

- [ ] **Step 4 — verify:** integration file passes; `pnpm test` (full unit, no regressions from the `runPipeline` refactor); `pnpm lint`.
- [ ] **Step 5 — commit:** `feat(parser): analyzeDocxStyles seam — classification + effective styles from one buffer`

---

## Task 2: Pure consensus derivation — `derive-template.ts` (§5)

**Files:** Create `src/parser/docx/derive-template.ts`, `src/parser/docx/derive-template.test.ts`.

### Shapes (exported)

```typescript
import type { ClassifiedParagraph } from './types.js';
import type { StyleNodeType, StyleProperties } from '../../ast/types.js';
import { STYLE_NODE_TYPES } from '../../ast/types.js';
import { StylePropertiesSchema } from '../../ast/index.js';

export interface DerivedRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}

export interface PropertyDecision {
  readonly path: string; // dotted leaf path, e.g. 'rPr.sz'
  readonly value: unknown; // chosen JSON value
  readonly source: 'consensus' | 'intent' | 'median' | 'single';
  readonly confidence: number; // winner share of styled paragraphs, 0..1
  readonly disagreesWithIntent: boolean;
  readonly rejected: readonly { readonly value: unknown; readonly count: number }[];
}

export interface NodeTypeReport {
  readonly nodeType: StyleNodeType;
  readonly paragraphCount: number; // styleable paragraphs of this NodeType (non-vanish)
  readonly styledCount: number; // of those, how many carried a known styleId
  readonly modalStyleId: string | null; // the dominant named style (the "intent" source)
  readonly decisions: readonly PropertyDecision[];
}

export interface DerivationReport {
  readonly nodeTypes: readonly NodeTypeReport[];
  readonly skippedNodeTypes: readonly StyleNodeType[]; // no paragraphs in the document
  readonly vanishSkipped: number; // hidden editorial paragraphs excluded from voting
}

export interface DerivedTemplate {
  readonly rules: readonly DerivedRule[];
  readonly report: DerivationReport;
}

export function deriveTemplate(
  classified: readonly ClassifiedParagraph[],
  effectiveStyles: ReadonlyMap<string, StyleProperties>
): DerivedTemplate;
```

### Algorithm (program spec §5 — implement exactly)

1. **Population:** drop `isVanish` paragraphs (count → `vanishSkipped`); keep paragraphs whose `nodeType` is in `STYLE_NODE_TYPES`; group by NodeType. NodeTypes with no paragraphs → `skippedNodeTypes`, no rule emitted.
2. **Per group:** each paragraph's vote source is its style's **effective** `StyleProperties` (`effectiveStyles.get(paragraph.styleId)`); paragraphs with no/unknown styleId are counted (`paragraphCount`) but cast no votes (`styledCount` excludes them). `modalStyleId` = most frequent styleId (deterministic tie-break: first encountered in document order).
3. **Flatten** each voter's effective props into dotted **leaf paths** (`flattenLeaves`): plain objects recurse; everything else (numbers, strings, booleans, arrays, null) is a leaf. The path universe per group = union of all voters' paths.
4. **Vote per path:** every styled paragraph votes its value at that path — **absent counts as a vote for "absent"** (so a property present in only a minority does not sneak into the template). Values compared via `JSON.stringify`.
5. **Decide per path** (skip paths where "absent" wins — property simply omitted, no decision recorded):
   - `styledCount === 1` → that voter's value, `source: 'single'`, confidence 1.
   - winner share > 0.5 → winner, `source: 'consensus'`.
   - else if the modal style has a value at this path → that value, `source: 'intent'` (**consistency wins, else intent**).
   - else if all defined votes are numbers → median (lower-middle for even counts), `source: 'median'`.
   - else → plain mode with deterministic first-seen tie-break, `source: 'consensus'`, low confidence (the share).
   - `confidence` = chosen value's share of `styledCount`; `rejected` = all non-chosen defined values with counts (these ARE the §5 outliers); `disagreesWithIntent` = chosen ≠ modal style's value at the path (when the modal style defines one).
6. **Assemble:** unflatten chosen paths → `StyleProperties`; validate with `StylePropertiesSchema.parse` (the blob stays pure — canonical values only; all provenance lives in the report). Emit rules in `STYLE_NODE_TYPES` order.

### Steps

- [ ] **Step 1 — failing tests** (`derive-template.test.ts`). Build inputs directly (no XML needed — construct `ClassifiedParagraph[]` and an `effectiveStyles` Map in code; a `para(nodeType, styleId?, isVanish?)` helper keeps fixtures terse — `DocxParagraph` needs only `{ text, styleId?, isVanish }` plus `resolvedIlvl/signalUsed/conflicts` filler). Cases (write all; each asserts concrete values):
  1. **Unanimous consensus:** 3×`pr1` paragraphs, all style `PR1` (`{rPr:{sz:20,b:true},pPr:{ind:{left:720}}}`) → rule `pr1` equals that object; every decision `source:'consensus'`, confidence 1, `rejected: []`.
  2. **Dominant wins + outlier rejected:** 5×`pr1` — 4 style `PR1` (`sz:20`), 1 style `PR1Big` (`sz:24`) → `rPr.sz = 20`, confidence 0.8, rejected `[{value:24,count:1}]`, `disagreesWithIntent:false` (modal = PR1).
  3. **Split → intent wins:** 4×`pr1` — 2 style `A` (`sz:20`), 2 style `B` (`sz:24`), document order A first (modal=A) → `rPr.sz = 20`, `source:'intent'`, `disagreesWithIntent:false`; the B value in `rejected`.
  4. **Absent wins → omitted:** 5×`pr1` — 1 voter has `rPr.i:true`, 4 don't → no `rPr.i` in the rule and no decision recorded for that path.
  5. **n=1 → single:** 1×`part` paragraph styled `PRT` → rule equals PRT's effective props, decisions `source:'single'`.
  6. **Vanish + unstyled excluded:** vanish paragraphs increment `vanishSkipped` and don't vote; a styleable paragraph with `styleId: undefined` increments `paragraphCount` but not `styledCount`.
  7. **Skipped NodeTypes:** document with only `pr1` paragraphs → `skippedNodeTypes` contains the other six; only one rule emitted.
  8. **Schema validity:** every emitted rule's `properties` passes `StylePropertiesSchema.parse` (including when a voter carries an unknown OOXML key — the unknown key flows through to the rule when it wins the vote).
- [ ] **Step 2 — run, expect FAIL** (`pnpm test src/parser/docx/derive-template.test.ts`).
- [ ] **Step 3 — implement** per the algorithm above. Pure module: no I/O, no imports beyond `types.js`/`ast`. Immutable style (reduce/spread; `Map`/array accumulation in loops is fine per house pattern). Keep functions ≤50 lines / complexity ≤10 — expected decomposition: `flattenLeaves`, `unflattenLeaves`, `mode`, `median`, `decidePath`, `deriveForNodeType`, `deriveTemplate`. File ≤400 lines.
- [ ] **Step 4 — run PASS; `pnpm lint`.**
- [ ] **Step 5 — commit:** `feat(parser): consensus template derivation — mode/median, consistency-wins-else-intent (§5)`

---

## Task 3: Public exports through `parser/index.ts`

**Files:** Modify `src/parser/docx/index.ts` (if needed), `src/parser/index.ts`; extend `derive-template.test.ts` or a tiny import test.

- [ ] **Step 1 — failing check:** add to `derive-template.test.ts` an import-surface assertion: `import { analyzeDocxStyles, deriveTemplate } from '../index.js';` (the parser module barrel) and `expect(typeof deriveTemplate).toBe('function')`. Run → fails (not exported).
- [ ] **Step 2 — implement:** `src/parser/docx/index.ts`: `export { deriveTemplate } from './derive-template.js';` + `export type { DerivedTemplate, DerivedRule, DerivationReport, NodeTypeReport, PropertyDecision } from './derive-template.js';`. `src/parser/index.ts`: re-export `analyzeDocxStyles`, `deriveTemplate`, and those types from `./docx/index.js` (match the existing re-export style in that file — read it first).
- [ ] **Step 3 — run PASS; `pnpm lint`; commit:** `feat(parser): export analyzeDocxStyles + deriveTemplate through module barrels`

---

## Task 4: Transactional persistence — `createTemplateWithRules`

**Files:** Modify `src/db/queries/templates.ts`, `src/db/index.ts`; extend `src/db/queries/templates.integration.test.ts`.

- [ ] **Step 1 — failing integration tests** (append to the existing templates integration file; remember `trackName` cleanup):
  1. Creates a template with 2 rules atomically; `getTemplate(id)` returns both rules with correct `properties`.
  2. Duplicate name → rejects (unique violation propagates; assert `rejects.toThrow()`), and **no orphan rules** exist afterwards.
  3. A rule with an invalid `node_type` (cast through a test-only `as unknown as` — allowed in tests) → entire insert rolls back: template name absent from `style_templates` (all-or-nothing).
- [ ] **Step 2 — run, expect FAIL** (function missing). DB env prefix required.
- [ ] **Step 3 — implement** in `templates.ts`, following the `persistParsedSpec` transaction pattern (`pool.connect()`, BEGIN/COMMIT/ROLLBACK/release, `DatabaseError` with `{ cause }`):

```typescript
export async function createTemplateWithRules(
  name: string,
  owner: string | null,
  rules: readonly StyleRule[]
): Promise<Template> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<TemplateRow>(
      `INSERT INTO style_templates (name, owner) VALUES ($1, $2)
       RETURNING id, name, owner, created_at`,
      [name, owner]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createTemplateWithRules: no row returned');
    for (const rule of rules) {
      await client.query(
        `INSERT INTO style_rules (template_id, node_type, properties)
         VALUES ($1, $2, $3::jsonb)`,
        [row.id, rule.nodeType, JSON.stringify(StylePropertiesSchema.parse(rule.properties))]
      );
    }
    await client.query('COMMIT');
    return { ...mapMetaRow(row), rules };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection-level failure — original error wins */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create template with rules', { cause: err });
  } finally {
    client.release();
  }
}
```

  (Plain INSERT, not upsert — the template row is brand-new so `(template_id, node_type)` cannot conflict. Import `StylePropertiesSchema` from `../../ast/index.js` if not present.) Barrel: add `createTemplateWithRules` to `src/db/index.ts`'s templates export block.
- [ ] **Step 4 — run PASS (integration); `pnpm lint`.**
- [ ] **Step 5 — commit:** `feat(db): createTemplateWithRules — atomic template + rules insert`

---

## Task 5: `POST /templates/import` endpoint

**Files:** Create `src/api/templates.ts`, `src/api/templates.integration.test.ts`; Modify `src/api/router.ts`.

### Contract

| | |
|---|---|
| Request | `multipart/form-data`: `file` (.docx only) + `name` (required) + `owner` (optional) |
| 201 | `{ success: true, data: { template: Template, report: DerivationReport } }` |
| 400 | missing file / not .docx / MIME mismatch / unsafe archive / missing-empty `name` |
| 409 | template name already exists (PG 23505) |
| 422 | document contains no styleable paragraphs (every NodeType skipped) — nothing to derive |

The raw buffer is used for analysis only and goes out of scope at the end of the request — never persisted (state this in a comment).

- [ ] **Step 1 — failing integration tests** (`src/api/templates.integration.test.ts`). Spin up Express the way `specs.integration.test.ts` does (read it first; mount `router`). Build a real DOCX **in-memory with JSZip** once in the test file — a minimal but valid doc the inference engine classifies (reuse the proven shape from existing tests: a `styles.xml` with `PRT`/`PR1` styles carrying `rPr` visual props + `numPr`, a `numbering.xml` with a 3-level spec-shaped abstractNum, and a `document.xml` whose paragraphs use those styles with PART-heading text, e.g. `PART 1 - GENERAL` + a few `A.` body paragraphs). Send via `supertest`-style requests (match the project's existing API-test mechanics) with `.attach('file', buffer, { filename: 'master.docx', contentType: DOCX_MIME })` + `.field('name', ...)`. Cases:
  1. Happy path → 201; `data.template.rules` non-empty; rules' nodeTypes ⊆ the 7; `data.report.nodeTypes` aligned; template actually in DB (`getTemplateByName`).
  2. Derived values correct: the `part` rule's `properties.rPr` reflects the styles.xml fixture values (assert 2–3 concrete properties — this is the end-to-end fidelity assertion).
  3. Duplicate name → 409 (second upload, same `name`).
  4. Missing `name` → 400. Missing file → 400. A `.txt` upload → 400.
  5. A DOCX whose paragraphs classify only as continuation (no styleable nodes) → 422. (Plain unnumbered/unstyled paragraphs with non-matching text.)
- [ ] **Step 2 — run, expect FAIL.** (DB env prefix.)
- [ ] **Step 3 — implement** `src/api/templates.ts`:

```typescript
import path from 'node:path';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { analyzeDocxStyles, deriveTemplate, assertDocxSafe } from '../parser/index.js';
import { createTemplateWithRules } from '../db/index.js';
import { logger } from '../lib/logger.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ImportBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  owner: z.string().check(z.minLength(1)).exactOptional(),
});

function isUniqueViolation(err: unknown): boolean {
  // pg DatabaseError carries the PG code on .cause (DatabaseError wraps it)
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  return cause?.code === '23505';
}

export async function importTemplateHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }
  if (
    path.extname(req.file.originalname).toLowerCase() !== '.docx' ||
    req.file.mimetype !== DOCX_MIME
  ) {
    res.status(400).json({ success: false, error: 'template import requires a .docx upload' });
    return;
  }
  const body = ImportBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }
  try {
    await assertDocxSafe(req.file.buffer);
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'invalid file' });
    return;
  }
  try {
    // Analysis only — the buffer is never persisted; the derived JSONB definition
    // is the only artifact (ADR-021).
    const { classified, effectiveStyles } = await analyzeDocxStyles(req.file.buffer);
    const { rules, report } = deriveTemplate(classified, effectiveStyles);
    if (rules.length === 0) {
      res.status(422).json({ success: false, error: 'document contains no styleable paragraphs to derive a template from' });
      return;
    }
    const template = await createTemplateWithRules(body.data.name, body.data.owner ?? null, rules);
    res.status(201).json({ success: true, data: { template, report } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ success: false, error: 'template name already exists' });
      return;
    }
    logger.error({ err }, 'template import failed');
    // ParserError (malformed/unparseable document) → 422 per CLAUDE.md error mapping;
    // anything else (e.g. DatabaseError) → 500 without leaking internals.
    if (err instanceof ParserError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    res.status(500).json({ success: false, error: 'internal error' });
  }
}
```

(Import `ParserError` from `'../parser/index.js'` — confirm it is re-exported there; if not, add the re-export alongside the Task 3 barrel work.)

  > Adjust `isUniqueViolation` to however the PG code actually surfaces (check what `createTemplateWithRules` wraps — the pg error is the `cause` of the `DatabaseError`; if `api/projects.ts` already has a `getPgCode` helper, reuse that instead of hand-rolling). A `ParserError` from a corrupt-but-zip-valid docx lands in the final catch → 422 (parser errors map to 422 per CLAUDE.md).

  Router (`src/api/router.ts`): reuse the existing multer instance and rate limiter:

```typescript
import { importTemplateHandler } from './templates.js';
// ...
router.post('/templates/import', parseRateLimit, upload.single('file'), importTemplateHandler);
```

- [ ] **Step 4 — run PASS (integration + full unit + `pnpm lint`).**
- [ ] **Step 5 — commit:** `feat(api): POST /templates/import — derive firm style template from a source-of-truth DOCX`

---

## Task 6: Docs + full sweep

**Files:** Modify `openapi.yaml`, `README.md`.

- [ ] **Step 1:** `openapi.yaml`: add the `/templates/import` path (multipart request schema, 201/400/409/422 responses referencing a `Template` + `DerivationReport` component — follow the file's existing component style). `README.md`: add the endpoint row to the API table + a short "Template import (style fidelity)" paragraph noting consensus derivation, the derivation report, no-raw-DOCX-storage, and the #149 theme-font caveat.
- [ ] **Step 2 — full sweep:** `pnpm lint && pnpm test` and (with DB env) `pnpm test:integration`. All green.
- [ ] **Step 3 — commit:** `docs: document POST /templates/import + derivation report`

---

## Done criteria (WT-3)

- [ ] Upload a real source-of-truth DOCX → 201 with a persisted template whose per-NodeType `properties` match the document's effective styles, plus a derivation report (confidence, intent flags, rejected outliers).
- [ ] §5 semantics proven by unit tests: dominant-consensus, split→intent, absent-wins→omit, n=1→single, outliers recorded, vanish/unstyled excluded.
- [ ] Atomic persistence (no orphan templates/rules on failure); duplicate name → 409; styleless document → 422.
- [ ] Raw DOCX bytes never stored — analysis-only (comment + no storage write anywhere).
- [ ] `pnpm lint`, full unit, full integration green; new files ≤400 lines, functions ≤50/complexity ≤10.
- [ ] LOC: if the branch exceeds the 500-LOC sub-MVP guidance, split PRs at the Task 3/Task 4 boundary (parser PR, then api+db PR).

**Next after WT-3:** #149 (theme fonts) before broad real-world imports; then WT-6 (generator applies `properties`) or WT-4 (paragraph overrides).
