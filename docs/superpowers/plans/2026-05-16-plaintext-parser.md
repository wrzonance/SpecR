# Plaintext Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone `.txt` spec parser that infers CSI hierarchy from text signals (PART/article/prefix patterns + indentation fallback), wired into `POST /parse` and `load_files`.

**Architecture:** New `src/parser/text/` module with a pure `classifyLine` function and a stack-based `parseText` tree builder. Wired into the existing `parse()` dispatcher in `src/parser/index.ts`. Three touch points: REST parse handler, MCP tool descriptions. Read-only — no round-trip anchors.

**Tech Stack:** TypeScript strict, Vitest, `uuid` (already in deps), no new deps.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/parser/text/signals.ts` | `classifyLine(line): LineClassification` — pure signal cascade |
| Create | `src/parser/text/signals.test.ts` | Unit tests for `classifyLine` |
| Create | `src/parser/text/index.ts` | `parseText(text): ParsedText` — stack tree builder |
| Create | `src/parser/text/index.test.ts` | Unit tests for `parseText` |
| Create | `tests/fixtures/text/ufgs-27-10-00.txt` | Stripped UFGS SEC fixture |
| Create | `tests/fixtures/text/numbered-prefixes.txt` | Synthetic fixture with A./1./a. prefixes |
| Create | `tests/fixtures/text/indent-only.txt` | Synthetic fixture, indentation-only sub-items |
| Modify | `src/parser/index.ts` | Add `.txt` case + `capabilities?` to `ParseResult` |
| Modify | `src/lib/jobs.ts` | Add `capabilities?` to `ParseJobResult` |
| Modify | `src/api/parse.ts` | Add `.txt` to `ALLOWED_EXT`, `processParseJob` branch |
| Modify | `src/mcp/tools.ts` | Update `load_files` + `parse_document` descriptions |
| Modify | `README.md` | Status table row, What Works Today entry |

---

## Task 1: Generate Text Fixtures

**Files:**
- Create: `scripts/gen-text-fixtures.ts`
- Create: `tests/fixtures/text/ufgs-27-10-00.txt` (generated)
- Create: `tests/fixtures/text/numbered-prefixes.txt` (hand-crafted)
- Create: `tests/fixtures/text/indent-only.txt` (hand-crafted)

- [ ] **Step 1: Create the fixture generator script**

Create `scripts/gen-text-fixtures.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function stripXml(raw: string): string {
  return raw
    .split('<')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
    .join(' ')
    .split(/\n|\r\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

mkdirSync(join('tests', 'fixtures', 'text'), { recursive: true });

const sec = readFileSync(join('tests', 'fixtures', 'sec', '27_10_00.SEC'), 'utf-8');
writeFileSync(join('tests', 'fixtures', 'text', 'ufgs-27-10-00.txt'), stripXml(sec));
console.log('Generated: tests/fixtures/text/ufgs-27-10-00.txt');
```

- [ ] **Step 2: Run the generator**

```bash
pnpm tsx scripts/gen-text-fixtures.ts
```

Expected output:
```text
Generated: tests/fixtures/text/ufgs-27-10-00.txt
```

Verify first 20 lines look like:
```bash
head -20 tests/fixtures/text/ufgs-27-10-00.txt
```

Should contain lines like `SECTION 27 10 00`, `BUILDING TELECOMMUNICATIONS CABLING SYSTEM`,
`PART 1 - GENERAL`, `1.1 REFERENCES`.

- [ ] **Step 3: Create the numbered-prefixes fixture**

Create `tests/fixtures/text/numbered-prefixes.txt` with this exact content:

```text
SECTION 03 30 00 - CAST-IN-PLACE CONCRETE

PART 1 - GENERAL

1.1 SCOPE

A. This section covers cast-in-place concrete construction.
B. Related work in other sections:
1. Section 03 10 00 - Concrete Forming.
2. Section 03 20 00 - Concrete Reinforcing.

1.2 REFERENCES

A. American Concrete Institute:
1. ACI 301 Specifications for Structural Concrete.
2. ACI 318 Building Code Requirements for Structural Concrete.
a. Chapter 26 covers construction documents.
b. Chapter 27 covers strength evaluation.

PART 2 - PRODUCTS

2.1 MATERIALS

A. Portland cement conforming to ASTM C 150.
B. Aggregates conforming to ASTM C 33.
1. Coarse aggregate: maximum size 1-1/2 inches.
2. Fine aggregate: clean, well-graded natural sand.

PART 3 - EXECUTION

3.1 INSTALLATION

A. Place concrete in accordance with ACI 301.
1. Do not place concrete in rain or temperatures below 40 degrees F.
a. Protect fresh concrete from freezing.
1) Use insulating blankets when ambient temperature is below 32 degrees F.
```

- [ ] **Step 4: Create the indent-only fixture**

Create `tests/fixtures/text/indent-only.txt` with this exact content:

```text
SECTION 27 21 00 - INSIDE PLANT TELECOMMUNICATIONS CABLING

PART 1 - GENERAL

1.1 SUMMARY

    This section covers telecommunications cabling for building interiors.
    Coordinate work with electrical, mechanical, and security trades.

1.2 QUALITY ASSURANCE

    Installer shall have minimum five years experience with structured cabling.
    Testing technician shall be manufacturer-certified.
        Certification documentation shall be submitted prior to installation.
        Re-certification required if lapsed more than two years.

PART 2 - PRODUCTS

2.1 CABLE

    Horizontal cabling shall be Category 6A unshielded twisted pair.
        Cable shall be listed and labeled for the intended application.

PART 3 - EXECUTION

3.1 INSTALLATION

    Install cable in accordance with manufacturer instructions.
    Support cable at intervals not exceeding five feet.
        Use cable hangers rated for the cable weight.
```

- [ ] **Step 5: Commit fixtures**

```bash
git add tests/fixtures/text/ scripts/gen-text-fixtures.ts
git commit -m "test(parser): add plaintext spec fixtures for text parser"
```

---

## Task 2: `src/parser/text/signals.ts` — `classifyLine`

**Files:**
- Create: `src/parser/text/signals.ts`
- Create: `src/parser/text/signals.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/parser/text/signals.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyLine } from './signals.js';

describe('classifyLine', () => {
  it('blank line returns type blank', () => {
    expect(classifyLine('')).toEqual({ type: 'blank', text: '', level: -1 });
    expect(classifyLine('   ')).toEqual({ type: 'blank', text: '', level: -1 });
  });

  it('SECTION header detected', () => {
    const r = classifyLine('SECTION 27 10 00 - BUILDING TELECOMMUNICATIONS CABLING SYSTEM');
    expect(r.type).toBe('header');
    expect(r.level).toBe(-1);
  });

  it('PART heading strips numeric prefix', () => {
    const r = classifyLine('PART 1 - GENERAL');
    expect(r.type).toBe('part');
    expect(r.text).toBe('GENERAL');
    expect(r.level).toBe(0);
  });

  it('PART heading without dash still classified', () => {
    const r = classifyLine('PART 2 PRODUCTS');
    expect(r.type).toBe('part');
    expect(r.level).toBe(0);
  });

  it('article heading strips N.N prefix', () => {
    const r = classifyLine('1.1 REFERENCES');
    expect(r.type).toBe('article');
    expect(r.text).toBe('REFERENCES');
    expect(r.level).toBe(1);
  });

  it('article with double-digit section number', () => {
    const r = classifyLine('10.1 GENERAL');
    expect(r.type).toBe('article');
    expect(r.text).toBe('GENERAL');
  });

  it('pr1 strips uppercase letter prefix', () => {
    const r = classifyLine('A. First requirement');
    expect(r.type).toBe('pr1');
    expect(r.text).toBe('First requirement');
    expect(r.level).toBe(2);
  });

  it('pr2 strips numeric period prefix', () => {
    const r = classifyLine('1. First item');
    expect(r.type).toBe('pr2');
    expect(r.text).toBe('First item');
    expect(r.level).toBe(3);
  });

  it('pr3 strips lowercase letter period prefix', () => {
    const r = classifyLine('a. lowercase item');
    expect(r.type).toBe('pr3');
    expect(r.text).toBe('lowercase item');
    expect(r.level).toBe(4);
  });

  it('pr4 strips numeric paren prefix', () => {
    const r = classifyLine('1) paren item');
    expect(r.type).toBe('pr4');
    expect(r.text).toBe('paren item');
    expect(r.level).toBe(5);
  });

  it('pr5 strips lowercase paren prefix', () => {
    const r = classifyLine('a) paren item');
    expect(r.type).toBe('pr5');
    expect(r.text).toBe('paren item');
    expect(r.level).toBe(6);
  });

  it('pr2 guard: digit-period at end of line is NOT pr2', () => {
    // KNOWN AMBIGUITY: "1." at line end with no following text — treated as continuation
    const r = classifyLine('1.');
    expect(r.type).toBe('continuation');
  });

  it('article guard: N.N requires whitespace and content', () => {
    // KNOWN AMBIGUITY: "1.1" with no following text — treated as continuation
    const r = classifyLine('1.1');
    expect(r.type).toBe('continuation');
  });

  it('indented line without prefix is continuation with indent level', () => {
    const r = classifyLine('    indented text'); // 4 spaces = level 1
    expect(r.type).toBe('continuation');
    expect(r.text).toBe('indented text');
    expect(r.level).toBe(1);
  });

  it('double-indented line has level 2', () => {
    const r = classifyLine('        double indent'); // 8 spaces
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(2);
  });

  it('tab indent treated as 4 spaces', () => {
    const r = classifyLine('\tTabbed line');
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(1);
  });

  it('unindented non-matching line is continuation at level -1', () => {
    const r = classifyLine('Plain prose with no prefix.');
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(-1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test --reporter=verbose 2>&1 | grep -E "FAIL|Cannot find|Error" | head -5
```

Expected: fail with import error (file does not exist yet).

- [ ] **Step 3: Implement `src/parser/text/signals.ts`**

```typescript
import type { NodeType } from '../../ast/types.js';

export type LineType = NodeType | 'blank' | 'header';

export interface LineClassification {
  readonly type: LineType;
  readonly text: string;
  readonly level: number;
}

const SECTION_HEADER_RE = /^SECTION\s+\d{2}\s+\d{2}\s+\d{2}/i;
const PART_RE = /^PART\s+\d+/i;
const ARTICLE_RE = /^\d+\.\d+\s+\S/;
const PR1_RE = /^[A-Z]\.\s+\S/;
const PR2_RE = /^\d+\.\s+\S/;
const PR3_RE = /^[a-z]\.\s+\S/;
const PR4_RE = /^\d+\)\s+\S/;
const PR5_RE = /^[a-z]\)\s+\S/;

function stripPartPrefix(s: string): string {
  return s.replace(/^PART\s+\d+\s*[-–—]?\s*/i, '').trim();
}

function stripArticlePrefix(s: string): string {
  return s.replace(/^\d+\.\d+\s+/, '').trim();
}

function stripPrPrefix(s: string): string {
  return s.replace(/^(?:[A-Za-z]\.|[0-9]+[.)]) /, '').trim();
}

function indentLevel(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === '\t') count += 4;
    else if (ch === ' ') count += 1;
    else break;
  }
  return Math.min(6, Math.floor(count / 4));
}

export function classifyLine(line: string): LineClassification {
  if (line.trim() === '') {
    return { type: 'blank', text: '', level: -1 };
  }

  const trimmed = line.trim();

  if (SECTION_HEADER_RE.test(trimmed)) {
    return { type: 'header', text: trimmed, level: -1 };
  }
  if (PART_RE.test(trimmed)) {
    return { type: 'part', text: stripPartPrefix(trimmed), level: 0 };
  }
  if (ARTICLE_RE.test(trimmed)) {
    return { type: 'article', text: stripArticlePrefix(trimmed), level: 1 };
  }
  if (PR1_RE.test(trimmed)) {
    return { type: 'pr1', text: stripPrPrefix(trimmed), level: 2 };
  }
  if (PR2_RE.test(trimmed)) {
    return { type: 'pr2', text: stripPrPrefix(trimmed), level: 3 };
  }
  if (PR3_RE.test(trimmed)) {
    return { type: 'pr3', text: stripPrPrefix(trimmed), level: 4 };
  }
  if (PR4_RE.test(trimmed)) {
    return { type: 'pr4', text: stripPrPrefix(trimmed), level: 5 };
  }
  if (PR5_RE.test(trimmed)) {
    return { type: 'pr5', text: stripPrPrefix(trimmed), level: 6 };
  }

  const indent = indentLevel(line);
  return {
    type: 'continuation',
    text: trimmed,
    level: indent > 0 ? indent : -1,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm test --project=unit --reporter=verbose 2>&1 | grep -E "signals|PASS|FAIL"
```

Expected: all `classifyLine` tests pass.

- [ ] **Step 5: Run lint**

```bash
pnpm lint 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/parser/text/signals.ts src/parser/text/signals.test.ts
git commit -m "feat(parser): add classifyLine signal cascade for plaintext spec lines"
```

---

## Task 3: `src/parser/text/index.ts` — `parseText`

**Files:**
- Create: `src/parser/text/index.ts`
- Create: `src/parser/text/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/parser/text/index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseText } from './index.js';
import type { CsiNode } from '../../ast/types.js';

describe('parseText — numbered-prefixes fixture', () => {
  const fixture = readFileSync(
    join('tests', 'fixtures', 'text', 'numbered-prefixes.txt'),
    'utf-8'
  );

  it('returns read-only capability', () => {
    const result = parseText(fixture);
    expect(result.capabilities).toContain('read-only');
  });

  it('extracts section from SECTION header line', () => {
    const result = parseText(fixture);
    expect(result.tree.section).toBe('03 30 00');
  });

  it('extracts title from SECTION header line', () => {
    const result = parseText(fixture);
    expect(result.tree.title).toMatch(/CAST-IN-PLACE CONCRETE/i);
  });

  it('returns 3 part nodes', () => {
    const result = parseText(fixture);
    expect(result.tree.parts).toHaveLength(3);
  });

  it('part nodes have correct text (prefix stripped)', () => {
    const result = parseText(fixture);
    expect(result.tree.parts[0]?.text).toBe('GENERAL');
    expect(result.tree.parts[1]?.text).toBe('PRODUCTS');
    expect(result.tree.parts[2]?.text).toBe('EXECUTION');
  });

  it('each part has article children', () => {
    const result = parseText(fixture);
    const part1 = result.tree.parts[0];
    expect(part1?.children.length).toBeGreaterThanOrEqual(2);
    expect(part1?.children.every((c) => c.type === 'article')).toBe(true);
  });

  it('pr1 nodes exist under articles with prefix stripped', () => {
    const result = parseText(fixture);
    const part1 = result.tree.parts[0]!;
    const article = part1.children[0]!;
    const pr1 = article.children.find((c) => c.type === 'pr1');
    expect(pr1).toBeDefined();
    expect(pr1?.text).not.toMatch(/^[A-Z]\.\s/); // prefix must be stripped
  });

  it('refs array is empty', () => {
    const result = parseText(fixture);
    expect(result.refs).toHaveLength(0);
  });

  it('all node ids are unique UUIDs', () => {
    const ids: string[] = [];
    function collect(nodes: readonly CsiNode[]): void {
      for (const n of nodes) {
        ids.push(n.id);
        collect(n.children);
      }
    }
    const result = parseText(fixture);
    result.tree.parts.forEach((p) => { ids.push(p.id); collect(p.children); });
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe('parseText — UFGS stripped fixture', () => {
  const fixture = readFileSync(
    join('tests', 'fixtures', 'text', 'ufgs-27-10-00.txt'),
    'utf-8'
  );

  it('returns read-only capability', () => {
    expect(parseText(fixture).capabilities).toContain('read-only');
  });

  it('infers section 27 10 00', () => {
    expect(parseText(fixture).tree.section).toBe('27 10 00');
  });

  it('produces at least 1 part node', () => {
    expect(parseText(fixture).tree.parts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseText — indent-only fixture', () => {
  const fixture = readFileSync(
    join('tests', 'fixtures', 'text', 'indent-only.txt'),
    'utf-8'
  );

  it('returns read-only capability', () => {
    expect(parseText(fixture).capabilities).toContain('read-only');
  });

  it('produces part nodes', () => {
    expect(parseText(fixture).tree.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('continuation nodes exist under articles', () => {
    const result = parseText(fixture);
    const part1 = result.tree.parts[0]!;
    const article = part1.children[0]!;
    const cont = article.children.find((c) => c.type === 'continuation');
    expect(cont).toBeDefined();
  });
});

describe('parseText — section extraction edge cases', () => {
  it('returns unknown section when no SECTION line present', () => {
    const result = parseText('PART 1 - GENERAL\n1.1 SCOPE\nSome text.\n');
    expect(result.tree.section).toBe('unknown');
  });

  it('handles CRLF line endings', () => {
    const result = parseText('SECTION 27 21 00\r\nPART 1 - GENERAL\r\n');
    expect(result.tree.section).toBe('27 21 00');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test --project=unit --reporter=verbose 2>&1 | grep -E "Cannot find|Error|FAIL" | head -5
```

Expected: fail with import error (file does not exist yet).

- [ ] **Step 3: Implement `src/parser/text/index.ts`**

```typescript
import { v4 as uuidv4 } from 'uuid';
import { inferSectionMeta } from '../../lib/infer-section.js';
import type { CsiNode, CsiNodeMeta, CsiTree, NodeType, SecRef } from '../../ast/types.js';
import { classifyLine } from './signals.js';
import type { LineType } from './signals.js';

type StructuralType = Exclude<LineType, 'blank' | 'header' | 'continuation'>;

const SECTION_EXTRACT_RE =
  /SECTION\s+(\d{2})\s+(\d{2})\s+(\d{2})(?:\s*[-–—]\s*(.+))?/i;
const MAX_HEADER_SCAN = 5;

interface StackEntry {
  readonly mutableChildren: CsiNode[];
  readonly level: number;
}

function makeMeta(): CsiNodeMeta {
  return { source: 'unknown' };
}

function makeNode(type: NodeType, text: string, children: CsiNode[]): CsiNode {
  return { id: uuidv4(), type, text, children, meta: makeMeta() };
}

function extractSectionMeta(
  lines: readonly string[]
): { readonly section: string; readonly title: string } | null {
  let scanned = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = line.trim().match(SECTION_EXTRACT_RE);
    if (m) {
      return {
        section: `${m[1]} ${m[2]} ${m[3]}`,
        title: (m[4] ?? '').trim() || 'unknown',
      };
    }
    if (++scanned >= MAX_HEADER_SCAN) break;
  }
  return null;
}

function isStructural(type: LineType): type is StructuralType {
  return type !== 'blank' && type !== 'header' && type !== 'continuation';
}

export interface ParsedText {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly capabilities: readonly string[];
}

export function parseText(text: string): ParsedText {
  const lines = text.split(/\r?\n/);
  const headerMeta = extractSectionMeta(lines);

  const rootChildren: CsiNode[] = [];
  const rootEntry: StackEntry = { mutableChildren: rootChildren, level: -1 };
  const stack: StackEntry[] = [rootEntry];

  for (const line of lines) {
    const cls = classifyLine(line);

    if (cls.type === 'blank' || cls.type === 'header') continue;

    if (cls.type === 'continuation') {
      const top = stack[stack.length - 1]!;
      top.mutableChildren.push(makeNode('continuation', cls.text, []));
      continue;
    }

    if (!isStructural(cls.type)) continue;

    while (stack.length > 1 && stack[stack.length - 1]!.level >= cls.level) {
      stack.pop();
    }

    const children: CsiNode[] = [];
    const node = makeNode(cls.type as NodeType, cls.text, children);
    stack[stack.length - 1]!.mutableChildren.push(node);
    stack.push({ mutableChildren: children, level: cls.level });
  }

  const rawTree: CsiTree = {
    id: uuidv4(),
    section: headerMeta?.section ?? 'unknown',
    title: headerMeta?.title ?? 'unknown',
    parts: rootChildren,
  };

  const inference = inferSectionMeta(rawTree);
  const applyInference =
    inference.method !== 'metadata' && inference.confidence !== 'none';
  const tree: CsiTree = {
    ...rawTree,
    section: applyInference ? inference.inferredSection : rawTree.section,
    title: applyInference ? inference.inferredTitle : rawTree.title,
  };

  return { tree, refs: [], capabilities: ['read-only'] };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
pnpm test --project=unit --reporter=verbose 2>&1 | grep -E "parser/text|PASS|FAIL"
```

Expected: all tests in `src/parser/text/index.test.ts` pass.

- [ ] **Step 5: Run lint**

```bash
pnpm lint 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/parser/text/index.ts src/parser/text/index.test.ts
git commit -m "feat(parser): add parseText — stack-based hierarchy inference for plaintext specs"
```

---

## Task 4: Wire `.txt` into `src/parser/index.ts` + update `src/lib/jobs.ts`

**Files:**
- Modify: `src/parser/index.ts`
- Modify: `src/lib/jobs.ts`
- Create: `src/parser/index.test.ts`

- [ ] **Step 1: Write the failing test for `.txt` dispatch**

Create `src/parser/index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './index.js';

describe('parse() dispatcher', () => {
  it('dispatches .txt to text parser', async () => {
    const buf = readFileSync(join('tests', 'fixtures', 'text', 'numbered-prefixes.txt'));
    const result = await parse(buf, 'numbered-prefixes.txt');
    expect(result.tree.parts.length).toBeGreaterThan(0);
    expect(result.capabilities).toContain('read-only');
  });

  it('throws ParserError for unsupported extension', async () => {
    await expect(parse(Buffer.from(''), 'file.xyz')).rejects.toThrow('unsupported format');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm test --project=unit src/parser/index.test.ts 2>&1 | grep -E "FAIL|Error" | head -5
```

Expected: the `.txt` dispatch test fails — extension not handled yet.

- [ ] **Step 3: Update `src/parser/index.ts`**

Replace the entire file content:

```typescript
import path from 'node:path';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { parseText } from './text/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { inferSectionMeta } from '../lib/infer-section.js';
import type { CsiTree, SecRef } from '../ast/types.js';
import type { SectionInference } from '../lib/infer-section.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx, assertDocxSafe } from './docx/index.js';
export { parseText } from './text/index.js';
export { ParserError } from './error.js';
export type { SectionInference } from '../lib/infer-section.js';

export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;
  readonly capabilities?: readonly string[];
}

function applyInference(tree: CsiTree, inference: SectionInference): CsiTree {
  if (inference.method === 'metadata' || inference.confidence === 'none') return tree;
  const section =
    inference.inferredSection !== 'unknown' ? inference.inferredSection : tree.section;
  const title = inference.inferredTitle !== 'unknown' ? inference.inferredTitle : tree.title;
  if (section === tree.section && title === tree.title) return tree;
  return { ...tree, section, title };
}

export async function parse(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') {
    const text = decodeTextBuffer(buffer);
    const { tree, refs } = parseSec(text);
    const sectionInference = inferSectionMeta(tree);
    return { tree: applyInference(tree, sectionInference), refs, sectionInference };
  }
  if (ext === '.docx') {
    const noop = (_stage: string, _pct: number): void => {};
    const tree = await parseDocx(buffer, noop);
    const sectionInference = inferSectionMeta(tree);
    return { tree: applyInference(tree, sectionInference), refs: [], sectionInference };
  }
  if (ext === '.txt') {
    const text = decodeTextBuffer(buffer);
    const { tree, refs, capabilities } = parseText(text);
    const sectionInference = inferSectionMeta(tree);
    return { tree: applyInference(tree, sectionInference), refs, sectionInference, capabilities };
  }
  throw new ParserError(`unsupported format: ${ext}`);
}
```

- [ ] **Step 4: Update `ParseJobResult` in `src/lib/jobs.ts`**

Find this block (around line 15):

```typescript
export interface ParseJobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
}
```

Replace with:

```typescript
export interface ParseJobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly capabilities?: readonly string[];
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
pnpm test --project=unit 2>&1 | grep -E "FAIL|PASS" | tail -10
```

Expected: all unit tests pass including the new dispatcher test.

- [ ] **Step 6: Commit**

```bash
git add src/parser/index.ts src/parser/index.test.ts src/lib/jobs.ts
git commit -m "feat(parser): wire .txt into parse() dispatcher; extend ParseResult and ParseJobResult with capabilities"
```

---

## Task 5: Update `src/api/parse.ts` — REST API `.txt` support

**Files:**
- Modify: `src/api/parse.ts`

- [ ] **Step 1: Add `'.txt'` to `ALLOWED_EXT`**

In `src/api/parse.ts`, find:

```typescript
const ALLOWED_EXT = new Set(['.docx', '.sec']);
```

Replace with:

```typescript
const ALLOWED_EXT = new Set(['.docx', '.sec', '.txt']);
```

- [ ] **Step 2: Short-circuit safety check for `.txt` in `validateUpload`**

Find:

```typescript
async function validateUpload(req: Request, ext: string): Promise<string | null> {
  if (!ALLOWED_EXT.has(ext)) return 'unsupported file extension';
  if (ext === '.docx' && req.file?.mimetype !== DOCX_MIME) return 'MIME type mismatch for .docx';
  try {
    if (ext === '.docx') await assertDocxSafe(req.file!.buffer);
    else assertSecSafe(req.file!.buffer);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid file';
  }
}
```

Replace with:

```typescript
async function validateUpload(req: Request, ext: string): Promise<string | null> {
  if (!ALLOWED_EXT.has(ext)) return 'unsupported file extension';
  if (ext === '.txt') return null; // plaintext: no archive or XML validation needed
  if (ext === '.docx' && req.file?.mimetype !== DOCX_MIME) return 'MIME type mismatch for .docx';
  try {
    if (ext === '.docx') await assertDocxSafe(req.file!.buffer);
    else assertSecSafe(req.file!.buffer);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid file';
  }
}
```

- [ ] **Step 3: Add `parseText` import and `decodeTextBuffer` import**

Find the import line:

```typescript
import { parseSec, parseDocx, assertDocxSafe, assertSecSafe } from '../parser/index.js';
```

Replace with:

```typescript
import { parseSec, parseDocx, parseText, assertDocxSafe, assertSecSafe } from '../parser/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
```

- [ ] **Step 4: Add `.txt` branch in `processParseJob`**

Find:

```typescript
    let tree: CsiTree;
    if (ext === '.sec') {
      onProgress('extracting', 10);
      tree = parseSec(assertSecSafe(buffer)).tree;
      onProgress('classifying', 75);
    } else {
      tree = await parseDocx(buffer, onProgress);
    }
```

Replace with:

```typescript
    let tree: CsiTree;
    let txtCapabilities: readonly string[] | undefined;

    if (ext === '.sec') {
      onProgress('extracting', 10);
      tree = parseSec(assertSecSafe(buffer)).tree;
      onProgress('classifying', 75);
    } else if (ext === '.txt') {
      onProgress('extracting', 10);
      const rawText = decodeTextBuffer(buffer);
      onProgress('classifying', 50);
      const parsed = parseText(rawText);
      tree = parsed.tree;
      txtCapabilities = parsed.capabilities;
      onProgress('classifying', 75);
    } else {
      tree = await parseDocx(buffer, onProgress);
    }
```

- [ ] **Step 5: Thread `capabilities` into the job result**

Find:

```typescript
    updateJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: { specId, section: finalTree.section, title: finalTree.title, nodeCount },
    });
```

Replace with:

```typescript
    updateJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: {
        specId,
        section: finalTree.section,
        title: finalTree.title,
        nodeCount,
        ...(txtCapabilities !== undefined ? { capabilities: txtCapabilities } : {}),
      },
    });
```

- [ ] **Step 6: Run lint to confirm types are satisfied**

```bash
pnpm lint 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 7: Run full unit test suite**

```bash
pnpm test --project=unit 2>&1 | grep -E "FAIL|PASS" | tail -5
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/api/parse.ts
git commit -m "feat(api): accept .txt uploads in POST /parse — plaintext spec ingest"
```

---

## Task 6: Update `src/mcp/tools.ts` — description updates

**Files:**
- Modify: `src/mcp/tools.ts`

- [ ] **Step 1: Update `load_files` description**

In `src/mcp/tools.ts`, find:

```typescript
'Bulk-load spec files into the library from a glob pattern or explicit paths. Accepts .SEC and .docx formats. Returns a summary of succeeded, failed, and any error details. Idempotent — re-loading an existing spec updates it.',
```

Replace with:

```typescript
'Bulk-load spec files into the library from a glob pattern or explicit paths. Accepts .SEC, .docx, and .txt formats. Returns a summary of succeeded, failed, and any error details. Idempotent — re-loading an existing spec updates it. Plaintext specs (.txt) are read-only — no round-trip merge anchors.',
```

- [ ] **Step 2: Update `parse_document` filename description**

Find:

```typescript
.describe('Original filename — extension determines format (.docx or .sec)'),
```

Replace with:

```typescript
.describe('Original filename — extension determines format (.docx, .sec, or .txt). Plaintext .txt returns capabilities: ["read-only"] in result.'),
```

- [ ] **Step 3: Run lint**

```bash
pnpm lint 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "feat(mcp): update load_files and parse_document to document .txt support"
```

---

## Task 7: Integration test

**Files:**
- Create or modify: `src/api/parse.integration.test.ts`

- [ ] **Step 1: Check if parse integration test exists**

```bash
ls src/api/parse.integration.test.ts 2>/dev/null && echo exists || echo missing
```

- [ ] **Step 2: Add `.txt` integration test**

If the file is missing, create it. If it exists, append the `describe` block below.

New file content (or block to append):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('POST /parse — .txt upload', () => {
  it('accepts .txt file and returns 202 with jobId', async () => {
    const fixture = readFileSync(join('tests', 'fixtures', 'text', 'numbered-prefixes.txt'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'text/plain' }), 'numbered-prefixes.txt');

    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { success: boolean; data: { jobId: string } };
    expect(body.success).toBe(true);
    expect(typeof body.data.jobId).toBe('string');
  });

  it('parse job completes with nodeCount > 0 and capabilities read-only', async () => {
    const fixture = readFileSync(join('tests', 'fixtures', 'text', 'numbered-prefixes.txt'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'text/plain' }), 'test.txt');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    const { data } = (await postRes.json()) as { data: { jobId: string } };

    type JobResponse = {
      data: { status: string; result?: { nodeCount: number; capabilities?: string[] } };
    };
    let result: { nodeCount: number; capabilities?: string[] } | undefined;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const pollRes = await fetch(`${baseUrl}/parse/jobs/${data.jobId}`);
      const pollBody = (await pollRes.json()) as JobResponse;
      if (pollBody.data.status === 'complete') {
        result = pollBody.data.result;
        break;
      }
    }

    expect(result).toBeDefined();
    expect(result?.nodeCount ?? 0).toBeGreaterThan(0);
    expect(result?.capabilities).toContain('read-only');
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
pnpm test:integration 2>&1 | grep -E "txt|plaintext|PASS|FAIL" | tail -10
```

Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/api/parse.integration.test.ts
git commit -m "test(api): integration tests for .txt upload via POST /parse"
```

---

## Task 8: Update `README.md` and open PR

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update status table**

Find:

```markdown
| 2b-iv | Universal file loader: `load:files`, `seed:corpus`, `load_files` MCP tool | ✅ Complete (PR #58) |
| 2c | Firm style template engine (issue #20) | Planned |
```

Replace with:

```markdown
| 2b-iv | Universal file loader: `load:files`, `seed:corpus`, `load_files` MCP tool | ✅ Complete (PR #58) |
| 1c-iii | Plaintext `.txt` parser — 4-signal hierarchy inference, read-only ingest | ✅ Complete (PR #XX) |
| 2c | Firm style template engine (issue #20) | Planned |
```

(Replace `#XX` with the actual PR number after opening the PR.)

- [ ] **Step 2: Add plaintext entry to "What Works Today / Parsing" section**

After the bullet for the 5-signal inference engine, add:

```markdown
- **Plaintext `.txt` parser** — infers CSI hierarchy from text signals: `PART N` headings, `N.N` article numbers, `A.`/`1.`/`a.`/`1)`/`a)` prefix patterns, and leading-whitespace indentation depth as fallback. Section and title extracted from `SECTION XX XX XX` header line; falls back to `inferSectionMeta`. Read-only — no round-trip merge anchors. `POST /parse` accepts `.txt` uploads; `load_files` MCP tool and `pnpm load:files` CLI accept `**/*.txt` globs. Parse job result includes `capabilities: ["read-only"]`.
```

- [ ] **Step 3: Run full suite**

```bash
pnpm lint && pnpm test --project=unit 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 4: Commit README**

```bash
git add README.md
git commit -m "docs: update README status table and What Works Today for plaintext parser"
```

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin feat/plaintext-parser
```

Open PR with body:

```markdown
## Summary
- Add standalone `.txt` spec parser: 4-signal cascade (PART/article/prefix/indentation)
- Wire into `POST /parse`, `load_files` MCP tool, and `pnpm load:files` CLI
- Read-only ingest — `capabilities: ["read-only"]` surfaced in parse job result
- 3 fixture files: UFGS-stripped, numbered-prefixes synthetic, indent-only synthetic

## Test plan
- [ ] `pnpm test --project=unit` — all unit tests pass
- [ ] `pnpm test:integration` — .txt upload and job polling tests pass
- [ ] `pnpm lint` — no errors
- [ ] Manual: `pnpm load:files "tests/fixtures/text/*.txt"` — all 3 fixtures load without error
- [ ] Manual: `pnpm seed:corpus` still works (regression check on SEC path)

Closes #64
```
