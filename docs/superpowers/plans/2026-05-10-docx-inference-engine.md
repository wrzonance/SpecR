# Phase 1c-ii: DOCX Hierarchy Inference Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 5-signal DOCX hierarchy inference engine and `POST /parse` async endpoint that converts `.docx` and `.sec` files into a `CsiTree` stored in PostgreSQL.

**Architecture:** Two-pass inference — Pass 1 classifies each paragraph using a signal priority chain (numbering XML > style chain > text regex > indentation), Pass 2 uses a stack algorithm to assign parent/child relationships. `POST /parse` returns a job ID immediately (202); the client polls `GET /parse/jobs/:jobId` for progress.

**Tech Stack:** TypeScript strict, JSZip, fast-xml-parser, vitest, multer, pg (transactions), uuid.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/parser/docx/types.ts` | Modify | Add `ClassifiedParagraph`, `SignalConflict` types |
| `src/parser/docx/rules.ts` | Modify | Rename `MASTERSPEC_ILVL_MAP` → `CPI_ILVL_MAP` |
| `src/parser/docx/heuristics.ts` | Create | Signal 4 (text regex) + Signal 5 (indentation) |
| `src/parser/docx/heuristics.test.ts` | Create | Unit tests for both signals |
| `src/parser/docx/document.ts` | Create | Extract `DocxParagraph[]` from `word/document.xml` |
| `src/parser/docx/document.test.ts` | Create | Unit tests for paragraph extraction |
| `src/parser/docx/inference.ts` | Create | Pass 1 classifyParagraphs + Pass 2 buildTree |
| `src/parser/docx/inference.test.ts` | Create | Unit tests for both passes |
| `src/parser/docx/index.ts` | Create | DOCX orchestrator — JSZip → pipeline → CsiTree |
| `src/parser/docx/arcat.integration.test.ts` | Create | Integration tests against ARCAT fixtures |
| `src/parser/docx/cpi.integration.test.ts` | Create | Integration tests against CPI fixtures |
| `src/db/queries/specs.ts` | Modify | Add `createSpec(input, db?)` |
| `src/lib/jobs.ts` | Create | In-memory async job store |
| `src/lib/jobs.test.ts` | Create | Unit tests for job store |
| `src/api/parse.ts` | Create | POST /parse + GET /parse/jobs/:jobId handlers |
| `src/api/parse.test.ts` | Create | Unit tests for handlers |
| `src/api/router.ts` | Modify | Wire parse routes + multer |
| `src/parser/index.ts` | Modify | Export `parseDocx` |
| `src/api/parse.integration.test.ts` | Create | End-to-end test with DB |
| `scripts/parse-debug.ts` | Create | Dev tool: parse file → print tree to stdout |

---

## Task 1: Branch setup + rename MASTERSPEC_ILVL_MAP + add new types

**Files:**
- Modify: `src/parser/docx/rules.ts`
- Modify: `src/parser/docx/types.ts`

- [ ] **Step 1.1: Create branch**

```bash
git checkout -b feat/parser-docx-1c-ii
```

Expected: switches to new branch.

- [ ] **Step 1.2: Rename MASTERSPEC_ILVL_MAP → CPI_ILVL_MAP in rules.ts**

In `src/parser/docx/rules.ts`, replace lines 88–133:

```typescript
// CPI (Chatsworth Products Inc.) manufacturer specs: ilvl 1-2 reserved for Schedule/PDS.
// Article appears at ilvl 3, shifting all content tiers up by 2 vs ARCAT.
export const CPI_ILVL_MAP: readonly IlvlSignalRule[] = [
  {
    id: 'cpi-part',
    ilvl: 0,
    nodeType: 'part',
    description: 'CPI Part heading (ilvl 0 → PART N - GENERAL)',
  },
  {
    id: 'cpi-article',
    ilvl: 3,
    nodeType: 'article',
    description: 'CPI Article — ilvl 3 because ilvl 1-2 are reserved for Schedule/PDS',
  },
  {
    id: 'cpi-pr1',
    ilvl: 4,
    nodeType: 'pr1',
    description: 'CPI PR1 first paragraph tier (ilvl 4 → A. text)',
  },
  {
    id: 'cpi-pr2',
    ilvl: 5,
    nodeType: 'pr2',
    description: 'CPI PR2 second paragraph tier (ilvl 5 → 1. text)',
  },
  {
    id: 'cpi-pr3',
    ilvl: 6,
    nodeType: 'pr3',
    description: 'CPI PR3 third paragraph tier (ilvl 6 → a. text)',
  },
  {
    id: 'cpi-pr4',
    ilvl: 7,
    nodeType: 'pr4',
    description: 'CPI PR4 fourth paragraph tier (ilvl 7 → 1) text)',
  },
  {
    id: 'cpi-pr5',
    ilvl: 8,
    nodeType: 'pr5',
    description: 'CPI PR5 fifth paragraph tier (ilvl 8 → a) text)',
  },
];
```

Also update the comment on line 36 of `types.ts`:
```typescript
// ilvl at which 'article' starts: ARCAT-style=1, CPI-style=3
readonly articleIlvl: number;
```

- [ ] **Step 1.3: Verify existing tests still pass**

```bash
pnpm test src/parser/docx/rules.test.ts
```

Expected: all tests pass (no references to `MASTERSPEC_ILVL_MAP` in test files — verify with `grep MASTERSPEC src/parser/docx/rules.test.ts`).

- [ ] **Step 1.4: Add ClassifiedParagraph and SignalConflict to types.ts**

Append to end of `src/parser/docx/types.ts`:

```typescript
// ─── inference.ts output ──────────────────────────────────────────────────────

import type { NodeType } from '../../ast/types.js';

export interface SignalConflict {
  readonly signal: 1 | 2 | 3 | 4 | 5;
  readonly reportedIlvl: number;
  readonly reportedNodeType: NodeType;
}

export interface ClassifiedParagraph {
  readonly paragraph: DocxParagraph;
  // Canonical normalized ilvl: part=0, article=1, pr1=2, pr2=3, pr3=4, pr4=5, pr5=6
  readonly resolvedIlvl: number;
  readonly nodeType: NodeType;
  readonly signalUsed: 1 | 2 | 3 | 4 | 5;
  readonly conflicts: readonly SignalConflict[];
  readonly isVanish: boolean;
}
```

- [ ] **Step 1.5: Type check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/parser/docx/rules.ts src/parser/docx/types.ts
git commit -m "refactor(parser): rename MASTERSPEC_ILVL_MAP to CPI_ILVL_MAP; add ClassifiedParagraph types"
```

---

## Task 2: heuristics.ts — signals 4 and 5

**Files:**
- Create: `src/parser/docx/heuristics.ts`
- Create: `src/parser/docx/heuristics.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `src/parser/docx/heuristics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { matchTextSignal, matchIndentSignal } from './heuristics.js';

describe('matchTextSignal', () => {
  it('detects PART heading', () => {
    expect(matchTextSignal('PART 1 - GENERAL')).toEqual({ nodeType: 'part', normalizedIlvl: 0 });
  });

  it('detects article (N.N format)', () => {
    expect(matchTextSignal('1.1 REFERENCES')).toEqual({ nodeType: 'article', normalizedIlvl: 1 });
  });

  it('detects pr1 (uppercase letter)', () => {
    expect(matchTextSignal('A. Provide materials')).toEqual({ nodeType: 'pr1', normalizedIlvl: 2 });
  });

  it('detects pr2 (digit dot)', () => {
    expect(matchTextSignal('1. text here')).toEqual({ nodeType: 'pr2', normalizedIlvl: 3 });
  });

  it('detects pr3 (lowercase letter dot)', () => {
    expect(matchTextSignal('a. text here')).toEqual({ nodeType: 'pr3', normalizedIlvl: 4 });
  });

  it('detects pr4 (digit paren)', () => {
    expect(matchTextSignal('1) text here')).toEqual({ nodeType: 'pr4', normalizedIlvl: 5 });
  });

  it('detects pr5 (lowercase letter paren)', () => {
    expect(matchTextSignal('a) text here')).toEqual({ nodeType: 'pr5', normalizedIlvl: 6 });
  });

  it('does NOT match pr5 for product code with mid-word paren', () => {
    // "3i)" in a product number must not match — pattern anchored to ^
    expect(matchTextSignal('Model XR-3i) series specifications')).toBeNull();
  });

  it('does NOT match pr1 for lowercase letter dot', () => {
    // Only uppercase letters trigger pr1
    expect(matchTextSignal('a. text')).toEqual({ nodeType: 'pr3', normalizedIlvl: 4 });
  });

  it('does NOT match editorial placeholder <Insert text>', () => {
    expect(matchTextSignal('<Insert manufacturer name here>')).toBeNull();
  });

  it('returns null for text shorter than 4 characters', () => {
    expect(matchTextSignal('A.')).toBeNull();
    expect(matchTextSignal('1.')).toBeNull();
  });

  it('returns null for unmatched text', () => {
    expect(matchTextSignal('Lorem ipsum dolor sit amet')).toBeNull();
  });
});

describe('matchIndentSignal', () => {
  it('returns 0 for no indentation (part level)', () => {
    expect(matchIndentSignal(0)).toBe(0);
  });

  it('returns 1 for 576 twips (article level)', () => {
    expect(matchIndentSignal(576)).toBe(1);
  });

  it('returns 2 for 1152 twips (pr1 level)', () => {
    expect(matchIndentSignal(1152)).toBe(2);
  });

  it('returns null for undefined leftIndent', () => {
    expect(matchIndentSignal(undefined)).toBeNull();
  });

  it('returns null for ilvl > 8', () => {
    expect(matchIndentSignal(576 * 10)).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run tests — verify failure**

```bash
pnpm test src/parser/docx/heuristics.test.ts
```

Expected: FAIL — `Cannot find module './heuristics.js'`

- [ ] **Step 2.3: Implement heuristics.ts**

Create `src/parser/docx/heuristics.ts`:

```typescript
import type { NodeType } from '../../ast/types.js';

interface TextSignalEntry {
  readonly pattern: RegExp;
  readonly nodeType: NodeType;
  readonly normalizedIlvl: number;
}

// All patterns anchored to ^ — prevents mid-word matches (e.g. "3i)" in product codes).
// Ordered most-specific first: PART before article before pr1, etc.
const TEXT_SIGNALS: readonly TextSignalEntry[] = [
  { pattern: /^PART\s+\d+/i, nodeType: 'part', normalizedIlvl: 0 },
  { pattern: /^\d+\.\d+\s+/, nodeType: 'article', normalizedIlvl: 1 },
  { pattern: /^[A-Z]\.\s/, nodeType: 'pr1', normalizedIlvl: 2 },
  { pattern: /^\d+\.\s/, nodeType: 'pr2', normalizedIlvl: 3 },
  { pattern: /^[a-z]\.\s/, nodeType: 'pr3', normalizedIlvl: 4 },
  { pattern: /^\d+\)\s/, nodeType: 'pr4', normalizedIlvl: 5 },
  { pattern: /^[a-z]\)\s/, nodeType: 'pr5', normalizedIlvl: 6 },
];

const MIN_TEXT_LENGTH = 4;
const TWIPS_PER_LEVEL = 576;
const MAX_ILVL = 8;

export function matchTextSignal(
  text: string
): { readonly nodeType: NodeType; readonly normalizedIlvl: number } | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;
  for (const entry of TEXT_SIGNALS) {
    if (entry.pattern.test(trimmed)) {
      return { nodeType: entry.nodeType, normalizedIlvl: entry.normalizedIlvl };
    }
  }
  return null;
}

export function matchIndentSignal(leftIndent: number | undefined): number | null {
  if (leftIndent === undefined) return null;
  const estimated = Math.round(leftIndent / TWIPS_PER_LEVEL);
  if (estimated < 0 || estimated > MAX_ILVL) return null;
  return estimated;
}
```

- [ ] **Step 2.4: Run tests — verify pass**

```bash
pnpm test src/parser/docx/heuristics.test.ts
```

Expected: all tests pass.

- [ ] **Step 2.5: Lint check**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/parser/docx/heuristics.ts src/parser/docx/heuristics.test.ts
git commit -m "feat(parser): heuristics — signal 4 text regex + signal 5 indentation"
```

---

## Task 3: document.ts — paragraph extraction from word/document.xml

**Files:**
- Create: `src/parser/docx/document.ts`
- Create: `src/parser/docx/document.test.ts`

- [ ] **Step 3.1: Write failing tests**

Create `src/parser/docx/document.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseDocument } from './document.js';
import { emptyNumberingMap } from './numbering.js';

function makeDocXml(paragraphs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}</w:body>
</w:document>`;
}

function makePara(opts: {
  text?: string;
  styleId?: string;
  numId?: number;
  ilvl?: number;
  leftIndent?: number;
  outlineLvl?: number;
  vanish?: boolean;
}): string {
  const numPr =
    opts.numId !== undefined
      ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`
      : '';
  const pStyle = opts.styleId ? `<w:pStyle w:val="${opts.styleId}"/>` : '';
  const ind = opts.leftIndent !== undefined ? `<w:ind w:left="${opts.leftIndent}"/>` : '';
  const outlineLvl = opts.outlineLvl !== undefined ? `<w:outlineLvl w:val="${opts.outlineLvl}"/>` : '';
  const vanishRpr = opts.vanish ? '<w:rPr><w:vanish/></w:rPr>' : '';
  const pPr = `<w:pPr>${pStyle}${numPr}${ind}${outlineLvl}${vanishRpr}</w:pPr>`;
  const run = opts.text !== undefined ? `<w:r><w:t>${opts.text}</w:t></w:r>` : '';
  return `<w:p>${pPr}${run}</w:p>`;
}

describe('parseDocument', () => {
  it('extracts text from single run', () => {
    const xml = makeDocXml(makePara({ text: 'PART 1 - GENERAL' }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('PART 1 - GENERAL');
  });

  it('concatenates multiple runs', () => {
    const xml = makeDocXml(`<w:p>
      <w:r><w:t>Hello </w:t></w:r>
      <w:r><w:t>World</w:t></w:r>
    </w:p>`);
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.text).toBe('Hello World');
  });

  it('extracts styleId', () => {
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.styleId).toBe('Heading1');
  });

  it('extracts numId and ilvl from paragraph own numPr', () => {
    const xml = makeDocXml(makePara({ text: 'text', numId: 3, ilvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.numId).toBe(3);
    expect(result[0]?.ilvl).toBe(2);
  });

  it('extracts leftIndent', () => {
    const xml = makeDocXml(makePara({ text: 'text', leftIndent: 720 }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.leftIndent).toBe(720);
  });

  it('detects vanish', () => {
    const xml = makeDocXml(makePara({ text: 'hidden', vanish: true }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.isVanish).toBe(true);
  });

  it('returns isVanish false when no vanish element', () => {
    const xml = makeDocXml(makePara({ text: 'visible' }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.isVanish).toBe(false);
  });

  it('returns empty text for paragraph with no runs', () => {
    const xml = makeDocXml('<w:p><w:pPr/></w:p>');
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.text).toBe('');
  });

  it('resolves numId/ilvl from style via numberingMap.pStyleToNumId', () => {
    const numMap = {
      ...emptyNumberingMap(),
      pStyleToNumId: new Map([['Heading1', 5]]),
      pStyleToIlvl: new Map([['Heading1', 1]]),
    };
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, numMap);
    expect(result[0]?.numId).toBe(5);
    expect(result[0]?.ilvl).toBe(1);
  });

  it('paragraph own numPr overrides style-inherited numPr', () => {
    const numMap = {
      ...emptyNumberingMap(),
      pStyleToNumId: new Map([['Heading1', 5]]),
      pStyleToIlvl: new Map([['Heading1', 1]]),
    };
    // Paragraph has own numId=7, ilvl=3 — must win over style's numId=5, ilvl=1
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1', numId: 7, ilvl: 3 }));
    const result = parseDocument(xml, numMap);
    expect(result[0]?.numId).toBe(7);
    expect(result[0]?.ilvl).toBe(3);
  });

  it('throws ParserError for malformed XML', () => {
    expect(() => parseDocument('<not valid xml>', emptyNumberingMap())).toThrow();
  });

  it('decodes XML entities in text', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>&lt;Insert text here&gt;</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.text).toBe('<Insert text here>');
  });
});
```

- [ ] **Step 3.2: Run tests — verify failure**

```bash
pnpm test src/parser/docx/document.test.ts
```

Expected: FAIL — `Cannot find module './document.js'`

- [ ] **Step 3.3: Implement document.ts**

Create `src/parser/docx/document.ts`:

```typescript
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { extractAttrStr, getAttrVal, getAttrNumVal, toArray } from './xml-utils.js';
import type { DocxParagraph, NumberingMap } from './types.js';

// SECURITY TODO (issue #19): verify processEntities: false blocks XXE via DOCTYPE/ENTITY.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,  // true = decode &lt; &gt; &amp; etc. (safe — no external entity fetch)
  isArray: (name) => ['w:p', 'w:r', 'w:hyperlink'].includes(name),
});

function extractText(para: Record<string, unknown>): string {
  const directRuns = toArray(para['w:r'] as readonly unknown[] | undefined);
  const linkRuns = toArray(para['w:hyperlink'] as readonly unknown[] | undefined).flatMap(
    (h) => toArray((h as Record<string, unknown>)['w:r'] as readonly unknown[] | undefined)
  );
  return [...directRuns, ...linkRuns]
    .map((run) => {
      const r = run as Record<string, unknown>;
      const t = r['w:t'];
      if (typeof t === 'string') return t;
      if (typeof t === 'object' && t !== null && '#text' in (t as object)) {
        return String((t as Record<string, unknown>)['#text'] ?? '');
      }
      return '';
    })
    .join('');
}

function parseParagraph(
  raw: Record<string, unknown>,
  numberingMap: NumberingMap
): DocxParagraph {
  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;

  const styleVal = pPr ? getAttrVal(pPr['w:pStyle']) : '';
  const styleId = styleVal || undefined;

  // Paragraph's own w:numPr takes precedence over style-inherited numPr.
  const ownNumPr = pPr?.['w:numPr'] as Record<string, unknown> | undefined;
  let numId: number | undefined;
  let ilvl: number | undefined;

  if (ownNumPr) {
    numId = getAttrNumVal(ownNumPr['w:numId']);
    ilvl = getAttrNumVal(ownNumPr['w:ilvl']);
  } else if (styleId) {
    const inherited = numberingMap.pStyleToNumId.get(styleId);
    if (inherited !== undefined) {
      numId = inherited;
      ilvl = numberingMap.pStyleToIlvl.get(styleId);
    }
  }

  const ind = pPr?.['w:ind'] as Record<string, unknown> | undefined;
  const leftStr = ind ? extractAttrStr(ind, '@_w:left') : '';
  const leftIndent = leftStr ? parseInt(leftStr, 10) : undefined;

  const outlineLvlStr = pPr ? getAttrVal(pPr['w:outlineLvl']) : '';
  const outlineLvl = outlineLvlStr ? parseInt(outlineLvlStr, 10) : undefined;

  const pRpr = pPr?.['w:rPr'] as Record<string, unknown> | undefined;
  const isVanish = 'w:vanish' in (pRpr ?? {});

  return {
    text: extractText(raw),
    ...(styleId !== undefined ? { styleId } : {}),
    ...(numId !== undefined ? { numId } : {}),
    ...(ilvl !== undefined ? { ilvl } : {}),
    ...(leftIndent !== undefined && !isNaN(leftIndent) ? { leftIndent } : {}),
    ...(outlineLvl !== undefined && !isNaN(outlineLvl) ? { outlineLvl } : {}),
    isVanish,
  };
}

export function parseDocument(xml: string, numberingMap: NumberingMap): DocxParagraph[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/document.xml', { cause: err });
  }

  const doc = (parsed as Record<string, unknown>)['w:document'] as
    | Record<string, unknown>
    | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  if (!body) throw new ParserError('word/document.xml missing w:body element');

  return toArray(body['w:p'] as readonly unknown[] | undefined)
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => parseParagraph(p, numberingMap));
}
```

- [ ] **Step 3.4: Run tests — verify pass**

```bash
pnpm test src/parser/docx/document.test.ts
```

Expected: all tests pass.

- [ ] **Step 3.5: Lint check**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/parser/docx/document.ts src/parser/docx/document.test.ts
git commit -m "feat(parser): document.ts — extract DocxParagraph[] from word/document.xml"
```

---

## Task 4: inference.ts — Pass 1: classifyParagraphs

**Files:**
- Create: `src/parser/docx/inference.ts` (partial — pass 1 only)
- Create: `src/parser/docx/inference.test.ts` (pass 1 tests)

- [ ] **Step 4.1: Write failing tests for classifyParagraphs**

Create `src/parser/docx/inference.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyParagraphs } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { DocxParagraph, NumberingMap, StyleMap } from './types.js';

function emptyStyleMap(): StyleMap {
  return {
    styles: new Map(),
    resolvedNumPr: new Map(),
  };
}

function makePara(overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return {
    text: '',
    isVanish: false,
    ...overrides,
  };
}

const defaultNumberingMap = (articleIlvl = 1): NumberingMap => ({
  ...emptyNumberingMap(),
  articleIlvl,
});

describe('classifyParagraphs — Pass 1', () => {
  it('signal 1: classifies via own numId+ilvl (ARCAT-style)', () => {
    const paras = [makePara({ numId: 1, ilvl: 0 })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), emptyStyleMap());
    expect(result[0]?.nodeType).toBe('part');
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.resolvedIlvl).toBe(0);
  });

  it('signal 1: maps CPI ilvl=3 to article when articleIlvl=3', () => {
    const paras = [makePara({ numId: 1, ilvl: 3 })];
    const result = classifyParagraphs(paras, defaultNumberingMap(3), emptyStyleMap());
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.resolvedIlvl).toBe(1); // normalized
    expect(result[0]?.signalUsed).toBe(1);
  });

  it('signal 1: numId=0 does NOT fire signal 1 (OOXML suppress sentinel)', () => {
    const paras = [makePara({ numId: 0, ilvl: 2, text: 'A. text here' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), emptyStyleMap());
    // numId=0 suppresses; should fall through to signal 4 (text)
    expect(result[0]?.signalUsed).toBe(4);
    expect(result[0]?.nodeType).toBe('pr1');
  });

  it('signal 2: classifies via style chain resolvedNumPr', () => {
    const styleMap: StyleMap = {
      styles: new Map([['Heading1', { styleId: 'Heading1', name: 'heading 1' }]]),
      resolvedNumPr: new Map([['Heading1', { numId: 1, ilvl: 0 }]]),
    };
    const paras = [makePara({ styleId: 'Heading1', text: 'PART 1' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), styleMap);
    expect(result[0]?.nodeType).toBe('part');
    expect(result[0]?.signalUsed).toBe(2);
  });

  it('signal 2: suppressesNumbering style does NOT fire signal 2', () => {
    const styleMap: StyleMap = {
      styles: new Map([
        ['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', suppressesNumbering: true }],
      ]),
      resolvedNumPr: new Map([['PR1lc', { numId: 1, ilvl: 4 }]]),
    };
    const paras = [makePara({ styleId: 'PR1lc', text: 'Continuation text here.' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(3), styleMap);
    // suppressesNumbering blocks signal 2; text doesn't match anchored patterns → continuation
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('signal 1 wins over signal 2 when both fire', () => {
    const styleMap: StyleMap = {
      styles: new Map([['Heading2', { styleId: 'Heading2', name: 'heading 2' }]]),
      resolvedNumPr: new Map([['Heading2', { numId: 1, ilvl: 1 }]]), // article per style
    };
    // Own numPr says ilvl=2 (pr1) — signal 1 should win
    const paras = [makePara({ numId: 1, ilvl: 2, styleId: 'Heading2' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), styleMap);
    expect(result[0]?.nodeType).toBe('pr1');
    expect(result[0]?.signalUsed).toBe(1);
    // Signal 2 disagreed — should be in conflicts
    expect(result[0]?.conflicts).toHaveLength(1);
    expect(result[0]?.conflicts[0]?.signal).toBe(2);
    expect(result[0]?.conflicts[0]?.reportedNodeType).toBe('article');
  });

  it('signal 4: classifies via text regex when signals 1+2 absent', () => {
    const paras = [makePara({ text: 'A. First paragraph of content' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), emptyStyleMap());
    expect(result[0]?.nodeType).toBe('pr1');
    expect(result[0]?.signalUsed).toBe(4);
  });

  it('signal 5: classifies via indentation when signals 1+2+4 absent', () => {
    const paras = [makePara({ leftIndent: 576, text: 'Lorem ipsum dolor sit amet.' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), emptyStyleMap());
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(5);
  });

  it('continuation: no signal fires → nodeType continuation, signalUsed 3', () => {
    const paras = [makePara({ text: 'Some plain paragraph text.' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), emptyStyleMap());
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('vanish paragraph: isVanish propagated', () => {
    const paras = [makePara({ numId: 1, ilvl: 0, isVanish: true })];
    const result = classifyParagraphs(paras, defaultNumberingMap(1), emptyStyleMap());
    expect(result[0]?.isVanish).toBe(true);
    expect(result[0]?.nodeType).toBe('part'); // nodeType set by signals; pass 2 overrides to 'note'
  });

  it('CPI regression: PR1lc numId=0 classified as continuation not pr1', () => {
    // MASTERSPEC/CPI continuation style: numId=0 suppresses numbering.
    // Must NOT be classified as pr1 even though resolved style chain says pr1.
    const styleMap: StyleMap = {
      styles: new Map([
        ['PR1', { styleId: 'PR1', name: 'PR1' }],
        ['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', suppressesNumbering: true, basedOn: 'PR1' }],
      ]),
      resolvedNumPr: new Map([
        ['PR1', { numId: 2, ilvl: 4 }],
        // PR1lc has suppressesNumbering=true, so resolvedNumPr entry must not be used
      ]),
    };
    const paras = [makePara({ styleId: 'PR1lc', text: 'This continues the paragraph above.' })];
    const result = classifyParagraphs(paras, defaultNumberingMap(3), styleMap);
    expect(result[0]?.nodeType).toBe('continuation');
  });
});
```

- [ ] **Step 4.2: Run tests — verify failure**

```bash
pnpm test src/parser/docx/inference.test.ts
```

Expected: FAIL — `Cannot find module './inference.js'`

- [ ] **Step 4.3: Implement classifyParagraphs in inference.ts**

Create `src/parser/docx/inference.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { ilvlToNodeType } from './rules.js';
import { matchTextSignal, matchIndentSignal } from './heuristics.js';
import type { ClassifiedParagraph, DocxParagraph, NumberingMap, SignalConflict, StyleMap } from './types.js';
import type { CsiNode, CsiTree, NodeType } from '../../ast/types.js';

// Canonical normalized ilvl: part=0, article=1, pr1=2, pr2=3, pr3=4, pr4=5, pr5=6
const NODE_TYPE_TO_NORMALIZED: Partial<Record<NodeType, number>> = {
  part: 0,
  article: 1,
  pr1: 2,
  pr2: 3,
  pr3: 4,
  pr4: 5,
  pr5: 6,
};

function toNormalizedIlvl(nodeType: NodeType): number {
  return NODE_TYPE_TO_NORMALIZED[nodeType] ?? 0;
}

interface SignalHit {
  readonly nodeType: NodeType;
  readonly normalizedIlvl: number;
  readonly signal: 1 | 2 | 3 | 4 | 5;
}

function trySignal1(para: DocxParagraph, numberingMap: NumberingMap): SignalHit | null {
  if (para.numId === undefined || para.numId === 0) return null;
  if (para.ilvl === undefined) return null;
  const nodeType = ilvlToNodeType(para.ilvl, numberingMap.articleIlvl);
  if (nodeType === 'continuation') return null;
  return { nodeType, normalizedIlvl: toNormalizedIlvl(nodeType), signal: 1 };
}

function trySignal2(para: DocxParagraph, styleMap: StyleMap, numberingMap: NumberingMap): SignalHit | null {
  if (!para.styleId) return null;
  const styleInfo = styleMap.styles.get(para.styleId);
  if (styleInfo?.suppressesNumbering) return null;
  const resolved = styleMap.resolvedNumPr.get(para.styleId);
  if (!resolved) return null;
  const nodeType = ilvlToNodeType(resolved.ilvl, numberingMap.articleIlvl);
  if (nodeType === 'continuation') return null;
  return { nodeType, normalizedIlvl: toNormalizedIlvl(nodeType), signal: 2 };
}

function trySignal4(para: DocxParagraph): SignalHit | null {
  const match = matchTextSignal(para.text);
  if (!match) return null;
  return { nodeType: match.nodeType, normalizedIlvl: match.normalizedIlvl, signal: 4 };
}

function trySignal5(para: DocxParagraph): SignalHit | null {
  const estimated = matchIndentSignal(para.leftIndent);
  if (estimated === null) return null;
  const nodeTypes: NodeType[] = ['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5'];
  const nodeType = nodeTypes[estimated];
  if (!nodeType) return null;
  return { nodeType, normalizedIlvl: estimated, signal: 5 };
}

export function classifyParagraphs(
  paragraphs: readonly DocxParagraph[],
  numberingMap: NumberingMap,
  styleMap: StyleMap
): ClassifiedParagraph[] {
  let prevNonContIlvl = 0;

  return paragraphs.map((para): ClassifiedParagraph => {
    const hits: SignalHit[] = [];

    const s1 = trySignal1(para, numberingMap);
    if (s1) hits.push(s1);

    const s2 = trySignal2(para, styleMap, numberingMap);
    if (s2) hits.push(s2);

    const s4 = trySignal4(para);
    if (s4) hits.push(s4);

    const s5 = trySignal5(para);
    if (s5) hits.push(s5);

    if (hits.length === 0) {
      return {
        paragraph: para,
        resolvedIlvl: prevNonContIlvl,
        nodeType: 'continuation',
        signalUsed: 3,
        conflicts: [],
        isVanish: para.isVanish,
      };
    }

    const winner = hits[0]!;
    const conflicts: SignalConflict[] = hits
      .slice(1)
      .filter((h) => h.nodeType !== winner.nodeType)
      .map((h) => ({
        signal: h.signal,
        reportedIlvl: h.normalizedIlvl,
        reportedNodeType: h.nodeType,
      }));

    prevNonContIlvl = winner.normalizedIlvl;

    return {
      paragraph: para,
      resolvedIlvl: winner.normalizedIlvl,
      nodeType: winner.nodeType,
      signalUsed: winner.signal,
      conflicts,
      isVanish: para.isVanish,
    };
  });
}

// buildTree is added in Task 5
export function buildTree(
  _classified: readonly ClassifiedParagraph[],
  _section: string,
  _title: string,
  _source: 'arcat' | 'cpi' | 'unknown'
): CsiTree {
  throw new Error('buildTree not yet implemented');
}
```

- [ ] **Step 4.4: Run tests — verify pass**

```bash
pnpm test src/parser/docx/inference.test.ts
```

Expected: all pass (buildTree tests will be added in Task 5).

- [ ] **Step 4.5: Lint**

```bash
pnpm lint
```

Expected: no errors. (The unused imports for `uuidv4`, `CsiNode`, `CsiTree` will be resolved in Task 5.)

- [ ] **Step 4.6: Commit**

```bash
git add src/parser/docx/inference.ts src/parser/docx/inference.test.ts
git commit -m "feat(parser): inference pass 1 — 5-signal classifyParagraphs"
```

---

## Task 5: inference.ts — Pass 2: buildTree

**Files:**
- Modify: `src/parser/docx/inference.ts`
- Modify: `src/parser/docx/inference.test.ts`

- [ ] **Step 5.1: Add failing tests for buildTree**

Append to `src/parser/docx/inference.test.ts`:

```typescript
import { buildTree } from './inference.js';

describe('buildTree — Pass 2', () => {
  function makeClassified(nodeType: NodeType, normalizedIlvl: number, text = ''): ClassifiedParagraph {
    return {
      paragraph: { text, isVanish: false },
      resolvedIlvl: normalizedIlvl,
      nodeType,
      signalUsed: 1,
      conflicts: [],
      isVanish: false,
    };
  }

  it('builds single part node as root', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const tree = buildTree(classified, '01 10 00', 'Title', 'arcat');
    expect(tree.parts).toHaveLength(1);
    expect(tree.parts[0]?.type).toBe('part');
    expect(tree.parts[0]?.text).toBe('PART 1');
    expect(tree.section).toBe('01 10 00');
    expect(tree.title).toBe('Title');
  });

  it('nests article under part', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1 SUMMARY'),
    ];
    const tree = buildTree(classified, '01 10 00', 'T', 'arcat');
    expect(tree.parts[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[0]?.type).toBe('article');
  });

  it('nests pr1 under article', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr1', 2, 'A. text'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[0]?.children[0]?.type).toBe('pr1');
  });

  it('handles multiple parts at root level', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('part', 0, 'PART 2'),
      makeClassified('part', 0, 'PART 3'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts).toHaveLength(3);
  });

  it('handles ilvl jump forward > 1 (no synthetic nodes)', () => {
    // Part directly contains pr1 (skipped article level — author error)
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('pr1', 2, 'A. text'),  // ilvl jumps from 0 to 2
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[0]?.type).toBe('pr1');
  });

  it('handles ilvl stepping back (sibling article)', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr1', 2, 'A. text'),
      makeClassified('article', 1, '1.2'),  // back to article level
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children).toHaveLength(2); // two articles
    expect(tree.parts[0]?.children[0]?.children).toHaveLength(1); // pr1 under 1.1
    expect(tree.parts[0]?.children[1]?.children).toHaveLength(0); // 1.2 has no children
  });

  it('attaches continuation to last non-continuation paragraph', () => {
    const makeContd = (text = 'cont'): ClassifiedParagraph => ({
      paragraph: { text, isVanish: false },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      isVanish: false,
    });

    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr1', 2, 'A. text'),
      makeContd('continuation of A.'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const pr1 = tree.parts[0]?.children[0]?.children[0];
    expect(pr1?.children).toHaveLength(1);
    expect(pr1?.children[0]?.type).toBe('continuation');
  });

  it('assigns UUIDs to all nodes', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.id).toMatch(/^[\da-f-]{36}$/);
    expect(tree.parts[0]?.id).toMatch(/^[\da-f-]{36}$/);
  });

  it('sets meta.source from source parameter', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const tree = buildTree(classified, '01', 'T', 'cpi');
    expect(tree.parts[0]?.meta.source).toBe('cpi');
  });

  it('overrides nodeType to note for vanish paragraphs', () => {
    const vanish: ClassifiedParagraph = {
      paragraph: { text: 'hidden note', isVanish: true },
      resolvedIlvl: 1,
      nodeType: 'article',
      signalUsed: 1,
      conflicts: [],
      isVanish: true,
    };
    const classified = [makeClassified('part', 0, 'PART 1'), vanish];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.type).toBe('note');
    expect(tree.parts[0]?.children[0]?.meta.vanish).toBe(true);
  });
});
```

Add `ClassifiedParagraph` and `NodeType` to the import line at the top of the test file:

```typescript
import type { ClassifiedParagraph, DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { NodeType } from '../../ast/types.js';
```

- [ ] **Step 5.2: Run tests — verify buildTree tests fail**

```bash
pnpm test src/parser/docx/inference.test.ts
```

Expected: buildTree tests FAIL with `buildTree not yet implemented`.

- [ ] **Step 5.3: Implement buildTree in inference.ts**

Replace the stub `buildTree` at the bottom of `src/parser/docx/inference.ts` with:

```typescript
type StackEntry = { readonly cp: ClassifiedParagraph; readonly children: CsiNode[] };

function makeNode(
  cp: ClassifiedParagraph,
  children: CsiNode[],
  source: 'arcat' | 'cpi' | 'unknown'
): CsiNode {
  return {
    id: uuidv4(),
    type: cp.isVanish ? 'note' : cp.nodeType,
    text: cp.paragraph.text,
    children,
    meta: {
      source,
      ...(cp.isVanish ? { vanish: true } : {}),
    },
  };
}

export function buildTree(
  classified: readonly ClassifiedParagraph[],
  section: string,
  title: string,
  source: 'arcat' | 'cpi' | 'unknown'
): CsiTree {
  const roots: CsiNode[] = [];
  const stack: StackEntry[] = [];
  // Target for continuation paragraphs — defaults to roots when stack is empty
  let lastNonContChildren: CsiNode[] = roots;

  for (const cp of classified) {
    if (cp.nodeType === 'continuation') {
      lastNonContChildren.push({
        id: uuidv4(),
        type: 'continuation',
        text: cp.paragraph.text,
        children: [],
        meta: { source },
      });
      continue;
    }

    // Pop stack entries with resolvedIlvl >= current (they are closed siblings/children)
    while (stack.length > 0 && stack[stack.length - 1]!.cp.resolvedIlvl >= cp.resolvedIlvl) {
      const popped = stack.pop()!;
      const node = makeNode(popped.cp, popped.children, source);
      const parentChildren = stack.length > 0 ? stack[stack.length - 1]!.children : roots;
      parentChildren.push(node);
    }

    const entry: StackEntry = { cp, children: [] };
    stack.push(entry);
    lastNonContChildren = entry.children;
  }

  // Drain remaining stack entries
  while (stack.length > 0) {
    const popped = stack.pop()!;
    const node = makeNode(popped.cp, popped.children, source);
    const parentChildren = stack.length > 0 ? stack[stack.length - 1]!.children : roots;
    parentChildren.push(node);
  }

  return { id: uuidv4(), section, title, parts: roots };
}
```

- [ ] **Step 5.4: Run all inference tests — verify pass**

```bash
pnpm test src/parser/docx/inference.test.ts
```

Expected: all tests pass.

- [ ] **Step 5.5: Lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 5.6: Commit**

```bash
git add src/parser/docx/inference.ts src/parser/docx/inference.test.ts
git commit -m "feat(parser): inference pass 2 — stack-based buildTree"
```

---

## Task 6: createSpec — add to db/queries/specs.ts

**Files:**
- Modify: `src/db/queries/specs.ts`

- [ ] **Step 6.1: Write failing test**

Append to `src/api/specs.integration.test.ts` (existing file):

Actually, add a new test file `src/db/queries/specs.integration.test.ts` — verify it passes before running it. But since DB integration tests use PostgreSQL, run `pnpm test:integration` with this file specifically.

Create `src/db/queries/specs.integration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';

afterEach(async () => {
  await pool.query('DELETE FROM specs WHERE section = $1', ['99 00 00']);
});

describe('createSpec', () => {
  it('inserts a spec row and returns the UUID', async () => {
    const id = await createSpec({ section: '99 00 00', title: 'Test Spec', source: 'arcat' });
    expect(id).toMatch(/^[\da-f-]{36}$/);

    const result = await pool.query('SELECT id, section, title, source FROM specs WHERE id = $1', [id]);
    expect(result.rows[0]).toMatchObject({ section: '99 00 00', title: 'Test Spec', source: 'arcat' });
  });
});
```

- [ ] **Step 6.2: Run test — verify failure**

```bash
pnpm test:integration src/db/queries/specs.integration.test.ts
```

Expected: FAIL — `createSpec is not a function` or similar.

- [ ] **Step 6.3: Implement createSpec**

Add to `src/db/queries/specs.ts` (after the existing imports, add the `Queryable` interface and `createSpec`):

```typescript
interface Queryable {
  query: Pool['query'];
}
```

Add the import `import type { Pool } from 'pg';` at the top.

Then add `createSpec` before `findSpecById`:

```typescript
export interface CreateSpecInput {
  readonly section: string;
  readonly title: string;
  readonly source: string;
}

export async function createSpec(input: CreateSpecInput, db: Queryable = pool): Promise<string> {
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO specs (section, title, source)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.section, input.title, input.source]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createSpec: no row returned');
    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create spec', { cause: err });
  }
}
```

Export from `src/db/index.ts` by adding to the `export` block:
```typescript
export { createSpec } from './queries/specs.js';
export type { CreateSpecInput } from './queries/specs.js';
```

- [ ] **Step 6.4: Run test — verify pass**

```bash
pnpm test:integration src/db/queries/specs.integration.test.ts
```

Expected: passes.

- [ ] **Step 6.5: Commit**

```bash
git add src/db/queries/specs.ts src/db/index.ts src/db/queries/specs.integration.test.ts
git commit -m "feat(db): createSpec query for transactional spec insertion"
```

---

## Task 7: src/lib/jobs.ts — in-memory async job store

**Files:**
- Create: `src/lib/jobs.ts`
- Create: `src/lib/jobs.test.ts`

- [ ] **Step 7.1: Write failing tests**

Create `src/lib/jobs.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createJob, updateJob, getJob } from './jobs.js';

describe('jobs', () => {
  it('createJob returns a UUID string', () => {
    const jobId = createJob();
    expect(jobId).toMatch(/^[\da-f-]{36}$/);
  });

  it('new job has status queued and pct 0', () => {
    const jobId = createJob();
    const job = getJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.progress.pct).toBe(0);
  });

  it('updateJob updates status', () => {
    const jobId = createJob();
    updateJob(jobId, { status: 'running' });
    expect(getJob(jobId)?.status).toBe('running');
  });

  it('updateJob updates stage and pct', () => {
    const jobId = createJob();
    updateJob(jobId, { stage: 'classifying', pct: 75 });
    expect(getJob(jobId)?.progress).toEqual({ stage: 'classifying', pct: 75 });
  });

  it('updateJob sets result', () => {
    const jobId = createJob();
    const result = { specId: 'abc', section: '01 10 00', title: 'T', nodeCount: 42 };
    updateJob(jobId, { status: 'complete', result });
    const job = getJob(jobId);
    expect(job?.result).toEqual(result);
    expect(job?.status).toBe('complete');
  });

  it('updateJob sets error', () => {
    const jobId = createJob();
    updateJob(jobId, { status: 'failed', error: 'boom' });
    expect(getJob(jobId)?.error).toBe('boom');
  });

  it('getJob returns undefined for unknown jobId', () => {
    expect(getJob('nonexistent-id')).toBeUndefined();
  });

  it('updateJob on unknown jobId is a no-op', () => {
    expect(() => updateJob('nonexistent', { status: 'running' })).not.toThrow();
  });
});
```

- [ ] **Step 7.2: Run tests — verify failure**

```bash
pnpm test src/lib/jobs.test.ts
```

Expected: FAIL — `Cannot find module './jobs.js'`

- [ ] **Step 7.3: Implement jobs.ts**

Create `src/lib/jobs.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';

export type ParseStage =
  | 'queued'
  | 'extracting'
  | 'numbering'
  | 'styles'
  | 'document'
  | 'classifying'
  | 'persisting'
  | 'complete'
  | 'failed';

export interface ParseJobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
}

export interface ParseJob {
  readonly jobId: string;
  readonly status: ParseStage;
  readonly progress: { readonly stage: ParseStage; readonly pct: number };
  readonly result?: ParseJobResult;
  readonly error?: string;
  readonly expiresAt: number;
}

const jobs = new Map<string, ParseJob>();
const JOB_TTL_MS = 3_600_000; // 1 hour

export function createJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'queued',
    progress: { stage: 'queued', pct: 0 },
    expiresAt: Date.now() + JOB_TTL_MS,
  });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS).unref();
  return jobId;
}

export function updateJob(
  jobId: string,
  update: {
    readonly status?: ParseStage;
    readonly stage?: ParseStage;
    readonly pct?: number;
    readonly result?: ParseJobResult;
    readonly error?: string;
  }
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.set(jobId, {
    ...job,
    ...(update.status !== undefined ? { status: update.status } : {}),
    progress: {
      stage: update.stage ?? job.progress.stage,
      pct: update.pct ?? job.progress.pct,
    },
    ...(update.result !== undefined ? { result: update.result } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
  });
}

export function getJob(jobId: string): ParseJob | undefined {
  return jobs.get(jobId);
}
```

- [ ] **Step 7.4: Run tests — verify pass**

```bash
pnpm test src/lib/jobs.test.ts
```

Expected: all pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/lib/jobs.ts src/lib/jobs.test.ts
git commit -m "feat(lib): in-memory async job store for parse progress tracking"
```

---

## Task 8: src/parser/docx/index.ts — DOCX orchestrator

**Files:**
- Create: `src/parser/docx/index.ts`
- Modify: `src/parser/index.ts`

- [ ] **Step 8.1: Implement DOCX orchestrator**

Create `src/parser/docx/index.ts`:

```typescript
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { buildNumberingMap, emptyNumberingMap } from './numbering.js';
import { buildStyleMap } from './styles.js';
import { parseDocument } from './document.js';
import { classifyParagraphs, buildTree } from './inference.js';
import type { CsiTree } from '../../ast/types.js';

// SECURITY TODO (issue #19): add uncompressed size check after JSZip.loadAsync —
// reject if total uncompressed bytes > 50MB to prevent ZIP bomb exhaustion.

const coreParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function parseCoreMetadata(xml: string): { section: string; title: string } {
  try {
    const parsed = coreParser.parse(xml) as Record<string, unknown>;
    const props = parsed['cp:coreProperties'] as Record<string, unknown> | undefined;
    const subject = props?.['dc:subject'];
    const titleVal = props?.['dc:title'];
    return {
      section: typeof subject === 'string' && subject.trim() ? subject.trim() : 'unknown',
      title: typeof titleVal === 'string' && titleVal.trim() ? titleVal.trim() : 'unknown',
    };
  } catch {
    return { section: 'unknown', title: 'unknown' };
  }
}

export async function parseDocx(
  buffer: Buffer,
  onProgress?: (stage: string, pct: number) => void
): Promise<CsiTree> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParserError('failed to read DOCX archive', { cause: err });
  }

  onProgress?.('extracting', 10);

  const read = async (name: string): Promise<string | null> => {
    const file = zip.file(name);
    return file ? file.async('string') : null;
  };

  const [numberingXml, stylesXml, documentXml, coreXml] = await Promise.all([
    read('word/numbering.xml'),
    read('word/styles.xml'),
    read('word/document.xml'),
    read('docProps/core.xml'),
  ]);

  if (!stylesXml) throw new ParserError('DOCX missing word/styles.xml');
  if (!documentXml) throw new ParserError('DOCX missing word/document.xml');

  onProgress?.('numbering', 25);
  const numberingMap = numberingXml ? buildNumberingMap(numberingXml) : emptyNumberingMap();

  onProgress?.('styles', 40);
  const styleMap = buildStyleMap(stylesXml);

  onProgress?.('document', 55);
  const paragraphs = parseDocument(documentXml, numberingMap);

  if (paragraphs.length === 0) {
    throw new ParserError('document contains no paragraphs');
  }

  onProgress?.('classifying', 75);
  const classified = classifyParagraphs(paragraphs, numberingMap, styleMap);

  const source =
    numberingMap.articleIlvl === 1 ? 'arcat'
    : numberingMap.articleIlvl === 3 ? 'cpi'
    : ('unknown' as const);

  const { section, title } = coreXml ? parseCoreMetadata(coreXml) : { section: 'unknown', title: 'unknown' };

  onProgress?.('complete', 100);
  return buildTree(classified, section, title, source);
}
```

- [ ] **Step 8.2: Export parseDocx from parser/index.ts**

Replace `src/parser/index.ts` contents with:

```typescript
export { parseSec } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx } from './docx/index.js';
export { ParserError } from './error.js';
// SecRef is exported from ast/index.ts
```

- [ ] **Step 8.3: Type check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8.4: Commit**

```bash
git add src/parser/docx/index.ts src/parser/index.ts
git commit -m "feat(parser): DOCX orchestrator — JSZip pipeline wiring"
```

---

## Task 9: scripts/parse-debug.ts — dev inspection tool

**Files:**
- Create: `scripts/parse-debug.ts`

- [ ] **Step 9.1: Create debug script**

Create `scripts/parse-debug.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from '../src/parser/docx/index.js';
import type { CsiNode } from '../src/ast/types.js';

const filePath = process.argv[2];
if (!filePath) {
  process.stderr.write('Usage: pnpm tsx scripts/parse-debug.ts <file.docx>\n');
  process.exit(1);
}

function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

function printTree(nodes: readonly CsiNode[], depth = 0): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth);
    const preview = node.text.slice(0, 55).replace(/\n/g, ' ');
    const label = `[${node.type}, sig:${String(node.meta.source ?? '?')}]`;
    process.stdout.write(`${indent}${preview.padEnd(58)}${label}\n`);
    printTree(node.children, depth + 1);
  }
}

async function main(): Promise<void> {
  const buffer = readFileSync(resolve(filePath));
  const tree = await parseDocx(buffer);
  const nodeCount = countNodes(tree.parts);

  process.stdout.write(`\nParsed:  ${tree.section} — ${tree.title}\n`);
  process.stdout.write(`Source:  ${tree.parts[0]?.meta.source ?? 'unknown'}\n`);
  process.stdout.write(`Nodes:   ${nodeCount}\n\n`);
  printTree(tree.parts);
  process.stdout.write('\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 9.2: Smoke test against one ARCAT fixture**

```bash
pnpm tsx scripts/parse-debug.ts docs/references/ARCAT/01_10_00arc.docx
```

Expected: tree printed to stdout with `Source: arcat`, node count > 0, hierarchical structure visible.

- [ ] **Step 9.3: Smoke test against one CPI fixture**

```bash
pnpm tsx scripts/parse-debug.ts "docs/references/MANUFACTURER_CPI/CPI_BUSBAR_CSIMFS.docx"
```

Expected: `Source: cpi`, continuation nodes present, no `pr1` nodes where `PR1lc` style is expected.

- [ ] **Step 9.4: Commit**

```bash
git add scripts/parse-debug.ts
git commit -m "chore(scripts): parse-debug — inspect DOCX tree without server or DB"
```

---

## Task 10: ARCAT and CPI integration tests (no DB)

**Files:**
- Create: `src/parser/docx/arcat.integration.test.ts`
- Create: `src/parser/docx/cpi.integration.test.ts`

- [ ] **Step 10.1: Create ARCAT integration tests**

Create `src/parser/docx/arcat.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import type { CsiNode } from '../../ast/types.js';

const ARCAT_DIR = resolve('docs/references/ARCAT');

function allNodes(nodes: readonly CsiNode[]): CsiNode[] {
  return [...nodes, ...nodes.flatMap((n) => allNodes(n.children))];
}

const ARCAT_FIXTURES = [
  '01_10_00arc.docx',
  '02_41_16arc.docx',
  '03_45_00dvp.docx',
  '04_21_00bbc.docx',
  '05_21_00vrc.docx',
  '05_31_13mil.docx',
  '06_05_73.13aww.docx',
  '06_13_00dlc.docx',
  '07_21_00ksp.docx',
  '07_40_00evr.docx',
  '08_71_00hco.docx',
  '09_21_16.23arc.docx',
  '10_14_00gem.docx',
  '10_26_41wci.docx',
  '11_12_00ame.docx',
  '11_12_33dki.docx',
  '11_53_00nle.docx',
  '25_00_00dlt.docx',
  '26_09_33.docx',
  '28_13_53.11aic.docx',
  '28_23_00vii.docx',
  '33_05_97trt.docx',
  '40_13_00nfb.docx',
];

describe('ARCAT fixture parsing', () => {
  for (const fixture of ARCAT_FIXTURES) {
    it(`${fixture}: parses successfully with source=arcat`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      expect(tree.parts.length).toBeGreaterThan(0);
      // ARCAT specs use articleIlvl=1 convention
      const nodes = allNodes(tree.parts);
      const sources = new Set(nodes.map((n) => n.meta.source));
      expect(sources.has('arcat')).toBe(true);
      expect(sources.has('cpi')).toBe(false);
    });

    it(`${fixture}: has at least one part with at least one article child`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      const hasArticle = tree.parts.some((part) =>
        part.children.some((child) => child.type === 'article')
      );
      expect(hasArticle).toBe(true);
    });
  }
});
```

- [ ] **Step 10.2: Create CPI integration tests**

Create `src/parser/docx/cpi.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import type { CsiNode } from '../../ast/types.js';

const CPI_DIR = resolve('docs/references/MANUFACTURER_CPI');

function allNodes(nodes: readonly CsiNode[]): CsiNode[] {
  return [...nodes, ...nodes.flatMap((n) => allNodes(n.children))];
}

const CPI_FIXTURES = [
  'CPI_BUSBAR_CSIMFS.docx',
  'CPI_CABLE_MANAGEMENT_AND_LADDER_RACKS_CSIMFS.docx',
  'CPI_COMMUNICATIONS_CABINETS_RACKS_FRAMES_ENCLOSURES_CSIMFS.docx',
  'CPI_COMMUNICATIONS_RACK_MOUNTED_POWER_PROTECTION_CSIMFS.docx',
  'CPI_DATA_COMMUNICATIONS_WIRELESS_ACCESS_POINTS_CSIMFS.docx',
  'CPI_ELECTRICAL_CABINETS_AND_ENCLOSURES_CSIMFS.docx',
];

describe('CPI fixture parsing', () => {
  for (const fixture of CPI_FIXTURES) {
    it(`${fixture}: parses with source=cpi`, async () => {
      const buffer = readFileSync(resolve(CPI_DIR, fixture));
      const tree = await parseDocx(buffer);

      expect(tree.parts.length).toBeGreaterThan(0);
      const nodes = allNodes(tree.parts);
      const sources = new Set(nodes.map((n) => n.meta.source));
      expect(sources.has('cpi')).toBe(true);
    });

    it(`${fixture}: has continuation nodes (PR1lc paragraphs not misclassified as pr1)`, async () => {
      // KNOWN AMBIGUITY: We cannot assert zero 'pr1' nodes — some pr1 paragraphs are valid.
      // We assert that continuation nodes exist, proving suppression detection works.
      const buffer = readFileSync(resolve(CPI_DIR, fixture));
      const tree = await parseDocx(buffer);

      const nodes = allNodes(tree.parts);
      const continuations = nodes.filter((n) => n.type === 'continuation');
      expect(continuations.length).toBeGreaterThan(0);
    });
  }

  it('inference: CPI numId=0 continuation — PR1lc not classified as pr1', async () => {
    // Regression: PR1lc style has numId=0 (suppressesNumbering).
    // Previously, resolveNumPrChain walked past the suppression and classified as pr1.
    // Fix: discriminated union NumPrResult stops chain at suppressed.
    const buffer = readFileSync(resolve(CPI_DIR, 'CPI_BUSBAR_CSIMFS.docx'));
    const tree = await parseDocx(buffer);

    const nodes = allNodes(tree.parts);
    // Every continuation node must NOT have text matching a PR1 number pattern like "A. "
    const mismatch = nodes.filter(
      (n) => n.type === 'continuation' && /^[A-Z]\.\s/.test(n.text.trim())
    );
    // If continuation nodes start with "A. " text, they were misclassified
    expect(mismatch.length).toBe(0);
  });
});
```

- [ ] **Step 10.3: Run integration tests**

```bash
pnpm test src/parser/docx/arcat.integration.test.ts src/parser/docx/cpi.integration.test.ts
```

Expected: all pass. If any fixture fails, run `pnpm tsx scripts/parse-debug.ts <fixture>` to inspect.

- [ ] **Step 10.4: Commit**

```bash
git add src/parser/docx/arcat.integration.test.ts src/parser/docx/cpi.integration.test.ts
git commit -m "test(parser): ARCAT + CPI fixture integration tests for inference engine"
```

---

## Task 11: src/api/parse.ts + router wiring

**Files:**
- Create: `src/api/parse.ts`
- Create: `src/api/parse.test.ts`
- Modify: `src/api/router.ts`

- [ ] **Step 11.1: Write failing unit tests for handlers**

Create `src/api/parse.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock parser and jobs modules before importing handler
vi.mock('../parser/index.js', () => ({
  parseSec: vi.fn(),
  parseDocx: vi.fn(),
}));
vi.mock('../lib/jobs.js', () => ({
  createJob: vi.fn().mockReturnValue('test-job-id'),
  updateJob: vi.fn(),
  getJob: vi.fn(),
}));

import { parseHandler, parseJobHandler } from './parse.js';
import { getJob } from '../lib/jobs.js';

function makeRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('parseHandler', () => {
  it('returns 400 when no file uploaded', async () => {
    const req = { file: undefined, body: {} } as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 202 with jobId when file provided', async () => {
    const req = {
      file: { originalname: 'test.docx', buffer: Buffer.from('fake') },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { jobId: 'test-job-id' },
    }));
  });
});

describe('parseJobHandler', () => {
  it('returns 404 when job not found', async () => {
    vi.mocked(getJob).mockReturnValue(undefined);
    const req = { params: { jobId: 'nonexistent' } } as unknown as Request;
    const res = makeRes();
    await parseJobHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 200 with job data when found', async () => {
    const fakeJob = {
      jobId: 'abc',
      status: 'complete' as const,
      progress: { stage: 'complete' as const, pct: 100 },
      expiresAt: Date.now() + 3600000,
    };
    vi.mocked(getJob).mockReturnValue(fakeJob);
    const req = { params: { jobId: 'abc' } } as unknown as Request;
    const res = makeRes();
    await parseJobHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: fakeJob }));
  });
});
```

- [ ] **Step 11.2: Run tests — verify failure**

```bash
pnpm test src/api/parse.test.ts
```

Expected: FAIL — `Cannot find module './parse.js'`

- [ ] **Step 11.3: Implement parse.ts**

Create `src/api/parse.ts`:

```typescript
import multer from 'multer';
import path from 'node:path';
import type { Request, Response } from 'express';
import { parseSec, parseDocx } from '../parser/index.js';
import { createJob, updateJob, getJob, type ParseStage } from '../lib/jobs.js';
import { pool, createSpec, insertTree } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { CsiNode, CsiTree } from '../ast/types.js';

// SECURITY TODO (issue #19): validate MIME type — .docx must match
// application/vnd.openxmlformats-officedocument.wordprocessingml.document
// AND magic bytes PK\x03\x04. Reject mismatch before processing.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

export async function parseHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }
  const jobId = createJob();
  const body = req.body as { section?: string; title?: string };
  void processParseJob(jobId, req.file, body);
  res.status(202).json({ success: true, data: { jobId } });
}

export async function parseJobHandler(req: Request, res: Response): Promise<void> {
  const jobId = req.params['jobId'] ?? '';
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'job not found' });
    return;
  }
  res.status(200).json({ success: true, data: job });
}

function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

async function processParseJob(
  jobId: string,
  file: Express.Multer.File,
  body: { section?: string; title?: string }
): Promise<void> {
  try {
    const ext = path.extname(file.originalname).toLowerCase();
    const onProgress = (stage: string, pct: number): void => {
      updateJob(jobId, { stage: stage as ParseStage, pct, status: 'running' });
    };

    let tree: CsiTree;
    if (ext === '.sec') {
      onProgress('extracting', 10);
      const parsed = parseSec(file.buffer.toString('utf-8'));
      tree = parsed.tree;
      onProgress('classifying', 75);
    } else if (ext === '.docx') {
      tree = await parseDocx(file.buffer, onProgress);
    } else {
      updateJob(jobId, { status: 'failed', error: `unsupported format: ${ext || '(none)'}` });
      return;
    }

    const finalTree: CsiTree = {
      ...tree,
      ...(body.section ? { section: body.section } : {}),
      ...(body.title ? { title: body.title } : {}),
    };

    updateJob(jobId, { stage: 'persisting', pct: 90, status: 'running' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const source = finalTree.parts[0]?.meta.source ?? 'unknown';
      const specId = await createSpec(
        { section: finalTree.section, title: finalTree.title, source },
        client
      );
      const treeWithId: CsiTree = { ...finalTree, id: specId };
      await insertTree(treeWithId, specId, client);
      await client.query('COMMIT');

      const nodeCount = countNodes(treeWithId.parts);
      updateJob(jobId, {
        status: 'complete',
        stage: 'complete',
        pct: 100,
        result: { specId, section: treeWithId.section, title: treeWithId.title, nodeCount },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err, jobId }, 'parse job failed');
    updateJob(jobId, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'parse failed',
    });
  }
}
```

- [ ] **Step 11.4: Wire routes in router.ts**

Add to `src/api/router.ts`:

```typescript
import { parseHandler, parseJobHandler, upload } from './parse.js';

// After existing routes:
router.post('/parse', upload.single('file'), parseHandler);
router.get('/parse/jobs/:jobId', parseJobHandler);
```

- [ ] **Step 11.5: Run unit tests — verify pass**

```bash
pnpm test src/api/parse.test.ts
```

Expected: all pass.

- [ ] **Step 11.6: Type check + lint**

```bash
pnpm exec tsc --noEmit && pnpm lint
```

Expected: no errors.

- [ ] **Step 11.7: Commit**

```bash
git add src/api/parse.ts src/api/parse.test.ts src/api/router.ts
git commit -m "feat(api): POST /parse async job + GET /parse/jobs/:jobId polling endpoint"
```

---

## Task 12: End-to-end integration test with DB

**Files:**
- Create: `src/api/parse.integration.test.ts`

- [ ] **Step 12.1: Write integration test**

Create `src/api/parse.integration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import app from '../index.js';
import { pool } from '../db/index.js';

// Wait for job to reach terminal state
async function waitForJob(
  jobId: string,
  maxMs = 15_000
): Promise<{ status: string; result?: { specId: string } }> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/parse/jobs/${jobId}`);
    const job = res.body.data as { status: string; result?: { specId: string } };
    if (job.status === 'complete' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('job did not complete within timeout');
}

describe('POST /parse integration', () => {
  const cleanupIds: string[] = [];

  afterEach(async () => {
    for (const id of cleanupIds) {
      await pool.query('DELETE FROM specs WHERE id = $1', [id]);
    }
    cleanupIds.length = 0;
  });

  it('parses an ARCAT DOCX and stores paragraphs in DB', async () => {
    const buffer = readFileSync(resolve('docs/references/ARCAT/01_10_00arc.docx'));

    const postRes = await request(app)
      .post('/parse')
      .attach('file', buffer, '01_10_00arc.docx')
      .expect(202);

    expect(postRes.body.data.jobId).toBeDefined();
    const { jobId } = postRes.body.data as { jobId: string };

    const job = await waitForJob(jobId);
    expect(job.status).toBe('complete');

    const specId = job.result?.specId;
    expect(specId).toBeDefined();
    if (specId) cleanupIds.push(specId);

    // Spec row exists
    const specResult = await pool.query('SELECT section, source FROM specs WHERE id = $1', [specId]);
    expect(specResult.rows).toHaveLength(1);
    expect(specResult.rows[0]?.source).toBe('arcat');

    // Paragraphs were inserted
    const paraResult = await pool.query(
      'SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1',
      [specId]
    );
    expect(parseInt(paraResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  });

  it('returns 400 when no file provided', async () => {
    await request(app).post('/parse').expect(400);
  });

  it('job fails gracefully for unsupported extension', async () => {
    const postRes = await request(app)
      .post('/parse')
      .attach('file', Buffer.from('fake'), 'file.pdf')
      .expect(202);

    const { jobId } = postRes.body.data as { jobId: string };
    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
  });

  it('GET /parse/jobs/:jobId returns 404 for unknown job', async () => {
    await request(app).get('/parse/jobs/nonexistent-id').expect(404);
  });
});
```

- [ ] **Step 12.2: Run DB integration test**

```bash
pnpm test:integration src/api/parse.integration.test.ts
```

Expected: all pass. If supertest is not installed, run `pnpm add -D supertest @types/supertest` first.

- [ ] **Step 12.3: Run full test suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 12.4: Final lint and type check**

```bash
pnpm lint && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 12.5: Commit**

```bash
git add src/api/parse.integration.test.ts
git commit -m "test(api): POST /parse end-to-end integration test with PostgreSQL"
```

---

## Task 13: Final verification and PR

- [ ] **Step 13.1: Run all tests**

```bash
pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 13.2: Build**

```bash
pnpm build
```

Expected: no compilation errors.

- [ ] **Step 13.3: Smoke test parse-debug against both fixture sets**

```bash
pnpm tsx scripts/parse-debug.ts docs/references/ARCAT/01_10_00arc.docx
pnpm tsx scripts/parse-debug.ts "docs/references/MANUFACTURER_CPI/CPI_BUSBAR_CSIMFS.docx"
```

Expected: both print hierarchical trees with `Source: arcat` / `Source: cpi`.

- [ ] **Step 13.4: Push branch and open PR**

```bash
git push -u origin feat/parser-docx-1c-ii
gh pr create \
  --title "feat(parser): DOCX 5-signal hierarchy inference engine + POST /parse (Phase 1c-ii)" \
  --body "$(cat <<'EOF'
## Summary

- **document.ts**: extracts DocxParagraph[] from word/document.xml via JSZip + fast-xml-parser
- **heuristics.ts**: signal 4 (text regex, anchored to ^) + signal 5 (indentation / 576 twips)
- **inference.ts**: two-pass engine — pass 1 priority chain (numbering XML > style chain > text > indent), pass 2 stack-based tree construction
- **index.ts**: DOCX orchestrator with onProgress callback
- **jobs.ts**: in-memory async job store (1hr TTL)
- **POST /parse**: 202 + jobId immediately; **GET /parse/jobs/:jobId**: progress polling
- **scripts/parse-debug.ts**: dev tool — parse file → print tree, no server required

Closes #12.

## Test plan

- [ ] `pnpm test` — all unit tests pass
- [ ] `pnpm test:integration` — DB integration tests pass (requires `docker compose up -d postgres`)
- [ ] `pnpm tsx scripts/parse-debug.ts docs/references/ARCAT/01_10_00arc.docx` — ARCAT tree visible
- [ ] `pnpm tsx scripts/parse-debug.ts "docs/references/MANUFACTURER_CPI/CPI_BUSBAR_CSIMFS.docx"` — CPI tree visible, continuations present
- [ ] `pnpm build` — compiles clean

## Security TODOs (tracked in #19)

`// SECURITY TODO` comments placed at:
- `src/parser/docx/index.ts` — JSZip loadAsync (ZIP bomb check)
- `src/api/parse.ts` — multer config (MIME type validation)
- `src/parser/docx/document.ts` — fast-xml-parser config (XXE audit)

## Out of scope

- Cross-reference extraction from DOCX (#12 notes → Phase 1c-iii)
- Style template system (#20 → Phase 2b)
EOF
)"
```

- [ ] **Step 13.5: Verify CI passes**

```bash
gh pr checks $(gh pr view --json number -q '.number')
```

Expected: lint, test, build, loc-check all green.

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `document.ts` — Task 3
- ✅ `heuristics.ts` signals 4+5 — Task 2
- ✅ `inference.ts` pass 1 classifyParagraphs — Task 4
- ✅ `inference.ts` pass 2 buildTree — Task 5
- ✅ `index.ts` orchestrator with onProgress — Task 8
- ✅ `jobs.ts` async job store — Task 7
- ✅ `POST /parse` + `GET /parse/jobs/:jobId` — Task 11
- ✅ `createSpec` DB query — Task 6
- ✅ Router wiring — Task 11
- ✅ `parser/index.ts` export — Task 8
- ✅ `scripts/parse-debug.ts` — Task 9
- ✅ ARCAT + CPI integration tests — Task 10
- ✅ DB integration test — Task 12
- ✅ `MASTERSPEC_ILVL_MAP` → `CPI_ILVL_MAP` rename — Task 1
- ✅ `SignalConflict`, `ClassifiedParagraph` types — Task 1
- ✅ SECURITY TODO comments at all three callsites

**Type consistency:**
- `buildStyleMap(xml)` — matches actual export in styles.ts ✓
- `buildNumberingMap(xml)` / `emptyNumberingMap()` — matches numbering.ts ✓
- `insertTree(tree, specId, client)` — matches paragraphs.ts signature ✓
- `createSpec(input, db?)` — added with optional Queryable param ✓
- `ClassifiedParagraph.signalUsed: 1|2|3|4|5` — consistent across all tasks ✓
- `CsiTree.parts` (not `children`) — consistent with ast/types.ts ✓
