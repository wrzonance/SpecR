# Section-Number Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept the full expanded CSI section-number grammar — `NN NN NN`, `NN NN NN.NN`, `NN NN NN.NN NN` — as first-class section identities across every parse, inference, linking, validation, and storage path.

**Architecture:** One new pure module `src/lib/section-number.ts` owns the grammar (anchored validator, composable regex fragment, whitespace normalizer, Zod schema). Eight consumer sites adopt it. A DB migration normalizes existing rows and adds CHECK constraints as the last line of defense. Spec: `docs/superpowers/specs/2026-06-05-section-number-expansion-design.md`.

**Tech Stack:** TypeScript strict, Zod v4 (`.exactOptional()`, `z.uuid()` style), vitest (`pnpm test` = `vitest run --project unit`), node-pg-migrate, PostgreSQL.

**Branch:** All work on `feat/section-number-expansion` (this worktree, based on origin/main `ba99b64`). PR cutting at the end (Task 16).

**Key grammar facts** (corpus-verified, 665 UFGS `.SEC` files):
- 422 base / 162 dotted / 76 agency-suffixed; whitespace dirt exists (leading/double spaces); 2 SCN tags lack the `SECTION` keyword prefix.
- `26 00 13` and `26 00 13.10` and `26 00 13.20` are THREE DIFFERENT sections. Truncation is data corruption.
- Linking is **exact match only** (locked decision). Lexicographic sort is already correct for this grammar — do not touch ordering.
- JS `\s` already matches NBSP (` `); normalization still canonicalizes runs to single ASCII spaces.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/lib/section-number.ts` | Grammar owner: `SECTION_NUMBER_RE`, `sectionNumberFragment()`, `normalizeSectionNumber()`, `findSectionNumbers()`, `SectionNumberSchema` |
| **Create** `src/lib/section-number.test.ts` | Module unit suite |
| **Create** `docs/adr/020-section-number-expanded-shape.md` | Decision record |
| **Modify** `CLAUDE.md` | Add ADR-020 to the ADR list |
| **Modify** `src/parser/refs/rules.ts` | `csi-section-keyword` pattern embeds fragment |
| **Modify** `src/parser/refs/extract.ts` | `buildRef` normalizes single capture |
| **Modify** `src/lib/infer-section.ts` | `KEYWORD_RE` / `INLINE_TITLE_RE` / `BARE_NUM_RE` rebuilt on fragment |
| **Modify** `src/parser/text/index.ts` | `SECTION_EXTRACT_RE` / `BARE_SECTION_RE` rebuilt on fragment |
| **Modify** `src/parser/sec/index.ts` | SCN + SRF normalize-or-verbatim |
| **Modify** `src/ast/schemas.ts` | Both section regexes → schema from module |
| **Modify** `src/api/parse.ts` | Worker output schema tightened; body section override validated |
| **Modify** `src/api/generate.ts` | `safeFilename` preserves dots in section |
| **Modify** `ARCHITECTURE.md` | Refresh 4 stale `NN NN NN`-only examples |
| **Create** `src/db/migrations/013_section_number_normalize_and_check.ts` | Normalize rows + CHECK constraints |
| **Modify** `src/db/seed.ts` | SCN regex prefix-optional + normalize |
| Tests modified alongside each consumer | See per-task sections |

**Module boundary rule:** consumers import from `'../lib/section-number.js'` (or `'../../lib/section-number.js'`) — `lib/` is importable from any module. Never import lib internals from each other's internals.

---

## PR 1 — `feat(lib): section-number module — expanded-shape validator + normalizer`

### Task 1: The grammar module

**Files:**
- Create: `src/lib/section-number.ts`
- Test: `src/lib/section-number.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/section-number.test.ts
import { describe, it, expect } from 'vitest';
import {
  SECTION_NUMBER_RE,
  sectionNumberFragment,
  normalizeSectionNumber,
  findSectionNumbers,
  SectionNumberSchema,
} from './section-number.js';

describe('SECTION_NUMBER_RE', () => {
  it.each(['26 00 13', '26 00 13.10', '26 00 13.20', '01 32 01.00 10', '27 05 13.43'])(
    'accepts canonical %s',
    (s) => {
      expect(SECTION_NUMBER_RE.test(s)).toBe(true);
    }
  );

  it.each([
    '26 00 13.1', //     one-digit suffix
    '26 00 13.100', //   three-digit suffix
    '26 00 13.10 5', //  one-digit agency
    '26 00 13 10', //    agency without dotted suffix
    '2600 13', //        missing separator
    '26 00 13.10.20', // double dot
    '26  00 13', //      double internal space (canonical form is single-space)
    ' 26 00 13', //      leading space
    'unknown', //        sentinel is NOT a section number
  ])('rejects %s', (s) => {
    expect(SECTION_NUMBER_RE.test(s)).toBe(false);
  });
});

describe('normalizeSectionNumber', () => {
  it('passes canonical forms through', () => {
    expect(normalizeSectionNumber('26 00 13')).toBe('26 00 13');
    expect(normalizeSectionNumber('01 32 01.00 10')).toBe('01 32 01.00 10');
  });

  it('canonicalizes corpus whitespace dirt: leading/trailing/double spaces', () => {
    expect(normalizeSectionNumber(' 26 00 13 ')).toBe('26 00 13');
    expect(normalizeSectionNumber('26  00  13.10')).toBe('26 00 13.10');
  });

  it('canonicalizes NBSP separators', () => {
    expect(normalizeSectionNumber('26\u00A000\u00A013.10')).toBe('26 00 13.10');
  });

  it('returns null for non-section strings', () => {
    expect(normalizeSectionNumber('PAINTING')).toBeNull();
    expect(normalizeSectionNumber('26 00 13.1')).toBeNull();
    expect(normalizeSectionNumber('')).toBeNull();
    expect(normalizeSectionNumber('unknown')).toBeNull();
  });
});

describe('sectionNumberFragment', () => {
  it('embeds into a keyword scanner and captures the full number as group 1', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
    expect(re.exec('SECTION 26 00 13.10 PANELBOARDS')?.[1]).toBe('26 00 13.10');
    expect(re.exec('SECTION 01 32 01.00 10 QUALITY')?.[1]).toBe('01 32 01.00 10');
    expect(re.exec('SECTION 26 00 13 GENERAL')?.[1]).toBe('26 00 13');
  });

  it('does not capture a trailing pair as agency without a dotted suffix', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
    // "20 AMP" must not become an agency suffix — agency requires the dot first
    expect(re.exec('SECTION 26 00 13 20 AMP PANELBOARDS')?.[1]).toBe('26 00 13');
  });

  it('does not match digits glued to longer numbers', () => {
    const re = new RegExp(`^${sectionNumberFragment()}$`);
    expect(re.test('26 00 134')).toBe(false);
    expect(re.test('126 00 13')).toBe(false);
    expect(re.test('26 00 13.1010')).toBe(false);
  });

  it('does not capture agency from a following 4-digit year', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
    expect(re.exec('SECTION 26 00 13.10 2024 EDITION')?.[1]).toBe('26 00 13.10');
  });

  // KNOWN AMBIGUITY: a bare two-digit token after a dotted suffix is
  // indistinguishable from an agency suffix in free prose. We accept the
  // false positive; tagged .SEC <SRF> refs are immune (verbatim path).
  it('KNOWN AMBIGUITY: "26 00 13.10 20 mm" captures 20 as agency', () => {
    const re = new RegExp(String.raw`\bSection\s+${sectionNumberFragment()}`, 'i');
    expect(re.exec('See Section 26 00 13.10 20 mm pipe')?.[1]).toBe('26 00 13.10 20');
  });
});

describe('findSectionNumbers', () => {
  it('finds and normalizes all citations with offsets', () => {
    const text = 'See 26 00 13.10 and also 09\u00A091 00.';
    const found = findSectionNumbers(text);
    expect(found.map((f) => f.value)).toEqual(['26 00 13.10', '09 91 00']);
    expect(found[0]?.index).toBe(4);
  });

  it('returns empty array when nothing matches', () => {
    expect(findSectionNumbers('no numbers here')).toEqual([]);
  });
});

describe('SectionNumberSchema', () => {
  it('accepts expanded shapes', () => {
    expect(SectionNumberSchema.safeParse('01 32 01.00 10').success).toBe(true);
  });
  it('rejects malformed and sentinel values', () => {
    expect(SectionNumberSchema.safeParse('27210').success).toBe(false);
    expect(SectionNumberSchema.safeParse('unknown').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/section-number.test.ts`
Expected: FAIL — `Cannot find module './section-number.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/section-number.ts
import { z } from 'zod';

/**
 * Canonical CSI/UFGS section-number grammar (expanded shape):
 *   NN NN NN            — MasterFormat Level 3            (26 00 13)
 *   NN NN NN.NN         — Level 4 dotted suffix           (26 00 13.10)
 *   NN NN NN.NN NN      — Level 5 agency suffix, UFGS     (01 32 01.00 10)
 * Each shape is a DISTINCT section identity. See ADR-020.
 */
export const SECTION_NUMBER_RE = /^\d{2} \d{2} \d{2}(?:\.\d{2}(?: \d{2})?)?$/;

// Scanner fragment. Differences from SECTION_NUMBER_RE, all deliberate:
// - `\s+` separators: tolerates NBSP/multi-space/newline dirt found in real
//   documents (JS `\s` includes  ); normalizeSectionNumber canonicalizes.
// - Agency separator is horizontal-only ([^\S\r\n]) so a 2-digit token on the
//   NEXT LINE is never absorbed as an agency suffix.
// - (?<![\d.]) / (?!\d) guards: never match inside longer numbers (26 00 134,
//   version strings, years).
// - ONE capture group wrapping the whole number: consumers embed the fragment
//   and recover the value via normalizeSectionNumber(match[1]).
const FRAGMENT = String.raw`(?<![\d.])(\d{2}\s+\d{2}\s+\d{2}(?:\.\d{2}(?!\d)(?:[^\S\r\n]+\d{2}(?!\d))?)?)(?!\d)`;

/** Regex source fragment for embedding in larger scanners (keyword/prose/bare). */
export function sectionNumberFragment(): string {
  return FRAGMENT;
}

/**
 * Canonicalize a raw section-number string: NBSP→space, collapse whitespace
 * runs, trim. Returns the canonical form, or null when the result is not a
 * valid expanded-shape section number.
 */
export function normalizeSectionNumber(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return SECTION_NUMBER_RE.test(collapsed) ? collapsed : null;
}

export interface SectionMatch {
  readonly value: string;
  readonly index: number;
}

/** Scan free text for section-number citations; values come back normalized. */
export function findSectionNumbers(text: string): readonly SectionMatch[] {
  const re = new RegExp(FRAGMENT, 'g');
  const out: SectionMatch[] = [];
  for (const m of text.matchAll(re)) {
    const value = normalizeSectionNumber(m[1] ?? '');
    // RegExpMatchArray.index is optional in TS lib typings — guard for strict mode
    if (value !== null && m.index !== undefined) out.push({ value, index: m.index });
  }
  return out;
}

/** Zod gate for canonical section numbers (does NOT admit the 'unknown' sentinel). */
export const SectionNumberSchema = z.string().regex(SECTION_NUMBER_RE);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/section-number.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Lint and commit**

```bash
pnpm lint
git add src/lib/section-number.ts src/lib/section-number.test.ts
git commit -m "feat(lib): section-number module — expanded-shape validator + normalizer"
```

### Task 2: ADR-020

**Files:**
- Create: `docs/adr/020-section-number-expanded-shape.md`
- Modify: `CLAUDE.md` (ADR list, after `019-scope-boundaries-content-neutral-platform.md`)

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-020: Expanded Section-Number Shape as Opaque Normalized String

## Status: Accepted

## Context

CSI MasterFormat Level 4 (`26 00 13.10`) and UFGS Level 5 agency suffixes
(`01 32 01.00 10`; 10 = Army Corps, 20 = NAVFAC, 30/40 = NASA/AFCEC) appear in
36% of the UFGS reference corpus and arrive through every ingest format (.SEC,
DOCX, plaintext). SpecR previously validated only `NN NN NN`, silently
truncating suffixes in prose-ref extraction and content inference — collapsing
distinct sections (e.g. `01 33 23` vs `01 33 23.33`) into one identity.

Two viable designs:
1. Opaque normalized string, grammar owned by one module.
2. Structured `SectionNumber` type with decomposed DB columns
   (division/l2/l3/suffix/agency).

## Decision

Opaque normalized string (`src/lib/section-number.ts` owns the grammar).
Canonical form: single ASCII spaces, `NN NN NN`, `NN NN NN.NN`, or
`NN NN NN.NN NN`. Cross-reference linking remains **exact match only** — a ref
to `26 00 13` never resolves to `26 00 13.10` or vice versa. DB CHECK
constraints enforce shape on `specs.section` (plus the `'unknown'` inference
sentinel) and `spec_sections.section_number`;
`spec_references.target_spec_section` stays unconstrained because it records
what the source document said.

## Consequences

- One module to change when the grammar grows; consumers embed its fragment.
- Exact-match keeps broken refs honest (a base ref to a missing base section
  is genuinely broken) at the cost of no family fallback.
- Structured queries (e.g. "all agency variants of X") require LIKE prefixes
  rather than column equality — acceptable; no current feature needs them.
- Free-prose ambiguity: `Section 26 00 13.10 20 mm` mis-reads `20` as an
  agency suffix. Documented as KNOWN AMBIGUITY; tagged .SEC refs are immune.
- Lexicographic ORDER BY remains correct for the fixed-width grammar.
```

- [ ] **Step 2: Add to CLAUDE.md ADR list**

In `CLAUDE.md`, in the `docs/adr/` listing, after the line
`019-scope-boundaries-content-neutral-platform.md`, add:

```text
  020-section-number-expanded-shape.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/020-section-number-expanded-shape.md CLAUDE.md
git commit -m "docs(adr): ADR-020 expanded section-number shape as opaque normalized string"
```

**PR 1 cut point** — everything through here is PR 1 (~330 LOC).

---

## PR 2 — `feat(parser): adopt section-number module in refs/inference/text parsers`

### Task 3: Prose cross-reference rule (`rules.ts` + `extract.ts`)

This fixes the **wrong-linkage bug**: `See Section 26 00 13.10` currently stores `targetSpecSection: '26 00 13'`.

**Files:**
- Modify: `src/parser/refs/rules.ts` (pattern at line 24, examples at line 26)
- Modify: `src/parser/refs/extract.ts` (`buildRef`, line 47-62)
- Test: `src/parser/refs/rules.test.ts`, `src/parser/refs/extract.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `describe('SECTION_REF_RULES', ...)` in `src/parser/refs/rules.test.ts`:

```typescript
  it('csi-section-keyword: captures dotted suffix — Section 26 00 13.10 not truncated to base', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
    expect(fresh.exec('See Section 26 00 13.10 for switchgear')?.[1]).toBe('26 00 13.10');
  });

  it('csi-section-keyword: captures agency suffix — Section 01 32 01.00 10', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
    expect(fresh.exec('per Section 01 32 01.00 10 requirements')?.[1]).toBe('01 32 01.00 10');
  });
```

Append to `src/parser/refs/extract.test.ts` (match its existing tree-builder helpers; if it has a `makeTree`/`makeNode` helper, reuse it — the assertion is what matters):

```typescript
  it('refs: Section 26 00 13.10 citation — suffix retained, not truncated to base', () => {
    const tree = makeTreeWithText('Comply with Section 26 00 13.10 and Section 09 91 00.');
    const refs = extractRefsFromTree(tree);
    const sections = refs
      .filter((r) => r.targetType === 'section')
      .map((r) => r.targetSpecSection);
    expect(sections).toContain('26 00 13.10');
    expect(sections).toContain('09 91 00');
    expect(sections).not.toContain('26 00 13');
  });

  it('refs: NBSP-separated citation normalizes to canonical spacing', () => {
    const tree = makeTreeWithText('See Section 26\u00A000\u00A013.10 now.');
    const refs = extractRefsFromTree(tree);
    expect(refs.find((r) => r.targetType === 'section')?.targetSpecSection).toBe('26 00 13.10');
  });
```

(If `extract.test.ts` lacks a one-string tree helper, add at top of the file:)

```typescript
function makeTreeWithText(text: string): SpecTree {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    section: '27 21 00',
    title: 'Test',
    parts: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'part',
        text,
        children: [],
        meta: {},
      },
    ],
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/parser/refs/`
Expected: FAIL — captured group is `'26'` (old group 1) / truncated `'26 00 13'`

- [ ] **Step 3: Implement**

In `src/parser/refs/rules.ts` — add import at top, replace the rule pattern and examples:

```typescript
import { sectionNumberFragment } from '../../lib/section-number.js';
```

```typescript
  {
    id: 'csi-section-keyword',
    description:
      'Matches "Section XX XX XX[.XX[ XX]]" — standard CSI cross-reference with keyword ' +
      'prefix, including Level 4 dotted suffixes and UFGS Level 5 agency suffixes. ' +
      'Most reliable pattern; matches how spec writers are trained to cite other sections.',
    pattern: new RegExp(String.raw`\bSection\s+${sectionNumberFragment()}`, 'gi'),
    targetType: 'section',
    examples: [
      'See Section 09 91 00',
      'Section 27 21 00 applies to this work',
      'See Section 26 00 13.10',
      'per Section 01 32 01.00 10',
    ],
    knownFalsePositives: ['Section 26 00 13.10 20 mm pipe — trailing pair reads as agency'],
  },
```

In `src/parser/refs/extract.ts` — add import, change the section branch of `buildRef` (the whole section number is now capture group 1):

```typescript
import { normalizeSectionNumber } from '../../lib/section-number.js';
```

```typescript
function buildRef(sourceNodeId: string, rule: ExtractionRule, match: RegExpMatchArray): SecRef {
  if (rule.targetType === 'section') {
    const raw = match[1] ?? '';
    return {
      sourceNodeId,
      targetType: 'section',
      targetSpecSection: normalizeSectionNumber(raw) ?? raw.trim(),
      referenceText: match[0],
    };
  }
  return {
    sourceNodeId,
    targetType: 'standard',
    standardCode: `${match[1]} ${match[2]}`,
    referenceText: match[0],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/parser/refs/`
Expected: PASS, including the pre-existing malformed-rejection tests (`Section 9 91 00`, `Section 091 00` still rejected by the fragment's `\d{2}` groups and guards)

- [ ] **Step 5: Commit**

```bash
git add src/parser/refs/
git commit -m "fix(parser): prose section refs capture dotted and agency suffixes — no more base truncation"
```

### Task 4: Content inference (`infer-section.ts`)

Fixes silent truncation (`01 33 23.33` → `01 33 23`), bare-number no-match, and lost inline titles.

**Files:**
- Modify: `src/lib/infer-section.ts` (lines 13-15 regexes; `findInlineTitle`; `scanKeyword`; `scanBareNumber`)
- Test: `src/lib/infer-section.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing describe block in `src/lib/infer-section.test.ts` (reuse its `makeTree` helper):

```typescript
  it('infer-section: keyword scan keeps .33 — 01 33 23.33 is not 01 33 23', () => {
    const tree = makeTree([{ text: 'SECTION 01 33 23.33 AVIATION FUEL DISTRIBUTION' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-high');
    expect(result.inferredSection).toBe('01 33 23.33');
  });

  it('infer-section: keyword scan keeps agency suffix — 01 32 01.00 10', () => {
    const tree = makeTree([{ text: 'SECTION 01 32 01.00 10' }, { text: 'QUALITY CONTROL' }]);
    const result = inferSectionMeta(tree);
    expect(result.inferredSection).toBe('01 32 01.00 10');
    expect(result.inferredTitle).toBe('QUALITY CONTROL');
  });

  it('infer-section: inline title extracted from suffixed header', () => {
    const tree = makeTree([{ text: 'SECTION 01 33 23.33 AVIATION FUEL DISTRIBUTION' }]);
    expect(inferSectionMeta(tree).inferredTitle).toBe('AVIATION FUEL DISTRIBUTION');
  });

  it('infer-section: bare suffixed header 26 00 13.10 inferred, not none', () => {
    const tree = makeTree([{ text: '26 00 13.10' }, { text: 'PANELBOARDS' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-medium');
    expect(result.inferredSection).toBe('26 00 13.10');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/infer-section.test.ts`
Expected: FAIL — `'01 33 23'` (truncated), `'none'` method for bare suffixed

- [ ] **Step 3: Implement**

In `src/lib/infer-section.ts`, add import and replace the three regex constants:

```typescript
import { normalizeSectionNumber, sectionNumberFragment } from './section-number.js';

const KEYWORD_RE = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
const INLINE_TITLE_RE = new RegExp(
  String.raw`\bSECTION\s+${sectionNumberFragment()}\s+(\S.*)`,
  'i'
);
const BARE_NUM_RE = new RegExp(`^${sectionNumberFragment()}$`);
```

`findInlineTitle` — the title is now capture group 2 (group 1 is the section number):

```typescript
function findInlineTitle(nodeText: string): string | null {
  const inlineMatch = INLINE_TITLE_RE.exec(nodeText);
  if (inlineMatch?.[2] !== undefined && isValidTitle(inlineMatch[2])) {
    return inlineMatch[2].trim();
  }
  return null;
}
```

`scanKeyword` and `scanBareNumber` — normalize the single capture; skip (keep scanning) if normalization fails:

```typescript
function scanKeyword(nodes: readonly SpecNode[]): SectionInference | null {
  for (let i = 0; i < nodes.length; i++) {
    const m = KEYWORD_RE.exec(nodes[i]?.text ?? '');
    const section = m === null ? null : normalizeSectionNumber(m[1] ?? '');
    if (section !== null) {
      return {
        method: 'content-high',
        confidence: 'high',
        inferredSection: section,
        inferredTitle: findTitle(nodes, i),
        titleMatch: 'unknown',
      };
    }
  }
  return null;
}

function scanBareNumber(nodes: readonly SpecNode[]): SectionInference | null {
  for (let i = 0; i < nodes.length; i++) {
    const m = BARE_NUM_RE.exec((nodes[i]?.text ?? '').trim());
    const section = m === null ? null : normalizeSectionNumber(m[1] ?? '');
    if (section !== null) {
      return {
        method: 'content-medium',
        confidence: 'medium',
        inferredSection: section,
        inferredTitle: findTitle(nodes, i),
        titleMatch: 'unknown',
      };
    }
  }
  return null;
}
```

(`isValidTitle` needs no change — it calls `.test()` on the same constants.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/infer-section.test.ts`
Expected: PASS — new tests AND all pre-existing tests (title-window boundaries, embedded-sentence rejection, 50-node cap)

- [ ] **Step 5: Commit**

```bash
git add src/lib/infer-section.ts src/lib/infer-section.test.ts
git commit -m "fix(lib): section inference keeps dotted and agency suffixes — truncation collided distinct sections"
```

### Task 5: Plaintext parser (`parser/text`)

**Files:**
- Modify: `src/parser/text/index.ts` (lines 41-42 regexes; `extractSectionMeta` lines 62-79)
- Test: `src/parser/text/index.test.ts` (exists — find its header-meta describe block and append)

- [ ] **Step 1: Write the failing tests**

Append to `src/parser/text/index.test.ts`:

```typescript
  it('text parser: SECTION 27 05 13.43 - TITLE — suffix kept, title extracted', () => {
    const result = parseText('SECTION 27 05 13.43 - TELEVISION DISTRIBUTION\n\nPART 1 GENERAL\n');
    expect(result.tree.section).toBe('27 05 13.43');
    expect(result.tree.title).toBe('TELEVISION DISTRIBUTION');
  });

  it('text parser: agency-suffixed header with dash title', () => {
    const result = parseText('SECTION 01 32 01.00 10 - QUALITY CONTROL\n\nPART 1 GENERAL\n');
    expect(result.tree.section).toBe('01 32 01.00 10');
    expect(result.tree.title).toBe('QUALITY CONTROL');
  });

  it('text parser: bare suffixed header line', () => {
    const result = parseText('26 00 13.10 - PANELBOARDS\n\nPART 1 GENERAL\n');
    expect(result.tree.section).toBe('26 00 13.10');
    expect(result.tree.title).toBe('PANELBOARDS');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/parser/text/`
Expected: FAIL — section `'27 05 13'`, title `'unknown'` (the `.43` garbles the dash branch)

- [ ] **Step 3: Implement**

In `src/parser/text/index.ts`, add import and replace the two regex constants (title moves to group 2):

```typescript
import { normalizeSectionNumber, sectionNumberFragment } from '../../lib/section-number.js';

const SECTION_EXTRACT_RE = new RegExp(
  String.raw`SECTION\s+${sectionNumberFragment()}(?:\s*[-–—]\s*(.+))?`,
  'i'
);
const BARE_SECTION_RE = new RegExp(String.raw`^${sectionNumberFragment()}(?:\s*[-–—]\s*(.+))?`);
```

In `extractSectionMeta`, replace the match-handling block:

```typescript
    const m = SECTION_EXTRACT_RE.exec(trimmed) ?? BARE_SECTION_RE.exec(trimmed);
    if (m !== null) {
      const section = normalizeSectionNumber(m[1] ?? '');
      if (section !== null) {
        return {
          section,
          title: (m[2] ?? '').trim() || 'unknown',
        };
      }
    }
```

(`src/parser/text/signals.ts` `SECTION_HEADER_RE` needs NO change — it is an unanchored prefix classifier that already accepts suffixed headers; the pin test below proves it.)

Append a pin test to `src/parser/text/index.test.ts`:

```typescript
  it('text parser: suffixed SECTION line classified as header, not body content', () => {
    const result = parseText(
      'SECTION 27 05 13.43 - TELEVISION DISTRIBUTION\nPART 1 GENERAL\n1.1 SUMMARY\n'
    );
    // header line must not appear as a structural/continuation node
    const texts: string[] = [];
    const walk = (n: { text: string; children: readonly { text: string }[] }): void => {
      texts.push(n.text);
      n.children.forEach((c) => walk(c as never));
    };
    result.tree.parts.forEach((p) => walk(p as never));
    expect(texts.some((t) => t.includes('TELEVISION DISTRIBUTION'))).toBe(false);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/parser/text/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/parser/text/
git commit -m "fix(parser): .txt header extraction keeps suffixed section numbers and their titles"
```

### Task 6: SEC parser normalization (`parser/sec`)

SCN/SRF already preserve suffixes verbatim — this task adds **canonicalization** (whitespace dirt exists in 3 corpus files) without ever rejecting a tagged value.

**Files:**
- Modify: `src/parser/sec/index.ts` (SCN at lines 184-189, `pushSrfRefs` at lines 74-83)
- Test: `src/parser/sec/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/parser/sec/index.test.ts` (reuse its fixture-string style):

```typescript
  it('sec parser: SCN with whitespace dirt normalizes to canonical form', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION  26 00 13.10 </SCN><STL>PANELBOARDS</STL></SEC>`;
    const { tree } = parseSec(xml);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('sec parser: SRF target normalizes NBSP separators to canonical form', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION 27 41 00</SCN><STL>T</STL><PRT><TTL>PART 1</TTL><SPT><TTL>X</TTL><TXT>See <SRF>26\u00A000\u00A013.10</SRF> now.</TXT></SPT></PRT></SEC>`;
    const { refs } = parseSec(xml);
    const sRef = refs.find((r) => r.targetType === 'section');
    expect(sRef?.targetSpecSection).toBe('26 00 13.10');
  });

  it('sec parser: unnormalizable SRF content kept verbatim (never dropped)', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION 27 41 00</SCN><STL>T</STL><PRT><TTL>PART 1</TTL><SPT><TTL>X</TTL><TXT>See <SRF>APPENDIX B</SRF> now.</TXT></SPT></PRT></SEC>`;
    const { refs } = parseSec(xml);
    const sRef = refs.find((r) => r.targetType === 'section');
    expect(sRef?.targetSpecSection).toBe('APPENDIX B');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/parser/sec/`
Expected: FAIL — first test gets `'26 00 13.10 '`-ish raw (double-space/trailing preserved), second gets NBSP-joined string

(If the first two happen to pass due to `trimValues`, keep them as pins — at minimum the NBSP test fails.)

- [ ] **Step 3: Implement**

In `src/parser/sec/index.ts`, add import:

```typescript
import { normalizeSectionNumber } from '../../lib/section-number.js';
```

Replace the SCN extraction in `parseSec`:

```typescript
  // SCN/STL are parsed with processEntities: false — decode here.
  // Normalize-or-verbatim: canonicalize section whitespace when the value is a
  // valid expanded-shape number; keep verbatim otherwise (downstream schema
  // gates decide what to do with non-conforming values).
  const scnRaw = decodeXmlEntities(
    requireString(sec['SCN'], 'SCN')
      .replace(/^SECTION\s+/i, '')
      .trim()
  );
  const section = normalizeSectionNumber(scnRaw) ?? scnRaw;
```

Replace `pushSrfRefs`:

```typescript
function pushSrfRefs(raw: string, nodeId: string, refs: SecRef[]): void {
  for (const sec of extractSrfSections(raw)) {
    refs.push({
      sourceNodeId: nodeId,
      targetType: 'section',
      // Normalize-or-verbatim: a tagged ref is never rejected; exact-match
      // resolution simply won't find non-conforming targets.
      targetSpecSection: normalizeSectionNumber(sec) ?? sec,
      referenceText: stripTags(raw).slice(0, 200),
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/parser/sec/`
Expected: PASS — including pre-existing suffix-pin tests (`27 05 13.43`)

- [ ] **Step 5: Run the full unit suite and commit**

Run: `pnpm test`
Expected: PASS (517 pre-existing + all new)

```bash
git add src/parser/sec/
git commit -m "feat(parser): SEC SCN/SRF section numbers normalize to canonical expanded shape"
```

**PR 2 cut point** (~420 LOC).

---

## PR 3 — `feat(api): accept suffixed sections in schemas, parse worker, PATCH, filenames`

### Task 7: AST schemas

**Files:**
- Modify: `src/ast/schemas.ts` (lines 64-78)
- Test: `src/ast/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the relevant describe blocks in `src/ast/schemas.test.ts`:

```typescript
  it('SpecTreeSchema: accepts dotted and agency-suffixed sections', () => {
    const base = { id: '00000000-0000-4000-8000-000000000001', title: 'T', parts: [] };
    expect(SpecTreeSchema.safeParse({ ...base, section: '26 00 13.10' }).success).toBe(true);
    expect(SpecTreeSchema.safeParse({ ...base, section: '01 32 01.00 10' }).success).toBe(true);
  });

  it('SpecTreeSchema: accepts the unknown sentinel (parser output for section-less docs)', () => {
    const base = { id: '00000000-0000-4000-8000-000000000001', title: 'T', parts: [] };
    expect(SpecTreeSchema.safeParse({ ...base, section: 'unknown' }).success).toBe(true);
  });

  it('PatchSpecBodySchema: accepts suffixed sections, rejects the unknown sentinel', () => {
    expect(PatchSpecBodySchema.safeParse({ section: '26 00 13.10' }).success).toBe(true);
    expect(PatchSpecBodySchema.safeParse({ section: '01 32 01.00 10' }).success).toBe(true);
    expect(PatchSpecBodySchema.safeParse({ section: 'unknown' }).success).toBe(false);
    expect(PatchSpecBodySchema.safeParse({ section: '26 00 13.1' }).success).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/ast/schemas.test.ts`
Expected: FAIL — suffixed sections rejected by the old regex

- [ ] **Step 3: Implement**

In `src/ast/schemas.ts`, add import and replace both `section` fields:

```typescript
import { SectionNumberSchema } from '../lib/section-number.js';
```

```typescript
export const SpecTreeSchema = z.object({
  id: z.uuid(),
  // Canonical expanded shape, or the 'unknown' sentinel emitted by parsers
  // when no section number is found (content inference may fill it later).
  section: SectionNumberSchema.or(z.literal('unknown')),
  title: z.string().check(z.minLength(1)),
  parts: z.array(SpecNodeSchema),
  warnings: z.array(ParseWarningSchema).exactOptional(),
});

export const PatchSpecBodySchema = z.object({
  title: z.string().check(z.minLength(1)).exactOptional(),
  // PATCH must set a real section — the sentinel is not assignable by clients.
  section: SectionNumberSchema.exactOptional(),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/ast/schemas.test.ts`
Expected: PASS — including pre-existing malformed-rejection tests (`'27210'`)

- [ ] **Step 5: Commit**

```bash
git add src/ast/schemas.ts src/ast/schemas.test.ts
git commit -m "feat(api): AST schemas accept expanded section shapes; PATCH rejects sentinel"
```

### Task 8: Parse worker output schema + body section override

**Files:**
- Modify: `src/api/parse.ts` (workerOutputSchema line 94; `parseHandler` lines 54-71)
- Test: `src/api/parse.test.ts`

- [ ] **Step 1: Update the worker mock, then write the failing tests**

**CRITICAL pre-step:** `src/api/parse.test.ts` lines 10-16 mock `parsePool.run` to resolve
`{ tree: { id: '', section: 'test', title: 'T', parts: [] }, refs: [] }`. The tightened
schema rejects `section: 'test'` — change the mock's section to `'27 21 00'`, or the
existing async-job tests fail out-of-band:

```typescript
vi.mock('../lib/parse-pool.js', () => ({
  parsePool: {
    run: vi.fn().mockResolvedValue({
      tree: { id: '', section: '27 21 00', title: 'T', parts: [] },
      refs: [],
    }),
  },
}));
```

Then append to the `describe('parseHandler', ...)` block (mirrors the file's `makeRes()` +
literal-`Request` style; a `.txt` upload skips archive/MIME validation per `validateUpload`):

```typescript
  it('parse: dirty section override normalized before persist', async () => {
    const { persistParsedSpec } = await import('../db/index.js');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: { originalname: 'spec.txt', mimetype: 'text/plain', buffer: Buffer.from('x') },
      body: { section: '26  00 13.10' },
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
    await vi.waitFor(() => {
      expect(persistParsedSpec).toHaveBeenCalledWith(
        expect.objectContaining({ tree: expect.objectContaining({ section: '26 00 13.10' }) })
      );
    });
  });

  it('parse: malformed section override → 400 before job creation', async () => {
    const { createJob } = await import('../lib/jobs.js');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: { originalname: 'spec.txt', mimetype: 'text/plain', buffer: Buffer.from('x') },
      body: { section: '26 00 13.1' },
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid section override format' })
    );
    expect(createJob).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/api/parse.test.ts`
Expected: FAIL — override is passed through raw today (no 400, no normalization)

- [ ] **Step 3: Implement**

In `src/api/parse.ts`, add import:

```typescript
import { SectionNumberSchema, normalizeSectionNumber } from '../lib/section-number.js';
```

Tighten the worker schema (`section` line only):

```typescript
const workerOutputSchema = z.object({
  tree: z.object({
    id: z.string(),
    section: SectionNumberSchema.or(z.literal('unknown')),
    title: z.string(),
    parts: z.array(z.unknown()),
    warnings: z.array(ParseWarningSchema).optional(),
  }),
  refs: z.array(SecRefSchema).default([]),
  capabilities: z.array(z.string()).optional(),
});
```

`parseBody(req.body)` is currently called inline in the `processParseJob` dispatch — refactor minimally and immutably (full replacement handler):

```typescript
export async function parseHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const validationError = await validateUpload(req, ext);
  if (validationError !== null) {
    res.status(400).json({ success: false, error: validationError });
    return;
  }

  const rawBody = parseBody(req.body);
  const normalizedSection =
    rawBody.section !== undefined ? normalizeSectionNumber(rawBody.section) : undefined;
  if (rawBody.section !== undefined && normalizedSection === null) {
    res.status(400).json({ success: false, error: 'invalid section override format' });
    return;
  }
  const body: ParseBody = {
    ...rawBody,
    ...(normalizedSection != null ? { section: normalizedSection } : {}),
  };

  const jobId = createJob();
  // Pass buffer and ext, not the full file object, so the request closure can be GC'd
  void processParseJob(jobId, req.file.buffer, ext, body);
  res.status(202).json({ success: true, data: { jobId } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/api/parse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/parse.ts src/api/parse.test.ts
git commit -m "feat(api): parse worker schema gates expanded shapes; section override normalized, 400 on malformed"
```

### Task 9: Download filename

**Files:**
- Modify: `src/api/generate.ts` (`safeFilename`, line 9-16)
- Test: `src/api/generate.test.ts` (create if absent; check for an existing unit test file first)

- [ ] **Step 1: Write the failing test**

If `src/api/generate.test.ts` does not exist, create it; `safeFilename` is module-private, so export it for testability:

```typescript
// src/api/generate.test.ts
import { describe, it, expect } from 'vitest';
import { safeFilename } from './generate.js';

describe('safeFilename', () => {
  it('generate: filename preserves dotted suffix', () => {
    expect(safeFilename('26 00 13.10', 'Panelboards')).toBe('26-00-13.10-Panelboards.docx');
  });

  it('generate: agency form keeps dot, spaces become dashes', () => {
    expect(safeFilename('01 32 01.00 10', 'QC')).toBe('01-32-01.00-10-QC.docx');
  });

  it('generate: base form unchanged behavior', () => {
    expect(safeFilename('27 21 00', 'Structured Cabling')).toBe('27-21-00-Structured-Cabling.docx');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/api/generate.test.ts`
Expected: FAIL — `safeFilename` not exported / dot becomes dash

- [ ] **Step 3: Implement**

In `src/api/generate.ts`:

```typescript
// Exported for unit testing.
export function safeFilename(section: string, title: string): string {
  // '.' is allowed in the section part so '26 00 13.10' stays distinguishable
  // from a hypothetical '26 00 1310' in the suggested filename.
  const s = section.replace(/[^a-zA-Z0-9.-]/g, '-').replace(/-+/g, '-');
  const t = title
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return `${s}-${t}.docx`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/api/generate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/generate.ts src/api/generate.test.ts
git commit -m "fix(api): download filename preserves section dotted suffix"
```

### Task 9b: Generator suffix-safety pins (no production change)

The generator renders `tree.section` opaquely and is already suffix-safe — pin it so a future
"helpful" refactor can't regress it.

**Files:**
- Test: `src/generator/markdown.test.ts`, `src/generator/index.test.ts`

- [ ] **Step 1: Write the pin tests** (these should pass immediately — they are regression pins, not TDD reds)

Append to `src/generator/markdown.test.ts` (reuse its tree-fixture helper style):

```typescript
  it('renderMarkdown: suffixed section renders verbatim in H1', () => {
    const tree = makeTree({ section: '27 05 13.43', title: 'TV Distribution' });
    expect(renderMarkdown(tree)).toContain('# SECTION 27 05 13.43 — TV Distribution');
  });
```

Append to `src/generator/index.test.ts`:

```typescript
  it('generateDocx: agency-suffixed section survives into document.xml', async () => {
    const buffer = await generateDocx(makeTree({ section: '01 32 01.00 10', title: 'QC' }));
    const xml = await readDocumentXml(buffer); // reuse the file's existing unzip helper
    expect(xml).toContain('01 32 01.00 10');
  });
```

(Adapt fixture-builder names to each file's existing helpers — both files already construct
SpecTree fixtures inline; only the `section` value is new.)

- [ ] **Step 2: Run tests — expect immediate PASS**

Run: `pnpm test src/generator/`
Expected: PASS (pins confirm already-correct behavior)

- [ ] **Step 3: Commit**

```bash
git add src/generator/
git commit -m "test(generator): pin suffixed-section rendering in markdown H1 and DOCX title"
```

### Task 10: PATCH over HTTP (integration) + ARCHITECTURE examples

**Files:**
- Modify: `src/api/specs.integration.test.ts`
- Modify: `ARCHITECTURE.md` (lines ~228, ~265, ~347, ~417 — locate by content, not line number)

- [ ] **Step 1: Write the integration test** (runs only under `pnpm test:integration`; needs PostgreSQL via `docker compose up -d postgres`)

Append at the END of the `describe('PATCH /specs/:id (integration)', ...)` block in
`src/api/specs.integration.test.ts` — it uses `fetch` against `baseUrl` with a seeded
`testSpecId` (NOT supertest). Append last because these tests mutate the seeded spec's
section, and the earlier title-update test asserts `section === '27 21 00'`:

```typescript
  it('accepts a dotted-suffix section', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: '27 21 00.10' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect((body['data'] as Record<string, unknown>)['section']).toBe('27 21 00.10');
  });

  it('accepts an agency-suffix section', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: '27 21 00.10 20' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect((body['data'] as Record<string, unknown>)['section']).toBe('27 21 00.10 20');
  });
```

(Keep the existing `returns 422 for invalid section format` test untouched — `'27210'` must still 422.)

- [ ] **Step 2: Update ARCHITECTURE.md examples**

Find and update the four stale comments (exact current text → replacement):

1. `section: string  // CSI section number, e.g. "27 21 00"` →
   `section: string  // CSI section number, e.g. "27 21 00", "26 00 13.10", "01 32 01.00 10"`
2. `section VARCHAR(20),  -- "27 21 00"` →
   `section VARCHAR(20),  -- "27 21 00" | "26 00 13.10" | "01 32 01.00 10" (expanded shape, ADR-020)`
3. `target_spec_section VARCHAR(20),  -- "09 91 00" — for section refs` →
   `target_spec_section VARCHAR(20),  -- "09 91 00" / "26 00 13.10" — for section refs`
4. In the ref-table example row containing `See Section 09 91 00`: leave the example itself, but if a nearby comment claims the `NN NN NN` shape is the only valid form, amend it to mention expanded shapes.

- [ ] **Step 3: Run integration tests (requires DB)**

Run: `docker compose up -d postgres && pnpm migrate && pnpm seed && pnpm test:integration`
Expected: PASS (new PATCH tests + all pre-existing)

- [ ] **Step 4: Commit**

```bash
git add src/api/specs.integration.test.ts ARCHITECTURE.md
git commit -m "test(api): PATCH accepts expanded section shapes over HTTP; refresh ARCHITECTURE examples"
```

**PR 3 cut point** (~300 LOC).

---

## PR 4 — `feat(db): normalization + shape CHECK constraints migration, seed prefix tolerance`

### Task 11: Seed SCN tolerance + normalization

**Files:**
- Modify: `src/db/seed.ts` (SCN_RE line 15, `extractSectionMeta` lines 18-29)
- Test: `src/db/seed.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/db/seed.test.ts`:

```typescript
  it('seed: extractSectionMeta retains .43 suffix, division still 27', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION 27 05 13.43</SCN><STL>TV DISTRIBUTION</STL></SEC>`;
    expect(extractSectionMeta(content)).toEqual({
      sectionNumber: '27 05 13.43',
      title: 'TV DISTRIBUTION',
      division: '27',
    });
  });

  it('seed: bare SCN without SECTION prefix yields section', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>01 31 23.13 20</SCN><STL>SUSTAINABILITY REPORTING</STL></SEC>`;
    expect(extractSectionMeta(content)?.sectionNumber).toBe('01 31 23.13 20');
  });

  it('seed: whitespace dirt in SCN normalizes to canonical form', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION  26 00 13.10 </SCN><STL>X</STL></SEC>`;
    expect(extractSectionMeta(content)?.sectionNumber).toBe('26 00 13.10');
  });

  it('seed: unnormalizable SCN content is skipped (null), not seeded dirty', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION TBD</SCN><STL>X</STL></SEC>`;
    expect(extractSectionMeta(content)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/db/seed.test.ts`
Expected: FAIL — bare-SCN test returns null (prefix required today); dirty test returns dirty string

- [ ] **Step 3: Implement**

In `src/db/seed.ts`:

```typescript
import { normalizeSectionNumber } from '../lib/section-number.js';

// Prefix-optional: 2 corpus files carry a bare SCN without the 'SECTION ' keyword.
const SCN_RE = /<SCN>\s*(?:SECTION\s+)?([^<]+)<\/SCN>/i;
const STL_RE = /<STL>([^<]+)<\/STL>/;

export function extractSectionMeta(content: string): SectionRecord | null {
  const scnMatch = SCN_RE.exec(content);
  const stlMatch = STL_RE.exec(content);

  if (!scnMatch?.[1] || !stlMatch?.[1]) return null;

  // Catalog rows must be canonical — the shape CHECK constraint (migration 013)
  // enforces this at the DB layer; skipping here keeps the seed loud-and-clean.
  const sectionNumber = normalizeSectionNumber(scnMatch[1]);
  if (sectionNumber === null) return null;

  const title = stlMatch[1].trim();
  const division = sectionNumber.slice(0, 2);

  return { sectionNumber, title, division };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/db/seed.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/seed.ts src/db/seed.test.ts
git commit -m "feat(db): seed tolerates bare SCN, normalizes section numbers before upsert"
```

### Task 12: Migration 013 — normalize + CHECK constraints

**Files:**
- Create: `src/db/migrations/013_section_number_normalize_and_check.ts`
- Test: `src/db/queries/specs.integration.test.ts` (constraint behavior; integration project)

- [ ] **Step 1: Write the migration**

```typescript
// src/db/migrations/013_section_number_normalize_and_check.ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Expanded shape (ADR-020): NN NN NN | NN NN NN.NN | NN NN NN.NN NN
const SHAPE = String.raw`^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$`;

// NBSP→space, collapse whitespace runs, trim — SQL mirror of
// normalizeSectionNumber() in src/lib/section-number.ts.
const NORM = (col: string): string =>
  `btrim(regexp_replace(replace(${col}, chr(160), ' '), '\\s+', ' ', 'g'))`;

export const up = (pgm: MigrationBuilder): void => {
  // Step 1: normalize existing rows. If two rows collapse to the same key,
  // the existing UNIQUE constraints (specs_section_source_unique,
  // spec_sections_section_number_key) abort this migration loudly — by design;
  // resolve duplicates manually before re-running.
  pgm.sql(`UPDATE specs SET section = ${NORM('section')} WHERE section <> ${NORM('section')}`);
  pgm.sql(
    `UPDATE spec_sections SET section_number = ${NORM('section_number')} WHERE section_number <> ${NORM('section_number')}`
  );

  // Step 2: shape gates. specs.section additionally admits the 'unknown'
  // sentinel written by the parse path for section-less documents.
  pgm.addConstraint('specs', 'specs_section_shape_check', {
    check: `section ~ '${SHAPE}' OR section = 'unknown'`,
  });
  pgm.addConstraint('spec_sections', 'spec_sections_section_number_shape_check', {
    check: `section_number ~ '${SHAPE}'`,
  });
  // Deliberately NO constraint on spec_references.target_spec_section: it
  // records what the source document said (descriptive, not canonical).
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('spec_sections', 'spec_sections_section_number_shape_check');
  pgm.dropConstraint('specs', 'specs_section_shape_check');
  // Whitespace normalization is lossy and is not reversed.
};
```

- [ ] **Step 2: Write the failing integration tests**

Append to `src/db/queries/specs.integration.test.ts` (or the project's DB-constraint test home):

```typescript
  it('db: specs.section CHECK accepts expanded shapes and the unknown sentinel', async () => {
    await pool.query(
      `INSERT INTO specs (section, title, source) VALUES ('99 88 77.10 20', 'Shape OK', 'arcat')`
    );
    await pool.query(
      `INSERT INTO specs (section, title, source) VALUES ('unknown', 'Sentinel OK', 'arcat')`
    );
    await pool.query(
      `DELETE FROM specs WHERE section IN ('99 88 77.10 20', 'unknown') AND source = 'arcat'`
    );
  });

  it('db: specs.section CHECK rejects malformed sections', async () => {
    await expect(
      pool.query(`INSERT INTO specs (section, title, source) VALUES ('99 8877', 'Bad', 'arcat')`)
    ).rejects.toThrow(/specs_section_shape_check/);
  });

  it('db: spec_sections shape CHECK rejects the sentinel (catalog is canonical-only)', async () => {
    await expect(
      pool.query(
        `INSERT INTO spec_sections (section_number, title, division) VALUES ('unknown', 'Bad', 'un')`
      )
    ).rejects.toThrow(/spec_sections_section_number_shape_check/);
  });
```

- [ ] **Step 3: Run migration + integration tests**

```bash
docker compose up -d postgres
pnpm migrate            # applies 013
pnpm seed               # now seeds suffixed + bare-SCN catalog entries
pnpm test:integration
```
Expected: migrate applies cleanly; seed logs a HIGHER record count than before (suffixed entries now included); integration tests PASS.

Verify the seed delta explicitly:

```bash
docker compose exec postgres psql -U specr -d specr -c \
  "SELECT count(*) FILTER (WHERE section_number ~ '\\.') AS suffixed, count(*) AS total FROM spec_sections;"
```
Expected: `suffixed` ≈ 238+ (162 dotted + 76 agency, minus any duplicate SCNs), `total` ≈ 660+.

- [ ] **Step 4: Verify down-migration reversibility**

```bash
pnpm migrate:down   # drops both constraints
pnpm migrate        # re-applies
```
Expected: both run cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/013_section_number_normalize_and_check.ts src/db/queries/specs.integration.test.ts
git commit -m "feat(db): migration 013 — normalize section whitespace, add expanded-shape CHECK constraints"
```

### Task 13: End-to-end integration — agency-suffixed .SEC round trip

**Files:**
- Test: `src/lib/file-loader.integration.test.ts` (harness: `loadFiles([absolutePath])` against real corpus files, `pool` from `'../db/index.js'`, `PROJECT_ROOT` const already defined at top)

- [ ] **Step 1: Write the tests**

Append inside `describe('loadFiles() integration', ...)`:

```typescript
  const AGENCY_FIXTURE = path.join(
    PROJECT_ROOT,
    'docs/references/UFGS/DIVISION_01/01_32_01.00_10.SEC'
  );

  it('e2e: agency-suffixed corpus file loads with section intact', async () => {
    const result = await loadFiles([AGENCY_FIXTURE]);
    expect(result.succeeded).toBe(1);

    const row = await pool.query<{ section: string }>(
      `SELECT section FROM specs WHERE section = '01 32 01.00 10' AND source = 'ufgs' LIMIT 1`
    );
    expect(row.rows[0]?.section).toBe('01 32 01.00 10');
  });

  it('e2e: ref targeting an agency-suffixed section resolves by exact match', async () => {
    const { persistParsedSpec } = await import('../db/index.js');
    const target = await pool.query<{ id: string }>(
      `SELECT id FROM specs WHERE section = '01 32 01.00 10' AND source = 'ufgs' LIMIT 1`
    );
    expect(target.rows[0]?.id).toBeDefined();

    const sourceNodeId = '00000000-0000-4000-8000-00000000aaaa';
    const specId = await persistParsedSpec({
      tree: {
        id: '00000000-0000-4000-8000-00000000bbbb',
        section: '99 88 77',
        title: 'Ref Source',
        parts: [
          { id: sourceNodeId, type: 'part', text: 'See Section 01 32 01.00 10.', children: [], meta: {} },
        ],
      },
      refs: [
        {
          sourceNodeId,
          targetType: 'section',
          targetSpecSection: '01 32 01.00 10',
          referenceText: 'See Section 01 32 01.00 10.',
        },
      ],
    });

    const refRow = await pool.query<{ target_spec_id: string | null }>(
      `SELECT target_spec_id FROM spec_references WHERE source_spec_id = $1`,
      [specId]
    );
    expect(refRow.rows[0]?.target_spec_id).toBe(target.rows[0]?.id);

    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  });

  it('e2e: catalog join + division filter — suffixed section listed inDatabase for division 01', async () => {
    const { listSpecSections } = await import('../db/index.js');
    const sections = await listSpecSections('01');
    const entry = sections.find((s) => s.section === '01 32 01.00 10');
    // catalog row exists (pnpm seed) AND exact-equality join sees the loaded spec
    expect(entry).toBeDefined();
    expect(entry?.inDatabase).toBe(true);
  });
```

- [ ] **Step 2: Run integration tests**

Run: `pnpm test:integration`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A src/
git commit -m "test(integration): agency-suffixed .SEC end-to-end — parse, persist, exact-match ref resolution"
```

**PR 4 cut point** (~280 LOC).

---

## Task 14: Full verification sweep

- [ ] **Step 1: Full local gate**

```bash
pnpm lint && pnpm build && pnpm test
docker compose up -d postgres && pnpm migrate && pnpm seed && pnpm test:integration
```
Expected: all green. If `pnpm lint` flags `max-lines-per-function` on touched files, extract helpers — do not suppress rules.

- [ ] **Step 2: Corpus smoke test** — bulk-load the real UFGS corpus and confirm suffixed sections persist:

```bash
pnpm load:files 'docs/references/UFGS/DIVISION_01/01_32_01.00_10.SEC' 2>&1 | tail -3
docker compose exec postgres psql -U specr -d specr -c \
  "SELECT section, title FROM specs WHERE section = '01 32 01.00 10';"
```
Expected: one row, section intact with agency suffix.

- [ ] **Step 3: Commit any stragglers; do NOT push yet**

## Task 15: Update the parser edge-cases memory note

The session memory `project_parser_edge_cases.md` tracks open parser bugs — after this work, the suffix-truncation class is fixed; record that (done by the orchestrating session, not a subagent).

## Task 16: PR cutting (stacked)

The branch now holds 4 contiguous commit groups. Cut stacked PRs:

```bash
# identify group-boundary SHAs
git log --oneline ba99b64..HEAD

# PR 1
git branch feat/section-number-lib <sha-end-of-task-2>
git push -u origin feat/section-number-lib
gh pr create --base main --head feat/section-number-lib \
  --title "feat(lib): section-number module — expanded-shape validator + normalizer" \
  --body "<summary + test plan per CLAUDE.md>"

# PR 2 (stacked on PR 1)
git branch feat/section-number-parsers <sha-end-of-task-6>
git push -u origin feat/section-number-parsers
gh pr create --base feat/section-number-lib --head feat/section-number-parsers \
  --title "feat(parser): adopt section-number module in refs/inference/text parsers" ...

# PR 3, PR 4: same pattern, each based on the previous branch
```

After PR 1 merges, retarget PR 2's base to `main` (`gh pr edit --base main`), and so on down the stack. Each PR body needs: summary, exact test-plan commands, explicit out-of-scope note ("This PR does NOT include …" per CLAUDE.md).

**LOC-gate note for PR 1:** the branch history starts with the design spec + this plan
(~900 doc lines) which land inside PR 1's diff. `docs/superpowers/` is not in the LOC-check
exclusion list, so CI will warn. State in the PR body that the code delta is ~330 LOC and the
remainder is design/plan documentation.

---

## Self-Review Notes (already applied)

- `signals.ts` deliberately unchanged — prefix classifier already suffix-tolerant; pinned by test in Task 5.
- `SpecTreeSchema` admits `'unknown'` (deviation from the design doc's shorthand table, consistent with its migration section + worker schema — parsers legitimately emit the sentinel).
- MCP, generator, division slice/LIKE, sort order: no changes (audit: suffix-safe).
- `spec_references.target_spec_section`: intentionally unconstrained (design decision).
- Existing tests expected to keep passing without modification: rules.test.ts malformed-rejection, infer-section window/embedded tests, sec refs `27 05 13.43` pins, PATCH 422-on-malformed.
