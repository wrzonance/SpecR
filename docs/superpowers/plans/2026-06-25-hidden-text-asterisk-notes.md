# Hidden-text filtering + asterisk note-delimiters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclude hidden/invisible OOXML content (text + tables) from the 5-signal CSI inference while retaining it losslessly, and detect the asterisk-row note-delimiter convention across DOCX and text/PDF.

**Architecture:** Robust paragraph vanish-resolution (run/paragraph-mark/style) feeds a 5-signal pass that skips hidden + note paragraphs; a shared pure `note-delimiters` lib segments asterisk-bracketed note blocks (rule rows dropped, enclosed prose → `note`); a separate table scan classifies hidden tables into a flat `SpecTree.hiddenTables` sidecar and warns on visible tables. Onboarding sees the new signals via `source_facts`.

**Tech Stack:** TypeScript/Node 22 (ESM), Express, Zod v4, fast-xml-parser, JSZip, vitest, pnpm. Design spec: `docs/superpowers/specs/2026-06-25-hidden-text-asterisk-notes-design.md`.

## Global Constraints

- **ESM project** (`"type": "module"`): relative imports use `.js` extensions; `verbatimModuleSyntax` → `import type` for type-only imports.
- **TS strict +** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`. No `any`, no `as unknown as`, no `!` non-null assertion outside tests.
- **ESLint enforced:** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400 (file cap), `no-console` error. Test files relax line/console caps.
- **Module boundaries:** import only a sibling's `index.ts` barrel; shared pure helpers live in `src/lib/`.
- **Typed errors:** boundary failures throw `ParserError` with `cause` chained. Pure helpers are total (no throws).
- **`openapi.yaml` is the authoritative contract** — any response-shape change updates it in the **same** PR (CI contract gate enforces it).
- **OOXML ambiguity rule:** document genuinely ambiguous cases in a test marked `// KNOWN AMBIGUITY: <desc>`.
- **Lint/typecheck gate:** `pnpm lint` (eslint + `tsc --noEmit` + prettier) and `pnpm test` must pass before each commit.
- **Branch rules (MANDATORY, every phase):** never commit to `main`. Before touching files: `git branch --show-current`; if on `main`, create the phase branch first (`git fetch origin && git checkout -b <branch> origin/main`). Read this repo's `CLAUDE.md`. Commit format `type(scope): description`; end AI commits with `Co-Authored-By: Codex <noreply@openai.com>` (the implementer attributes itself).
- **Integration-test caveat:** Codex's sandbox cannot run DB/file integration tests (EPERM). Run only `pnpm test` (unit project) in-sandbox; the orchestrator runs `pnpm test:integration` and the gated DOCX-artifact test outside the sandbox.

---

## File Structure

| File | Responsibility | Phase |
|------|----------------|-------|
| `src/parser/docx/styles.ts` | add `resolveVanishChain`; build `vanishStyleIds` + `vanishCharStyleIds` | 1 |
| `src/parser/docx/types.ts` | `StyleMap` gains the two vanish sets; `ClassifiedParagraph` gains `suppressed?` | 1, 2 |
| `src/parser/docx/document.ts` | `resolveParagraphVanish` (run/mark/style); thread `StyleMap` into `parseDocument` | 1 |
| `src/parser/docx/inference.ts` | skip hidden in 5-signal pass; asterisk pre-pass; audit ignores hidden; drop rule rows | 1, 2 |
| `src/lib/note-delimiters.ts` | NEW — pure `isRuleRow` + `classifyNoteRoles` (shared) | 2 |
| `src/parser/docx/source-facts.ts` | populate `SourceFacts.vanish` + `banner` | 4 |
| `src/parser/docx/tables.ts` | NEW — `extractTables` → hidden-table grid + visible count | 3 |
| `src/parser/docx/index.ts` | thread vanish sets; attach `hiddenTables`; emit `table-content-skipped` | 1, 3 |
| `src/parser/text/index.ts` | note-role pre-pass over lines (drop rule lines, emit note nodes) | 4 |
| `src/ast/types.ts` | `RetainedTable`; `SpecTree.hiddenTables?`; `'table-content-skipped'` warning | 3 |
| `src/ast/schemas.ts` | `RetainedTableSchema`; `SpecTreeSchema.hiddenTables`; warning enum | 3 |
| `openapi.yaml` | `RetainedTable` schema; `SpecTree.hiddenTables`; warning enum value | 3 |
| `docs/adr/038-hidden-content-retention.md` | NEW — ADR | 1 |

---

# Phase 1 — Robust vanish + exclude-from-inference (PR 1)

**Branch:** `feat/hidden-vanish-inference` · **Issue:** "Exclude hidden OOXML text from 5-signal inference (retain, don't discard)"

Goal: hidden paragraphs are robustly detected and never participate in structural inference; the demo root becomes `part, part, part` (hidden notes no longer counted as root junk). Hidden text stays in-tree as suppressed `note` nodes (round-trip preserved).

### Task 1.1: Resolve style-level vanish through the basedOn chain

**Files:**
- Modify: `src/parser/docx/styles.ts`
- Modify: `src/parser/docx/types.ts` (`StyleMap`)
- Test: `src/parser/docx/styles.test.ts`

**Interfaces:**
- Produces: `StyleMap.vanishStyleIds: ReadonlySet<string>` (paragraph styleIds resolving to vanish via basedOn chain), `StyleMap.vanishCharStyleIds: ReadonlySet<string>` (character styleIds whose own rPr has `w:vanish`).

- [ ] **Step 1: Write the failing test** — append to `src/parser/docx/styles.test.ts`:

```typescript
describe('vanish resolution', () => {
  it('marks a paragraph style vanish when its own rPr has w:vanish', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style>
    </w:styles>`;
    expect(buildStyleMap(xml).vanishStyleIds.has('Hidden')).toBe(true);
  });

  it('inherits vanish through the basedOn chain', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="Base" w:type="paragraph"><w:name w:val="Base"/><w:rPr><w:vanish/></w:rPr></w:style>
      <w:style w:styleId="Child" w:type="paragraph"><w:name w:val="Child"/><w:basedOn w:val="Base"/></w:style>
    </w:styles>`;
    expect(buildStyleMap(xml).vanishStyleIds.has('Child')).toBe(true);
  });

  it('captures character-style vanish into vanishCharStyleIds', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="HideChar" w:type="character"><w:name w:val="HideChar"/><w:rPr><w:vanish/></w:rPr></w:style>
    </w:styles>`;
    const m = buildStyleMap(xml);
    expect(m.vanishCharStyleIds.has('HideChar')).toBe(true);
    expect(m.vanishStyleIds.has('HideChar')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test -- styles.test.ts`
Expected: FAIL — `vanishStyleIds`/`vanishCharStyleIds` undefined.

- [ ] **Step 3: Implement** — in `src/parser/docx/styles.ts`:

Add a basedOn-walking resolver (mirrors `resolveNumPrChain`):

```typescript
function resolveVanishChain(
  styleId: string,
  styles: ReadonlyMap<string, StyleInfo>,
  depth: number
): boolean {
  if (depth > MAX_BASED_ON_DEPTH) return false;
  const style = styles.get(styleId);
  if (!style) return false;
  if (style.isVanish) return true;
  return style.basedOn ? resolveVanishChain(style.basedOn, styles, depth + 1) : false;
}
```

Add a character-style vanish scan. `parseStyleInfo` currently returns `null` for non-paragraph styles; add a tiny separate predicate used only in `buildStyleMap`:

```typescript
function characterStyleVanishIds(root: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const raw of toArray(root['w:style'] as readonly unknown[] | undefined)) {
    const rec = asRecord(raw);
    if (!rec || extractAttrStr(rec, '@_w:type') !== 'character') continue;
    const styleId = extractAttrStr(rec, '@_w:styleId');
    const rPr = asRecord(rec['w:rPr']);
    if (styleId && rPr !== undefined && 'w:vanish' in rPr) ids.add(styleId);
  }
  return ids;
}
```

In `buildStyleMap`, after building `resolvedNumPr`, compute the sets and add to the returned object:

```typescript
  const vanishStyleIds = new Set<string>();
  for (const styleId of styles.keys()) {
    if (resolveVanishChain(styleId, styles, 0)) vanishStyleIds.add(styleId);
  }
  const vanishCharStyleIds = characterStyleVanishIds(root);

  return { styles, resolvedNumPr, vanishStyleIds, vanishCharStyleIds };
```

Update the early-return empty map (`if (!root)`) to `{ styles: new Map(), resolvedNumPr: new Map(), vanishStyleIds: new Set(), vanishCharStyleIds: new Set() }`.

In `src/parser/docx/types.ts`, extend `StyleMap`:

```typescript
export interface StyleMap {
  readonly styles: ReadonlyMap<string, StyleInfo>;
  readonly resolvedNumPr: ReadonlyMap<string, StyleNumPr>;
  readonly vanishStyleIds: ReadonlySet<string>;
  readonly vanishCharStyleIds: ReadonlySet<string>;
}
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- styles.test.ts` → PASS. Then `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/styles.ts src/parser/docx/types.ts src/parser/docx/styles.test.ts
git commit -m "feat(parser): resolve style + char-style vanish into StyleMap"
```

### Task 1.2: Robust per-paragraph vanish resolution

**Files:**
- Modify: `src/parser/docx/document.ts`
- Test: `src/parser/docx/document.test.ts`

**Interfaces:**
- Consumes: `StyleMap.vanishStyleIds`, `StyleMap.vanishCharStyleIds`.
- Produces: `parseDocument(xml, numberingMap, styleMap, commentsById)` — note the **new `styleMap` parameter** (3rd position, before `commentsById`). `DocxParagraph.isVanish` now reflects run/mark/style-level hidden state.

- [ ] **Step 1: Write the failing test** — append to `src/parser/docx/document.test.ts` (build a `StyleMap` via `buildStyleMap`, call `parseDocument`):

```typescript
import { buildStyleMap } from './styles.js';
// ...
it('detects vanish from all-runs-hidden even without paragraph-mark vanish', () => {
  const styles = buildStyleMap(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r></w:p>
  </w:body></w:document>`;
  const paras = parseDocument(xml, emptyNumberingMap(), styles);
  expect(paras[0]?.isVanish).toBe(true);
});

it('detects vanish inherited from the paragraph style', () => {
  const styles = buildStyleMap(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`);
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Hidden"/></w:pPr><w:r><w:t>via style</w:t></w:r></w:p>
  </w:body></w:document>`;
  expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(true);
});

it('does NOT mark vanish when only some runs are hidden', () => {
  const styles = buildStyleMap(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
  // KNOWN AMBIGUITY: a paragraph with a mix of hidden and visible runs is treated
  // as VISIBLE — the visible text is real content; only fully-hidden paragraphs drop out.
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r><w:r><w:t>visible</w:t></w:r></w:p>
  </w:body></w:document>`;
  expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(false);
});
```

(Import `emptyNumberingMap` from `./numbering.js` if not already imported in the test.)

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test -- document.test.ts`
Expected: FAIL — `parseDocument` arity/signature mismatch and run/style vanish not detected.

- [ ] **Step 3: Implement** — in `src/parser/docx/document.ts`:

Replace `resolveIsVanish` with run/mark/style-aware resolution. Add helpers:

```typescript
function runIsVanish(
  run: Record<string, unknown>,
  vanishCharStyleIds: ReadonlySet<string>
): boolean {
  const rPr = run['w:rPr'];
  if (typeof rPr === 'object' && rPr !== null) {
    const rec = rPr as Record<string, unknown>;
    if ('w:vanish' in rec) return true;
    const rStyle = getAttrVal(rec['w:rStyle']);
    if (rStyle && vanishCharStyleIds.has(rStyle)) return true;
  }
  return false;
}

function allTextRunsVanish(
  raw: Record<string, unknown>,
  vanishCharStyleIds: ReadonlySet<string>
): boolean {
  const directRuns = toArray<Record<string, unknown>>(
    raw['w:r'] as readonly Record<string, unknown>[] | undefined
  );
  const linkRuns = toArray<Record<string, unknown>>(
    raw['w:hyperlink'] as readonly Record<string, unknown>[] | undefined
  ).flatMap((h) =>
    toArray<Record<string, unknown>>(h['w:r'] as readonly Record<string, unknown>[] | undefined)
  );
  const textRuns = [...directRuns, ...linkRuns].filter((r) => extractRunText(r).length > 0);
  if (textRuns.length === 0) return false;
  return textRuns.every((r) => runIsVanish(r, vanishCharStyleIds));
}

function paragraphMarkVanish(pPr: Record<string, unknown> | undefined): boolean {
  const raw = pPr?.['w:rPr'];
  return typeof raw === 'object' && raw !== null && 'w:vanish' in (raw as Record<string, unknown>);
}

function resolveParagraphVanish(
  raw: Record<string, unknown>,
  pPr: Record<string, unknown> | undefined,
  styleId: string | undefined,
  styleMap: StyleMap
): boolean {
  if (paragraphMarkVanish(pPr)) return true;
  if (styleId && styleMap.vanishStyleIds.has(styleId)) return true;
  return allTextRunsVanish(raw, styleMap.vanishCharStyleIds);
}
```

Thread `styleMap` through `parseParagraph` and `parseDocument`. Update the signature:

```typescript
export function parseDocument(
  xml: string,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  commentsById: ReadonlyMap<string, DocxComment> = new Map()
): DocxParagraph[] {
```

In `parseParagraph`, replace `isVanish: resolveIsVanish(pPr)` with `isVanish: resolveParagraphVanish(raw, pPr, styleId, styleMap)` and pass `styleMap` down from `parseDocument`'s `.map(...)`. Add `import type { ... StyleMap } from './types.js';` and `import { getAttrVal } from './xml-utils.js';` (already imported).

In `src/parser/docx/index.ts` `buildClassification`, update the call:

```typescript
const paragraphs = parseDocument(entries.documentXml, resolvedNumberingMap, styleMap, commentsById);
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- document.test.ts` → PASS. `pnpm lint`. Run `pnpm test` (full unit project) to catch any other `parseDocument` callers.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/document.ts src/parser/docx/index.ts src/parser/docx/document.test.ts
git commit -m "feat(parser): robust paragraph vanish resolution (run/mark/style)"
```

### Task 1.3: Skip hidden paragraphs in the 5-signal pass + fix audit

**Files:**
- Modify: `src/parser/docx/inference.ts`
- Test: `src/parser/docx/inference.test.ts`, `src/parser/docx/index.test.ts`

**Interfaces:**
- Consumes: `DocxParagraph.isVanish`.
- Produces: hidden paragraphs classify as `note` (never structural; never set `prevNonContIlvl`). `auditTreeStructure` ignores nodes with `meta.vanish === true` when counting `root-continuation` junk and PART count.

- [ ] **Step 1: Write the failing test** — append to `src/parser/docx/index.test.ts`:

```typescript
it('hidden preamble does not pollute the hierarchy root', async () => {
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>SPECIFICATION PROCESSING FORM</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
  </w:body></w:document>`;
  const tree = await parseDocx(await makeDocx({ documentXml: doc, numberingXml: STRUCTURED_NUMBERING }));
  // The hidden form is retained as a vanish node but is NOT a root-continuation warning.
  expect((tree.warnings ?? []).some((w) => w.type === 'root-continuation')).toBe(false);
  expect(tree.parts.filter((n) => n.type === 'part')).toHaveLength(1);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test -- index.test.ts`
Expected: FAIL — hidden form currently emitted as a root `note` and counted as junk.

- [ ] **Step 3: Implement** — in `src/parser/docx/inference.ts`:

In `classifyOne`, treat hidden paragraphs as non-structural before running signals:

```typescript
function classifyOne(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  prevNonContIlvl: number
): ClassifiedParagraph {
  // Hidden + specifier-note paragraphs render as vanish notes — never structural.
  if (para.isVanish || isNoteParagraph(para, styleMap)) {
    return continuationResult(para, prevNonContIlvl, true);
  }
  // ... existing signal logic unchanged ...
```

In `auditTreeStructure`, ignore retained-hidden nodes:

```typescript
export function auditTreeStructure(roots: readonly SpecNode[]): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const visible = roots.filter((n) => n.meta.vanish !== true);
  const partCount = visible.filter((n) => n.type === 'part').length;
  const junkRoots = visible.filter((n) => n.type !== 'part');
  // ... rest unchanged, using partCount / junkRoots ...
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- index.test.ts inference.test.ts` → PASS. `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/inference.ts src/parser/docx/index.test.ts src/parser/docx/inference.test.ts
git commit -m "feat(parser): exclude hidden paragraphs from 5-signal inference + audit"
```

### Task 1.4: ADR-038

**Files:**
- Create: `docs/adr/038-hidden-content-retention.md`

- [ ] **Step 1: Write the ADR** (Status / Context / Decision / Consequences):

```markdown
# ADR-038: Hidden OOXML content is retained, not discarded, and excluded from inference

## Status
Accepted — 2026-06-25

## Context
Firm master specs carry hidden (`w:vanish`) document-control content — processing
forms, sign-off and revision-history tables — and bracket editor notes with rows of
asterisks. This hidden material polluted the 5-signal CSI inference (root junk) and
the asterisk rows rendered as literal walls of text. SpecR will eventually use this
hidden material to track master/project edits, so it must not be destroyed.

## Decision
1. Detect hidden paragraphs robustly (run-level, paragraph-mark, paragraph-style, and
   character-style vanish). A paragraph is hidden only when fully hidden (mixed
   visible/hidden runs count as visible — the visible text is real content).
2. Hidden paragraphs are excluded from structural inference but retained in-tree as
   suppressed `note` nodes, preserving UUID round-trip/merge anchors.
3. Hidden tables are parsed and retained as a flat `SpecTree.hiddenTables` grid
   (lossless cell text), out of the hierarchy. Visible tables are detected and warned
   (`table-content-skipped`), not modeled this sprint.
4. Asterisk rule rows (`*****…`) are a note-delimiter convention: the rows are stripped,
   the enclosed paragraphs become `note` nodes, detected by content (not style name).

## Consequences
- The CSI hierarchy is clean; hidden content is recoverable for the future
  change-management/document-control feature.
- A typed revision-history schema, visible-table modeling, DB persistence of retained
  tables, and learning the conventions into firm profiles are explicit follow-ups.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/038-hidden-content-retention.md
git commit -m "docs(adr): ADR-038 hidden-content retention + exclusion from inference"
```

**Phase 1 PR:** open as **draft**, link the issue (`Closes #N`), testing checkboxes per workflow. Move issue `In progress → In review`.

---

# Phase 2 — Shared asterisk note-delimiters + DOCX wiring (PR 2)

**Branch:** `feat/asterisk-note-delimiters` (from updated `origin/main` after PR 1 merges) · **Issue:** "Detect asterisk-row note-delimiter convention (DOCX)"

### Task 2.1: Pure `note-delimiters` lib

**Files:**
- Create: `src/lib/note-delimiters.ts`
- Test: `src/lib/note-delimiters.test.ts`

**Interfaces:**
- Produces:
  - `isRuleRow(text: string): boolean`
  - `interface NoteScanItem { readonly text: string; readonly isHeading: boolean }`
  - `type NoteRole = 'rule' | 'note' | 'none'`
  - `classifyNoteRoles(items: readonly NoteScanItem[]): NoteRole[]`

- [ ] **Step 1: Write the failing test** — `src/lib/note-delimiters.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isRuleRow, classifyNoteRoles } from './note-delimiters.js';

describe('isRuleRow', () => {
  it('matches a long pure-asterisk row', () => {
    expect(isRuleRow('***************')).toBe(true);
    expect(isRuleRow('   **********   ')).toBe(true);
  });
  it('rejects short runs and decorated text', () => {
    expect(isRuleRow('***')).toBe(false); // below threshold (emphasis)
    expect(isRuleRow('** NOTE **')).toBe(false);
    expect(isRuleRow('content')).toBe(false);
  });
});

describe('classifyNoteRoles', () => {
  it('strips paired rule rows and marks enclosed paragraphs as notes', () => {
    const items = [
      { text: 'PART 1 - GENERAL', isHeading: true },
      { text: '**********', isHeading: false },
      { text: 'Customize this section.', isHeading: false },
      { text: '**********', isHeading: false },
      { text: 'Real content.', isHeading: false },
    ];
    expect(classifyNoteRoles(items)).toEqual(['none', 'rule', 'note', 'rule', 'none']);
  });

  it('safety-breaks an unbalanced opener at the next heading', () => {
    // KNOWN AMBIGUITY: a lone (unpaired) rule row opens a note region that is
    // force-closed by the next structural heading, so it cannot swallow the section.
    const items = [
      { text: '**********', isHeading: false },
      { text: 'note line', isHeading: false },
      { text: 'PART 2 - PRODUCTS', isHeading: true },
      { text: 'product content', isHeading: false },
    ];
    expect(classifyNoteRoles(items)).toEqual(['rule', 'note', 'none', 'none']);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test -- note-delimiters.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/note-delimiters.ts`:

```typescript
// Asterisk note-delimiter convention (UFGS/SpecsIntact): firms bracket editor
// notes with rows of asterisks. Pure + total — shared by the DOCX and text parsers.
const RULE_ROW_MIN = 5;
const RULE_ROW_PATTERN = /^\*+$/;

/** A line/paragraph is a pure run of >= RULE_ROW_MIN asterisks (decoration, not content). */
export function isRuleRow(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= RULE_ROW_MIN && RULE_ROW_PATTERN.test(trimmed);
}

export interface NoteScanItem {
  readonly text: string;
  readonly isHeading: boolean;
}

export type NoteRole = 'rule' | 'note' | 'none';

/**
 * Segment an ordered item stream into note regions. A rule row toggles the region:
 * the first opens it, the next closes it; both rows are tagged 'rule' (callers strip
 * them). Items inside an open region are 'note'. A structural heading force-closes an
 * open region (safety break) so an unbalanced opener cannot swallow the section.
 */
export function classifyNoteRoles(items: readonly NoteScanItem[]): NoteRole[] {
  let inBlock = false;
  return items.map((item): NoteRole => {
    if (isRuleRow(item.text)) {
      inBlock = !inBlock;
      return 'rule';
    }
    if (item.isHeading) {
      inBlock = false;
      return 'none';
    }
    return inBlock ? 'note' : 'none';
  });
}
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- note-delimiters.test.ts` → PASS. `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/note-delimiters.ts src/lib/note-delimiters.test.ts
git commit -m "feat(lib): pure asterisk note-delimiter detection (isRuleRow, classifyNoteRoles)"
```

### Task 2.2: Wire note-delimiters into DOCX classification

**Files:**
- Modify: `src/parser/docx/inference.ts`
- Modify: `src/parser/docx/types.ts` (`ClassifiedParagraph.suppressed?`)
- Test: `src/parser/docx/inference.test.ts`, `src/parser/docx/index.test.ts`

**Interfaces:**
- Consumes: `classifyNoteRoles`, `isRuleRow` from `../../lib/note-delimiters.js`.
- Produces: `ClassifiedParagraph` gains `readonly suppressed?: boolean`; rule rows are `suppressed` (dropped by `buildTree`); enclosed paragraphs classify as `note` (vanish).

- [ ] **Step 1: Write the failing test** — append to `src/parser/docx/index.test.ts`:

```typescript
it('strips asterisk rule rows and turns enclosed prose into notes', async () => {
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:r><w:t>*********************************</w:t></w:r></w:p>
    <w:p><w:r><w:t>Edit this section to suit the project.</w:t></w:r></w:p>
    <w:p><w:r><w:t>*********************************</w:t></w:r></w:p>
  </w:body></w:document>`;
  const tree = await parseDocx(await makeDocx({ documentXml: doc, numberingXml: STRUCTURED_NUMBERING }));
  const collect = (n: SpecNode): SpecNode[] => [n, ...n.children.flatMap(collect)];
  const all = tree.parts.flatMap(collect);
  // no asterisk wall survives as a node:
  expect(all.some((n) => /^\*{5,}$/.test(n.text.trim()))).toBe(false);
  // the prose is a note:
  expect(all.some((n) => n.type === 'note' && n.text.includes('Edit this section'))).toBe(true);
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test -- index.test.ts` → FAIL (asterisk walls retained).

- [ ] **Step 3: Implement** — in `src/parser/docx/types.ts` add to `ClassifiedParagraph`:

```typescript
  readonly suppressed?: boolean;
```

In `src/parser/docx/inference.ts`:

Add imports: `import { classifyNoteRoles, type NoteRole } from '../../lib/note-delimiters.js';`

Add a cheap heading predicate (reuses existing heuristics) for the pre-pass:

```typescript
function looksLikeHeading(para: DocxParagraph): boolean {
  if (isPartHeading(para.text)) return true;
  const m = matchTextSignal(para.text);
  return m !== null && (m.nodeType === 'part' || m.nodeType === 'article');
}
```

Rework `classifyParagraphs` to compute roles first, then thread role into `classifyOne`:

```typescript
export function classifyParagraphs(
  paragraphs: readonly DocxParagraph[],
  numberingMap: NumberingMap,
  styleMap: StyleMap
): ClassifiedParagraph[] {
  const roles = classifyNoteRoles(
    paragraphs.map((p) => ({ text: p.text, isHeading: looksLikeHeading(p) }))
  );
  let prevNonContIlvl = 0;

  return paragraphs.map((para, i): ClassifiedParagraph => {
    const classified = classifyOne(para, numberingMap, styleMap, prevNonContIlvl, roles[i] ?? 'none');
    if (classified.nodeType !== 'continuation') {
      prevNonContIlvl = classified.resolvedIlvl;
    }
    return classified;
  });
}
```

In `classifyOne`, add the `role` parameter and handle rule/note before signals:

```typescript
function classifyOne(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  prevNonContIlvl: number,
  role: NoteRole
): ClassifiedParagraph {
  if (role === 'rule') {
    return { ...continuationResult(para, prevNonContIlvl, true), suppressed: true };
  }
  if (role === 'note' || para.isVanish || isNoteParagraph(para, styleMap)) {
    return continuationResult(para, prevNonContIlvl, true);
  }
  // ... existing signal logic ...
```

In `buildTree`, drop suppressed paragraphs (rule rows) alongside the existing empty filter:

```typescript
  const content = classified.filter(
    (cp) => cp.paragraph.text.trim().length > 0 && cp.suppressed !== true
  );
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- index.test.ts inference.test.ts` → PASS. `pnpm lint` (watch `classifyOne` complexity ≤ 10 / ≤ 50 lines — the early-returns keep it small).

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/inference.ts src/parser/docx/types.ts src/parser/docx/index.test.ts
git commit -m "feat(parser): strip asterisk rule rows, classify enclosed prose as notes"
```

**Phase 2 PR:** draft, link issue, board move.

---

# Phase 3 — Tables: classify, retain hidden, warn visible (PR 3)

**Branch:** `feat/docx-table-retention` · **Issue:** "Parse DOCX tables: retain hidden, warn on visible"

### Task 3.1: AST types + schema + warning enum

**Files:**
- Modify: `src/ast/types.ts`
- Modify: `src/ast/schemas.ts`
- Test: `src/ast/schemas.test.ts`

**Interfaces:**
- Produces: `interface RetainedTable { readonly rows: readonly (readonly string[])[] }`; `SpecTree.hiddenTables?: readonly RetainedTable[]`; `ParseWarningType` gains `'table-content-skipped'`.

- [ ] **Step 1: Write the failing test** — append to `src/ast/schemas.test.ts`:

```typescript
it('SpecTreeSchema accepts hiddenTables', () => {
  const tree = {
    id: '00000000-0000-0000-0000-000000000000',
    section: 'unknown', title: 'x', parts: [],
    hiddenTables: [{ rows: [['Rev', 'Date'], ['1', '2026-01-01']] }],
  };
  expect(() => SpecTreeSchema.parse(tree)).not.toThrow();
});

it('ParseWarningTypeSchema accepts table-content-skipped', () => {
  expect(() => ParseWarningSchema.parse({ type: 'table-content-skipped' })).not.toThrow();
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test -- schemas.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `src/ast/types.ts`:

```typescript
export interface RetainedTable {
  readonly rows: readonly (readonly string[])[];
}
```

Add `'table-content-skipped'` to the `ParseWarningType` union. Add to `SpecTree`:

```typescript
  /** Hidden tables retained out-of-band for future change-mgmt (ADR-038). Absent === none. */
  readonly hiddenTables?: readonly RetainedTable[];
```

In `src/ast/schemas.ts`:

```typescript
export const RetainedTableSchema = z.object({
  rows: z.array(z.array(z.string())),
});
```

Add `'table-content-skipped'` to `ParseWarningTypeSchema` enum. Add to `SpecTreeSchema`:

```typescript
  hiddenTables: z.array(RetainedTableSchema).exactOptional(),
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- schemas.test.ts` → PASS. `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/ast/types.ts src/ast/schemas.ts src/ast/schemas.test.ts
git commit -m "feat(ast): RetainedTable + SpecTree.hiddenTables + table-content-skipped warning"
```

### Task 3.2: `extractTables` — classify + grid extraction

**Files:**
- Create: `src/parser/docx/tables.ts`
- Test: `src/parser/docx/tables.test.ts`

**Interfaces:**
- Consumes: `StyleMap.vanishStyleIds`, `StyleMap.vanishCharStyleIds`.
- Produces: `extractTables(xml: string, styleMap: StyleMap): { hiddenTables: RetainedTable[]; visibleCount: number }`.

- [ ] **Step 1: Write the failing test** — `src/parser/docx/tables.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractTables } from './tables.js';
import { buildStyleMap } from './styles.js';

const STYLES = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;
const cell = (t: string, vanish = false) =>
  `<w:tc><w:p><w:r>${vanish ? '<w:rPr><w:vanish/></w:rPr>' : ''}<w:t>${t}</w:t></w:r></w:p></w:tc>`;
const row = (cells: string) => `<w:tr>${cells}</w:tr>`;
const doc = (tbls: string) =>
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${tbls}</w:body></w:document>`;

it('retains a fully-hidden table as a grid', () => {
  const tbl = `<w:tbl>${row(cell('Rev', true) + cell('Date', true))}${row(cell('1', true) + cell('2026', true))}</w:tbl>`;
  const r = extractTables(doc(tbl), buildStyleMap(STYLES));
  expect(r.visibleCount).toBe(0);
  expect(r.hiddenTables).toEqual([{ rows: [['Rev', 'Date'], ['1', '2026']] }]);
});

it('counts a visible table without retaining it', () => {
  const tbl = `<w:tbl>${row(cell('ITEM') + cell('SUBMITTAL'))}</w:tbl>`;
  const r = extractTables(doc(tbl), buildStyleMap(STYLES));
  expect(r.visibleCount).toBe(1);
  expect(r.hiddenTables).toEqual([]);
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test -- tables.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/parser/docx/tables.ts` (use the same `XMLParser` config as `document.ts`: `parseTagValue:false`, `trimValues:false`, `isArray` for `w:p`/`w:r`/`w:tr`/`w:tc`/`w:tbl`; reuse `extractRunText`-style logic). Pseudocode-complete:

```typescript
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { toArray } from './xml-utils.js';
import type { StyleMap } from './types.js';
import type { RetainedTable } from '../../ast/types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  isArray: (n) => ['w:tbl', 'w:tr', 'w:tc', 'w:p', 'w:r'].includes(n),
});

interface RunInfo { readonly text: string; readonly vanish: boolean; }

function runText(run: Record<string, unknown>): string {
  const t = run['w:t'];
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && '#text' in t) return String((t as Record<string, unknown>)['#text'] ?? '');
  return '';
}

function runVanish(run: Record<string, unknown>, charVanish: ReadonlySet<string>): boolean {
  const rPr = run['w:rPr'];
  if (rPr && typeof rPr === 'object') {
    const rec = rPr as Record<string, unknown>;
    if ('w:vanish' in rec) return true;
    const rStyle = (rec['w:rStyle'] as Record<string, unknown> | undefined)?.['@_w:val'];
    if (typeof rStyle === 'string' && charVanish.has(rStyle)) return true;
  }
  return false;
}

function cellRuns(tc: Record<string, unknown>, charVanish: ReadonlySet<string>): RunInfo[] {
  return toArray<Record<string, unknown>>(tc['w:p'] as readonly Record<string, unknown>[] | undefined)
    .flatMap((p) => toArray<Record<string, unknown>>(p['w:r'] as readonly Record<string, unknown>[] | undefined))
    .map((r) => ({ text: runText(r), vanish: runVanish(r, charVanish) }))
    .filter((r) => r.text.length > 0);
}

function cellText(tc: Record<string, unknown>): string {
  return toArray<Record<string, unknown>>(tc['w:p'] as readonly Record<string, unknown>[] | undefined)
    .map((p) => toArray<Record<string, unknown>>(p['w:r'] as readonly Record<string, unknown>[] | undefined).map(runText).join(''))
    .join('\n').trim();
}

export function extractTables(
  xml: string,
  styleMap: StyleMap
): { hiddenTables: RetainedTable[]; visibleCount: number } {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to scan tables in word/document.xml', { cause: err });
  }
  const body = ((parsed as Record<string, unknown>)['w:document'] as Record<string, unknown> | undefined)?.['w:body'] as Record<string, unknown> | undefined;
  const tables = toArray<Record<string, unknown>>(body?.['w:tbl'] as readonly Record<string, unknown>[] | undefined);

  const hiddenTables: RetainedTable[] = [];
  let visibleCount = 0;

  for (const tbl of tables) {
    const trs = toArray<Record<string, unknown>>(tbl['w:tr'] as readonly Record<string, unknown>[] | undefined);
    const allRuns = trs.flatMap((tr) =>
      toArray<Record<string, unknown>>(tr['w:tc'] as readonly Record<string, unknown>[] | undefined)
        .flatMap((tc) => cellRuns(tc, styleMap.vanishCharStyleIds))
    );
    const hidden = allRuns.length > 0 && allRuns.every((r) => r.vanish);
    if (hidden) {
      hiddenTables.push({
        rows: trs.map((tr) =>
          toArray<Record<string, unknown>>(tr['w:tc'] as readonly Record<string, unknown>[] | undefined).map(cellText)
        ),
      });
    } else {
      visibleCount += 1;
    }
  }
  return { hiddenTables, visibleCount };
}
```

(Note: keep each function ≤ 10 complexity; if `extractTables` trips the cap, extract the per-table classify into a helper `classifyTable(tbl, styleMap)`.)

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- tables.test.ts` → PASS. `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/tables.ts src/parser/docx/tables.test.ts
git commit -m "feat(parser): extractTables — retain hidden table grids, count visible"
```

### Task 3.3: Wire tables into the pipeline + openapi

**Files:**
- Modify: `src/parser/docx/index.ts`
- Modify: `openapi.yaml`
- Test: `src/parser/docx/index.test.ts`, `src/api/contract.integration.test.ts` (runs in CI integration — orchestrator verifies)

**Interfaces:**
- Consumes: `extractTables`.
- Produces: `parseDocx` result carries `hiddenTables` (when any) and a `table-content-skipped` warning (when a visible table exists).

- [ ] **Step 1: Write the failing test** — append to `src/parser/docx/index.test.ts`:

```typescript
it('retains hidden tables and warns on visible tables', async () => {
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Rev</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>ITEM</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  const tree = await parseDocx(await makeDocx({ documentXml: doc, numberingXml: STRUCTURED_NUMBERING }));
  expect(tree.hiddenTables).toEqual([{ rows: [['Rev']] }]);
  expect((tree.warnings ?? []).some((w) => w.type === 'table-content-skipped')).toBe(true);
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test -- index.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/parser/docx/index.ts`:

Import: `import { extractTables } from './tables.js';`

In `runPipeline`, after `const tree = buildTree(...)`, scan tables and merge results. `runPipeline` needs `styleMap` (already available from `buildClassification`) and the document XML (`entries.documentXml`):

```typescript
  const { hiddenTables, visibleCount } = extractTables(entries.documentXml, styleMap);
  const baseWarnings = auditTreeStructure(tree.parts);
  const warnings =
    visibleCount > 0
      ? [...baseWarnings, { type: 'table-content-skipped' as const,
          suggestion: `${visibleCount} visible table(s) detected but not yet modeled into the spec tree` }]
      : baseWarnings;

  return {
    ...tree,
    ...(hiddenTables.length > 0 ? { hiddenTables } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
```

(Remove the old `const warnings = auditTreeStructure(...)` / return at the end of `runPipeline`.)

In `openapi.yaml`:
- Add `table-content-skipped` to the `ParseWarning.type` enum (the list near line 3929).
- Add `hiddenTables` to the `SpecTree` schema properties (near line 4220), e.g.:

```yaml
        hiddenTables:
          type: array
          description: >
            Hidden tables retained out-of-band for the future change-management
            feature (ADR-038); excluded from the spec hierarchy.
          items:
            $ref: '#/components/schemas/RetainedTable'
```

- Add a `RetainedTable` schema under `components.schemas`:

```yaml
    RetainedTable:
      type: object
      required: [rows]
      properties:
        rows:
          type: array
          items:
            type: array
            items:
              type: string
```

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- index.test.ts` → PASS. `pnpm lint`. The orchestrator runs `pnpm test:integration` (incl. the contract gate `src/api/contract.integration.test.ts`) to confirm `openapi.yaml` matches.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/index.ts openapi.yaml src/parser/docx/index.test.ts
git commit -m "feat(parser): surface hidden tables + visible-table warning; update openapi"
```

**Phase 3 PR:** draft, link issue, board move.

---

# Phase 4 — Text/PDF note-delimiters + source_facts (PR 4)

**Branch:** `feat/text-notes-sourcefacts` · **Issue:** "Asterisk notes in text/PDF + surface vanish in source_facts"

### Task 4.1: Note-delimiter pre-pass in the text parser

**Files:**
- Modify: `src/parser/text/index.ts`
- Test: `src/parser/text/index.test.ts`

**Interfaces:**
- Consumes: `classifyNoteRoles` from `../../lib/note-delimiters.js`; `classifyLine` from `./signals.js`.
- Produces: text/PDF parse drops asterisk rule lines and emits enclosed lines as `note` nodes.

- [ ] **Step 1: Write the failing test** — append to `src/parser/text/index.test.ts`:

```typescript
it('treats asterisk-bracketed lines as notes, not continuation', () => {
  const text = [
    'PART 1 - GENERAL',
    '1.1 SUMMARY',
    '***********************',
    'Edit to suit the project.',
    '***********************',
    'A. Real requirement.',
  ].join('\n');
  const { tree } = parseText(text);
  const collect = (n: any): any[] => [n, ...n.children.flatMap(collect)];
  const all = tree.parts.flatMap(collect);
  expect(all.some((n) => /^\*{5,}$/.test(n.text.trim()))).toBe(false);
  expect(all.some((n) => n.type === 'note' && n.text.includes('Edit to suit'))).toBe(true);
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test -- text/index.test.ts` → FAIL (asterisk lines become continuation/dropped).

- [ ] **Step 3: Implement** — in `src/parser/text/index.ts`:

Import `import { classifyNoteRoles } from '../../lib/note-delimiters.js';`

In `buildTree(lines)`, compute roles first. A line is a heading for the note scan if `classifyLine` returns a structural type:

```typescript
  const classifications = lines.map((l) => classifyLine(l));
  const roles = classifyNoteRoles(
    classifications.map((c) => ({ text: c.text, isHeading: isStructural(c.type) }))
  );
```

In the `lines.forEach((line, lineIdx) => { ... })` body, branch on role before the existing logic:

```typescript
    const role = roles[lineIdx] ?? 'none';
    if (role === 'rule') return; // strip the asterisk row
    if (role === 'note') {
      stack[stack.length - 1]!.children.push(makeNode('note', classifications[lineIdx]!.text, []));
      return;
    }
    const cls = classifications[lineIdx]!;
    // ... existing blank/header/continuation/structural handling using cls ...
```

(Reuse the precomputed `classifications[lineIdx]` instead of calling `classifyLine(line)` again — DRY.)

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- text/index.test.ts` → PASS. `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/parser/text/index.ts src/parser/text/index.test.ts
git commit -m "feat(parser): asterisk note-delimiters in text/PDF ingest"
```

### Task 4.2: Populate `source_facts.vanish` + `banner`

**Files:**
- Modify: `src/parser/docx/source-facts.ts`
- Test: `src/parser/docx/source-facts.test.ts` (create if absent) or `index.test.ts`

**Interfaces:**
- Produces: per-paragraph `SourceFacts.vanish === true` when all text runs are hidden; `SourceFacts.banner === <text>` when a specifier-note banner phrase opens the paragraph.

- [ ] **Step 1: Write the failing test** — append a test that parses a DOCX whose paragraph runs are all vanish and asserts `meta.sourceFacts.vanish === true` on the resulting node (via `parseDocx`), plus a banner case using text `"** NOTE TO SPECIFIER **"`.

```typescript
it('records vanish + banner in source_facts', async () => {
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:r><w:t>** NOTE TO SPECIFIER ** keep this.</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden line</w:t></w:r></w:p>
  </w:body></w:document>`;
  const tree = await parseDocx(await makeDocx({ documentXml: doc, numberingXml: STRUCTURED_NUMBERING }));
  const collect = (n: SpecNode): SpecNode[] => [n, ...n.children.flatMap(collect)];
  const all = tree.parts.flatMap(collect);
  expect(all.some((n) => n.meta.sourceFacts?.banner?.includes('NOTE TO SPECIFIER'))).toBe(true);
  expect(all.some((n) => n.meta.sourceFacts?.vanish === true)).toBe(true);
});
```

- [ ] **Step 2: Run test, verify it fails** — FAIL (`banner`/`vanish` never populated).

- [ ] **Step 3: Implement** — in `src/parser/docx/source-facts.ts`:

`collectInline` already walks runs and reads `w:rPr`. Extend the inline state to also track per-run vanish coverage. Simplest within the existing structure: in `runColorTokens`, additionally return whether the run is vanish, and accumulate a `vanishChars` count in `InlineState` alongside text length; mark a paragraph `vanish` when `vanishChars === text.length && text.length > 0`. Add to `makeSourceFacts`:

```typescript
function bannerFor(text: string): string | undefined {
  return isSpecifierNote(text) ? text.trim() : undefined; // import isSpecifierNote from './heuristics.js'
}
```

Thread `vanish` and `banner` into `makeSourceFacts` and include them:

```typescript
  return {
    ...(comments.length > 0 ? { comments } : {}),
    ...(colors.length > 0 ? { colors } : {}),
    ...(choiceTokens.length > 0 ? { choiceTokens } : {}),
    ...(banner !== undefined ? { banner } : {}),
    ...(vanish ? { vanish: true as const } : {}),
  };
```

Update the `undefined` short-circuit in `makeSourceFacts` to also consider `banner`/`vanish` (so a paragraph with only a banner still produces facts).

- [ ] **Step 4: Run test, verify it passes** — `pnpm test -- index.test.ts source-facts.test.ts` → PASS. `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/source-facts.ts src/parser/docx/source-facts.test.ts src/parser/docx/index.test.ts
git commit -m "feat(parser): populate source_facts.vanish + banner for onboarding"
```

### Task 4.3: Gated end-to-end test against the real artifact

**Files:**
- Create: `src/parser/docx/hidden-text.integration.test.ts`

**Interfaces:**
- Consumes: the gitignored `docs/references/MANUFACTURER_EXAMPLES/hidden-text-test.docx` (gated on `existsSync`, like `arcat.integration.test.ts`).

- [ ] **Step 1: Write the gated test**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from '../index.js';

const FILE = resolve(__dirname, '../../../docs/references/MANUFACTURER_EXAMPLES/hidden-text-test.docx');
const AVAILABLE = existsSync(FILE);

describe.runIf(AVAILABLE)('hidden-text-test.docx end-to-end', () => {
  it('clean hierarchy + asterisk notes stripped + hidden tables retained', async () => {
    const { tree } = await parse(readFileSync(FILE), 'hidden-text-test.docx');
    const collect = (n: any): any[] => [n, ...n.children.flatMap(collect)];
    const all = tree.parts.flatMap(collect);
    expect(tree.parts.filter((n: any) => n.type === 'part')).toHaveLength(3);
    expect(all.some((n: any) => /^\*{5,}$/.test(n.text.trim()))).toBe(false); // no asterisk walls
    expect((tree.hiddenTables ?? []).length).toBeGreaterThanOrEqual(3);       // sign-off + revision tables
    expect((tree.warnings ?? []).some((w: any) => w.type === 'table-content-skipped')).toBe(true);
  });
});
```

- [ ] **Step 2: Run locally (orchestrator, outside sandbox)** — `pnpm test -- hidden-text.integration.test.ts`. Expected: PASS where the file exists; the `describe.runIf` skips in CI.

- [ ] **Step 3: Commit**

```bash
git add src/parser/docx/hidden-text.integration.test.ts
git commit -m "test(parser): gated end-to-end check on the hidden-text artifact"
```

**Phase 4 PR:** draft, link issue, board move.

---

## Self-Review (completed by author)

- **Spec coverage:** Component 1 → Tasks 1.1–1.2; Component 2 → Task 1.3; Component 3 → Tasks 2.1–2.2 (DOCX) + 4.1 (text/PDF); Component 4 → Tasks 3.1–3.3; Component 5 → Task 4.2. Decisions D1→3.x, D2→3.3, D3→2.x, D4→4.2, D5→1.3. ADR-038 → Task 1.4. Gated artifact test → Task 4.3.
- **Type consistency:** `parseDocument(xml, numberingMap, styleMap, commentsById?)` used identically in 1.2 and `index.ts`; `StyleMap.vanishStyleIds`/`vanishCharStyleIds` defined in 1.1, consumed in 1.2/3.2; `classifyNoteRoles`/`isRuleRow`/`NoteRole` defined in 2.1, consumed in 2.2/4.1; `RetainedTable` defined in 3.1, consumed in 3.2/3.3; `ClassifiedParagraph.suppressed` defined+consumed in 2.2.
- **Placeholder scan:** every code step carries real code; no TBD/TODO.
```
