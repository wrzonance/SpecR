# Section/Title Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infer CSI section number and title from document content when file metadata is missing, validate against the `csi_sections` ground truth, fuzzy-match titles, and surface inference metadata to MCP callers so LLMs can prompt users for verification.

**Architecture:** Pure `inferSectionMeta(tree)` runs a multi-pattern cascade over the first 50 nodes; `parse()` calls it after each parser returns and updates the tree when inference succeeds. The calling layer (`loadFiles`, `handleParseDocument`) does a `csi_sections` DB lookup and word-Jaccard fuzzy match, then attaches the enriched `SectionInference` to the response.

**Tech Stack:** TypeScript strict, Vitest, existing `pg` pool, no new npm dependencies.

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Create | `src/lib/infer-section.ts` | `inferSectionMeta`, `computeTitleMatch`, `SectionInference` |
| Create | `src/lib/infer-section.test.ts` | Unit tests (pure, no DB) |
| Create | `src/lib/infer-section.integration.test.ts` | Integration tests (real DOCX + DB) |
| Modify | `src/db/queries/search.ts` | Add `lookupCsiSectionTitle` |
| Modify | `src/db/index.ts` | Re-export `lookupCsiSectionTitle` |
| Modify | `src/parser/index.ts` | `ParseResult` + `sectionInference` field; `parse()` calls inferrer |
| Modify | `src/parser/parse.test.ts` | Assert `sectionInference` present in all `parse()` results |
| Modify | `src/lib/file-loader.ts` | `InferenceWarning`, `LoadResult.inferenceWarnings`; lookup + enrich per file |
| Modify | `src/lib/file-loader.test.ts` | Updated mocks + `inferenceWarnings` assertions |
| Modify | `src/mcp/tools.ts` | `handleParseDocument` includes `sectionInference` in response |

---

## Task 1: Add `lookupCsiSectionTitle` to db queries

**Files:**
- Modify: `src/db/queries/search.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: Append `lookupCsiSectionTitle` to `src/db/queries/search.ts`**

Add after the closing brace of `listCsiSections`. The column in `csi_sections` is `title` (verified from existing `listCsiSections` query which uses `cs.title`):

```typescript
export async function lookupCsiSectionTitle(sectionNumber: string): Promise<string | null> {
  try {
    const result = await pool.query<{ title: string }>(
      `SELECT title FROM csi_sections WHERE section_number = $1 LIMIT 1`,
      [sectionNumber]
    );
    return result.rows[0]?.title ?? null;
  } catch (err) {
    throw new DatabaseError('lookupCsiSectionTitle failed', { cause: err });
  }
}
```

- [ ] **Step 2: Re-export from `src/db/index.ts`**

Find:
```typescript
export { searchParagraphs, listCsiSections } from './queries/search.js';
```

Replace with:
```typescript
export { searchParagraphs, listCsiSections, lookupCsiSectionTitle } from './queries/search.js';
```

- [ ] **Step 3: Run lint + unit tests**

```bash
pnpm lint && pnpm test
```

Expected: all pass (no behaviour change yet).

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/search.ts src/db/index.ts
git commit -m "feat(db): add lookupCsiSectionTitle — CSI ground-truth title lookup by section number"
```

---

## Task 2: Create `src/lib/infer-section.ts` + unit tests

**Files:**
- Create: `src/lib/infer-section.test.ts`
- Create: `src/lib/infer-section.ts`

- [ ] **Step 1: Write failing unit tests in `src/lib/infer-section.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { inferSectionMeta, computeTitleMatch } from './infer-section.js';
import type { CsiTree } from '../ast/types.js';

function makeTree(nodes: { text: string }[]): CsiTree {
  return {
    id: 'x',
    section: 'unknown',
    title: 'unknown',
    parts: nodes.map((n, i) => ({
      id: `node-${i}`,
      type: 'part' as const,
      text: n.text,
      children: [],
      meta: {},
    })),
  };
}

describe('inferSectionMeta', () => {
  it('returns method:metadata when section already set', () => {
    const tree: CsiTree = { id: 'x', section: '27 10 00', title: 'Telecom', parts: [] };
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('metadata');
    expect(result.confidence).toBe('high');
    expect(result.inferredSection).toBe('27 10 00');
    expect(result.inferredTitle).toBe('Telecom');
    expect(result.titleMatch).toBe('unknown');
  });

  it('level 1: finds SECTION keyword — confidence high', () => {
    const tree = makeTree([{ text: 'Preamble' }, { text: 'SECTION 26 09 33' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-high');
    expect(result.confidence).toBe('high');
    expect(result.inferredSection).toBe('26 09 33');
  });

  it('level 1: case-insensitive SECTION keyword', () => {
    const tree = makeTree([{ text: 'section 26 09 33' }]);
    expect(inferSectionMeta(tree).inferredSection).toBe('26 09 33');
  });

  it('level 1: extracts title from next node', () => {
    const tree = makeTree([
      { text: 'SECTION 26 09 33' },
      { text: 'VARIABLE FREQUENCY MOTOR CONTROLLERS' },
    ]);
    expect(inferSectionMeta(tree).inferredTitle).toBe('VARIABLE FREQUENCY MOTOR CONTROLLERS');
  });

  it('level 1: extracts inline title when on same line as section keyword', () => {
    const tree = makeTree([{ text: 'SECTION 26 09 33 VARIABLE FREQUENCY MOTOR CONTROLLERS' }]);
    const result = inferSectionMeta(tree);
    expect(result.inferredSection).toBe('26 09 33');
    expect(result.inferredTitle).toBe('VARIABLE FREQUENCY MOTOR CONTROLLERS');
  });

  it('level 1: skips blank nodes to find title', () => {
    const tree = makeTree([
      { text: 'SECTION 26 09 33' },
      { text: '' },
      { text: '   ' },
      { text: 'MOTOR CONTROLLERS' },
    ]);
    expect(inferSectionMeta(tree).inferredTitle).toBe('MOTOR CONTROLLERS');
  });

  it('level 2: bare number only — confidence medium', () => {
    const tree = makeTree([{ text: '26 09 33' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-medium');
    expect(result.confidence).toBe('medium');
    expect(result.inferredSection).toBe('26 09 33');
  });

  it('level 2: bare number embedded in sentence NOT matched', () => {
    const tree = makeTree([{ text: 'See paragraph 26 09 33 for details' }]);
    expect(inferSectionMeta(tree).confidence).toBe('none');
  });

  it('level 1 wins over level 2 when SECTION keyword found first', () => {
    const tree = makeTree([{ text: '26 09 33' }, { text: 'SECTION 27 10 00' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-high');
    expect(result.inferredSection).toBe('27 10 00');
  });

  it('garbage preamble before SECTION line — found within 50 nodes', () => {
    const garbage = Array.from({ length: 40 }, (_, i) => ({ text: `garbage line ${i}` }));
    const tree = makeTree([...garbage, { text: 'SECTION 28 31 00' }]);
    const result = inferSectionMeta(tree);
    expect(result.confidence).toBe('high');
    expect(result.inferredSection).toBe('28 31 00');
  });

  it('returns none when SECTION line is beyond 50 nodes', () => {
    const garbage = Array.from({ length: 51 }, (_, i) => ({ text: `garbage ${i}` }));
    const tree = makeTree([...garbage, { text: 'SECTION 28 31 00' }]);
    expect(inferSectionMeta(tree).confidence).toBe('none');
  });

  it('returns none when nothing found', () => {
    const tree = makeTree([{ text: 'No section info here' }]);
    expect(inferSectionMeta(tree).confidence).toBe('none');
    expect(inferSectionMeta(tree).inferredSection).toBe('unknown');
  });

  it('returns none for empty tree — never throws', () => {
    const tree: CsiTree = { id: 'x', section: 'unknown', title: 'unknown', parts: [] };
    expect(() => inferSectionMeta(tree)).not.toThrow();
    expect(inferSectionMeta(tree).confidence).toBe('none');
  });
});

describe('computeTitleMatch', () => {
  it('exact match (same string)', () => {
    const { titleMatch, titleMatchScore } = computeTitleMatch(
      'Variable Frequency Motor Controllers',
      'Variable Frequency Motor Controllers'
    );
    expect(titleMatch).toBe('exact');
    expect(titleMatchScore).toBe(1);
  });

  it('exact match case-insensitive', () => {
    const { titleMatch } = computeTitleMatch(
      'VARIABLE FREQUENCY MOTOR CONTROLLERS',
      'Variable Frequency Motor Controllers'
    );
    expect(titleMatch).toBe('exact');
  });

  it('close match at or above 0.7', () => {
    const { titleMatch, titleMatchScore } = computeTitleMatch(
      'Variable Frequency Controllers',
      'Variable Frequency Motor Controllers'
    );
    expect(titleMatch).toBe('close');
    expect(titleMatchScore).toBeGreaterThanOrEqual(0.7);
  });

  it('divergent match below 0.7', () => {
    const { titleMatch } = computeTitleMatch('Fire Protection', 'Telecommunications');
    expect(titleMatch).toBe('divergent');
  });

  it('unknown when standardTitle is null', () => {
    const { titleMatch, titleMatchScore } = computeTitleMatch('Anything', null);
    expect(titleMatch).toBe('unknown');
    expect(titleMatchScore).toBeUndefined();
  });

  it('unknown when standardTitle is undefined', () => {
    const { titleMatch } = computeTitleMatch('Anything', undefined);
    expect(titleMatch).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test -- --reporter=verbose src/lib/infer-section.test.ts
```

Expected: FAIL — `inferSectionMeta` not found

- [ ] **Step 3: Create `src/lib/infer-section.ts`**

```typescript
import type { CsiTree, CsiNode } from '../ast/types.js';

export interface SectionInference {
  readonly method: 'metadata' | 'content-high' | 'content-medium' | 'none';
  readonly confidence: 'high' | 'medium' | 'none';
  readonly inferredSection: string;
  readonly inferredTitle: string;
  readonly standardTitle?: string;
  readonly titleMatchScore?: number;
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
}

const KEYWORD_RE = /SECTION\s+(\d{2})\s+(\d{2})\s+(\d{2})/i;
const INLINE_TITLE_RE = /SECTION\s+\d{2}\s+\d{2}\s+\d{2}\s+(.*)/i;
const BARE_NUM_RE = /^(\d{2})\s+(\d{2})\s+(\d{2})$/;
const MAX_NODES = 50;

function flattenNodes(parts: readonly CsiNode[]): readonly CsiNode[] {
  const out: CsiNode[] = [];
  function walk(nodes: readonly CsiNode[]): void {
    for (const n of nodes) {
      if (out.length >= MAX_NODES) return;
      out.push(n);
      walk(n.children);
    }
  }
  walk(parts);
  return out;
}

function isValidTitle(text: string): boolean {
  const t = text.trim();
  return (
    t.length >= 3 &&
    t.length <= 150 &&
    !/^\d+$/.test(t) &&
    !KEYWORD_RE.test(t) &&
    !BARE_NUM_RE.test(t)
  );
}

function findTitle(nodes: readonly CsiNode[], sectionIdx: number): string {
  const inlineMatch = INLINE_TITLE_RE.exec(nodes[sectionIdx]?.text ?? '');
  if (inlineMatch?.[1] && isValidTitle(inlineMatch[1])) return inlineMatch[1].trim();
  for (let i = sectionIdx + 1; i < Math.min(sectionIdx + 11, nodes.length); i++) {
    const t = nodes[i]?.text?.trim() ?? '';
    if (isValidTitle(t)) return t;
  }
  return 'unknown';
}

export function computeTitleMatch(
  inferredTitle: string,
  standardTitle: string | null | undefined
): { titleMatch: SectionInference['titleMatch']; titleMatchScore: number | undefined } {
  if (!standardTitle) return { titleMatch: 'unknown', titleMatchScore: undefined };
  const words = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));
  const wa = words(inferredTitle);
  const wb = words(standardTitle);
  if (inferredTitle.toLowerCase().trim() === standardTitle.toLowerCase().trim()) {
    return { titleMatch: 'exact', titleMatchScore: 1 };
  }
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  const score = union === 0 ? 1 : Math.round((intersection / union) * 100) / 100;
  return { titleMatch: score >= 0.7 ? 'close' : 'divergent', titleMatchScore: score };
}

const NONE_RESULT: SectionInference = {
  method: 'none', confidence: 'none',
  inferredSection: 'unknown', inferredTitle: 'unknown', titleMatch: 'unknown',
};

export function inferSectionMeta(tree: CsiTree): SectionInference {
  try {
    if (tree.section !== 'unknown' && tree.section.trim().length > 0) {
      return { method: 'metadata', confidence: 'high', inferredSection: tree.section, inferredTitle: tree.title, titleMatch: 'unknown' };
    }
    const nodes = flattenNodes(tree.parts);
    for (let i = 0; i < nodes.length; i++) {
      const m = KEYWORD_RE.exec(nodes[i]?.text ?? '');
      if (m) return { method: 'content-high', confidence: 'high', inferredSection: `${m[1]} ${m[2]} ${m[3]}`, inferredTitle: findTitle(nodes, i), titleMatch: 'unknown' };
    }
    for (let i = 0; i < nodes.length; i++) {
      const m = BARE_NUM_RE.exec((nodes[i]?.text ?? '').trim());
      if (m) return { method: 'content-medium', confidence: 'medium', inferredSection: `${m[1]} ${m[2]} ${m[3]}`, inferredTitle: findTitle(nodes, i), titleMatch: 'unknown' };
    }
    return NONE_RESULT;
  } catch {
    return NONE_RESULT;
  }
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
pnpm test -- --reporter=verbose src/lib/infer-section.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full lint + test**

```bash
pnpm lint && pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/infer-section.ts src/lib/infer-section.test.ts
git commit -m "feat(lib): inferSectionMeta — multi-pattern cascade + computeTitleMatch word-Jaccard"
```

---

## Task 3: Update `src/parser/index.ts` — wire inference into `parse()`

**Files:**
- Modify: `src/parser/index.ts`
- Modify: `src/parser/parse.test.ts`

- [ ] **Step 1: Update `src/parser/parse.test.ts`**

The mock tree has `section: '27 10 00'` → inference returns `method: 'metadata'`. Add a new test for the update-on-unknown case. Replace `src/parser/parse.test.ts` entirely:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./sec/index.js', () => ({
  parseSec: vi.fn(),
  assertSecSafe: vi.fn(),
}));
vi.mock('./docx/index.js', () => ({
  parseDocx: vi.fn(),
  assertDocxSafe: vi.fn(),
}));
vi.mock('../lib/decode-text.js', () => ({
  decodeTextBuffer: vi.fn((buf: Buffer) => buf.toString('utf-8')),
}));

import { parse } from './index.js';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { ParserError } from './error.js';
import type { CsiTree } from '../ast/types.js';

const mockTree: CsiTree = { id: 'spec-1', section: '27 10 00', title: 'Test', parts: [] };

beforeEach(() => vi.clearAllMocks());

describe('parse() dispatcher', () => {
  it('dispatches .sec to parseSec via decodeTextBuffer', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    const buf = Buffer.from('<SEC/>');
    const result = await parse(buf, 'spec.SEC');
    expect(decodeTextBuffer).toHaveBeenCalledWith(buf);
    expect(parseSec).toHaveBeenCalled();
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
    expect(result.sectionInference.method).toBe('metadata');
    expect(result.sectionInference.inferredSection).toBe('27 10 00');
  });

  it('dispatches .docx to parseDocx', async () => {
    vi.mocked(parseDocx).mockResolvedValue(mockTree);
    const buf = Buffer.from('PK...');
    const result = await parse(buf, 'spec.docx');
    expect(parseDocx).toHaveBeenCalledWith(buf, expect.any(Function));
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
    expect(result.sectionInference.method).toBe('metadata');
  });

  it('is case-insensitive for extension', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    const result = await parse(Buffer.from(''), 'SPEC.SEC');
    expect(parseSec).toHaveBeenCalled();
    expect(result.sectionInference).toBeDefined();
  });

  it('throws ParserError for unsupported extension', async () => {
    await expect(parse(Buffer.from(''), 'spec.pdf')).rejects.toBeInstanceOf(ParserError);
  });

  it('updates tree section and title when inference fires on unknown section', async () => {
    const unknownTree: CsiTree = {
      id: 'x',
      section: 'unknown',
      title: 'unknown',
      parts: [
        { id: 'n1', type: 'part', text: 'SECTION 26 09 33', children: [], meta: {} },
        { id: 'n2', type: 'part', text: 'MOTOR CONTROLLERS', children: [], meta: {} },
      ],
    };
    vi.mocked(parseSec).mockReturnValue({ tree: unknownTree, refs: [] });
    const result = await parse(Buffer.from(''), 'spec.sec');
    expect(result.tree.section).toBe('26 09 33');
    expect(result.tree.title).toBe('MOTOR CONTROLLERS');
    expect(result.sectionInference.method).toBe('content-high');
    expect(result.sectionInference.confidence).toBe('high');
  });
});
```

- [ ] **Step 2: Run test to confirm new test fails**

```bash
pnpm test -- --reporter=verbose src/parser/parse.test.ts
```

Expected: FAIL on `sectionInference` property.

- [ ] **Step 3: Replace `src/parser/index.ts`**

```typescript
import path from 'node:path';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { inferSectionMeta } from '../lib/infer-section.js';
import type { CsiTree, SecRef } from '../ast/types.js';
import type { SectionInference } from '../lib/infer-section.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx, assertDocxSafe } from './docx/index.js';
export { ParserError } from './error.js';
export type { SectionInference } from '../lib/infer-section.js';

export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;
}

function applyInference(tree: CsiTree, inference: SectionInference): CsiTree {
  if (inference.method === 'metadata' || inference.confidence === 'none') return tree;
  return { ...tree, section: inference.inferredSection, title: inference.inferredTitle };
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
  throw new ParserError(`unsupported format: ${ext}`);
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
pnpm test -- --reporter=verbose src/parser/parse.test.ts
```

Expected: all 5 pass.

- [ ] **Step 5: Run full lint + test**

```bash
pnpm lint && pnpm test
```

Expected: all pass. If `file-loader.test.ts` fails on `sectionInference`, that is fixed in Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/parser/index.ts src/parser/parse.test.ts
git commit -m "feat(parser): wire inferSectionMeta into parse() — applyInference updates tree on content match"
```

---

## Task 4: Update `src/lib/file-loader.ts` + unit tests

**Files:**
- Modify: `src/lib/file-loader.ts`
- Modify: `src/lib/file-loader.test.ts`

- [ ] **Step 1: Replace `src/lib/file-loader.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../parser/index.js', () => ({ parse: vi.fn() }));
vi.mock('../db/index.js', () => ({
  persistParsedSpec: vi.fn(),
  lookupCsiSectionTitle: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { loadFiles } from './file-loader.js';
import { parse } from '../parser/index.js';
import { persistParsedSpec, lookupCsiSectionTitle } from '../db/index.js';
import { readFile } from 'node:fs/promises';
import type { CsiTree } from '../ast/types.js';
import type { SectionInference } from './infer-section.js';

const mockTree: CsiTree = { id: 'x', section: '27 10 00', title: 'T', parts: [] };
const mockBuf = Buffer.from('data');

const metadataInference: SectionInference = {
  method: 'metadata', confidence: 'high',
  inferredSection: '27 10 00', inferredTitle: 'T', titleMatch: 'unknown',
};
const contentInference: SectionInference = {
  method: 'content-high', confidence: 'high',
  inferredSection: '26 09 33', inferredTitle: 'MOTOR CONTROLLERS', titleMatch: 'unknown',
};

beforeEach(() => vi.clearAllMocks());

describe('loadFiles()', () => {
  it('returns zero-result for empty path list', async () => {
    const result = await loadFiles([]);
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0, errors: [], inferenceWarnings: [] });
    expect(parse).not.toHaveBeenCalled();
  });

  it('succeeds with metadata — no inferenceWarning, no lookup', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: metadataInference });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-1');
    const result = await loadFiles(['/a/spec.sec']);
    expect(result.succeeded).toBe(1);
    expect(result.inferenceWarnings).toHaveLength(0);
    expect(lookupCsiSectionTitle).not.toHaveBeenCalled();
  });

  it('adds inferenceWarning when content-high inference fires', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: contentInference });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-2');
    vi.mocked(lookupCsiSectionTitle).mockResolvedValue('Variable Frequency Motor Controllers');
    const result = await loadFiles(['/a/26_09_33.docx']);
    expect(result.succeeded).toBe(1);
    expect(result.inferenceWarnings).toHaveLength(1);
    const w = result.inferenceWarnings[0];
    expect(w?.inferredSection).toBe('26 09 33');
    expect(w?.standardTitle).toBe('Variable Frequency Motor Controllers');
    expect(w?.confidence).toBe('high');
    expect(w?.titleMatch).toMatch(/^(exact|close|divergent|unknown)$/);
    expect(lookupCsiSectionTitle).toHaveBeenCalledWith('26 09 33');
  });

  it('emits warning with standardTitle:null when csi lookup fails', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: contentInference });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-3');
    vi.mocked(lookupCsiSectionTitle).mockRejectedValue(new Error('db fail'));
    const result = await loadFiles(['/a/spec.docx']);
    expect(result.succeeded).toBe(1);
    expect(result.inferenceWarnings).toHaveLength(1);
    expect(result.inferenceWarnings[0]?.standardTitle).toBeNull();
    expect(result.inferenceWarnings[0]?.titleMatch).toBe('unknown');
  });

  it('no lookup and no warning during dryRun', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: contentInference });
    const result = await loadFiles(['/a/spec.docx'], { dryRun: true });
    expect(persistParsedSpec).not.toHaveBeenCalled();
    expect(lookupCsiSectionTitle).not.toHaveBeenCalled();
    expect(result.inferenceWarnings).toHaveLength(0);
  });

  it('isolates parse failure — other files still succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse)
      .mockRejectedValueOnce(new Error('bad xml'))
      .mockResolvedValue({ tree: mockTree, refs: [], sectionInference: metadataInference });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id');
    const result = await loadFiles(['/a/bad.sec', '/b/good.sec']);
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.file).toBe('/a/bad.sec');
    expect(result.inferenceWarnings).toHaveLength(0);
  });

  it('isolates persistParsedSpec failure', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: metadataInference });
    vi.mocked(persistParsedSpec).mockRejectedValue(new Error('db down'));
    const result = await loadFiles(['/a/spec.sec']);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error).toBe('db down');
  });

  it('isolates readFile ENOENT failure', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
    const result = await loadFiles(['/missing/spec.sec']);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error).toContain('no such file');
  });

  it('skips persistParsedSpec when dryRun', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: metadataInference });
    const result = await loadFiles(['/a/spec.sec'], { dryRun: true });
    expect(persistParsedSpec).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(1);
  });

  it('calls onProgress once per file with correct args', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [], sectionInference: metadataInference });
    vi.mocked(persistParsedSpec).mockResolvedValue('id');
    const calls: [number, number, string, boolean][] = [];
    await loadFiles(['/a/spec.sec', '/b/spec.sec'], {
      onProgress: (done, total, file, ok) => calls.push([done, total, file, ok]),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([1, 2, '/a/spec.sec', true]);
    expect(calls[1]).toEqual([2, 2, '/b/spec.sec', true]);
  });

  it('onProgress receives ok=false on failure', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('boom'));
    const okValues: boolean[] = [];
    await loadFiles(['/a/spec.sec'], { onProgress: (_d, _t, _f, ok) => okValues.push(ok) });
    expect(okValues).toEqual([false]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test -- --reporter=verbose src/lib/file-loader.test.ts
```

Expected: FAIL on `inferenceWarnings` not in `LoadResult` and missing `sectionInference` in mock.

- [ ] **Step 3: Replace `src/lib/file-loader.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { parse } from '../parser/index.js';
import { persistParsedSpec, lookupCsiSectionTitle } from '../db/index.js';
import { computeTitleMatch } from './infer-section.js';
import { logger } from './logger.js';
import type { SectionInference } from './infer-section.js';

export interface InferenceWarning {
  readonly file: string;
  readonly specId: string;
  readonly inferredSection: string;
  readonly inferredTitle: string;
  readonly standardTitle: string | null;
  readonly titleMatchScore: number | null;
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
  readonly confidence: 'high' | 'medium';
  readonly note: string;
}

export interface LoadResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly error: string }>;
  readonly inferenceWarnings: ReadonlyArray<InferenceWarning>;
}

export interface LoadOptions {
  readonly dryRun?: boolean;
  readonly onProgress?: (done: number, total: number, file: string, ok: boolean) => void;
}

async function resolveStandardTitle(section: string): Promise<string | null> {
  try {
    return await lookupCsiSectionTitle(section);
  } catch {
    return null;
  }
}

async function buildInferenceWarning(
  file: string,
  specId: string,
  inference: SectionInference
): Promise<InferenceWarning | null> {
  if (inference.method === 'metadata' || inference.confidence === 'none') return null;
  const standardTitle = await resolveStandardTitle(inference.inferredSection);
  const { titleMatch, titleMatchScore } = computeTitleMatch(inference.inferredTitle, standardTitle);
  return {
    file,
    specId,
    inferredSection: inference.inferredSection,
    inferredTitle: inference.inferredTitle,
    standardTitle,
    titleMatchScore: titleMatchScore ?? null,
    titleMatch,
    confidence: inference.confidence,
    note: 'Section metadata missing. Section number and title inferred from document content. Please verify.',
  };
}

function fireProgress(
  opts: LoadOptions | undefined,
  done: number,
  total: number,
  file: string,
  ok: boolean
): void {
  try {
    opts?.onProgress?.(done, total, file, ok);
  } catch (err) {
    logger.warn({ err, file }, 'loadFiles onProgress callback failed');
  }
}

export async function loadFiles(paths: readonly string[], opts?: LoadOptions): Promise<LoadResult> {
  const total = paths.length;
  if (total === 0) return { total: 0, succeeded: 0, failed: 0, errors: [], inferenceWarnings: [] };

  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ readonly file: string; readonly error: string }> = [];
  const inferenceWarnings: InferenceWarning[] = [];
  let done = 0;

  for (const file of paths) {
    let ok = false;
    try {
      const buffer = await readFile(file);
      const result = await parse(buffer, file);
      if (!opts?.dryRun) {
        const specId = await persistParsedSpec(result);
        const warning = await buildInferenceWarning(file, specId, result.sectionInference);
        if (warning) inferenceWarnings.push(warning);
      }
      succeeded++;
      ok = true;
    } catch (err) {
      failed++;
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    fireProgress(opts, done, total, file, ok);
  }

  return { total, succeeded, failed, errors, inferenceWarnings };
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
pnpm test -- --reporter=verbose src/lib/file-loader.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full lint + test**

```bash
pnpm lint && pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/file-loader.ts src/lib/file-loader.test.ts
git commit -m "feat(lib): InferenceWarning in LoadResult — CSI lookup + Jaccard fuzzy match per file"
```

---

## Task 5: Update `handleParseDocument` in `src/mcp/tools.ts`

**Files:**
- Modify: `src/mcp/tools.ts`

`handleParseDocument` calls `parseSec`/`parseDocx` directly (bypassing `parse()` due to per-format security checks). It needs `inferSectionMeta`, tree update, CSI lookup, and `sectionInference` in the response when inference fires.

- [ ] **Step 1: Add imports at top of `src/mcp/tools.ts`**

After the existing imports, add:

```typescript
import { inferSectionMeta, computeTitleMatch } from '../lib/infer-section.js';
import type { SectionInference } from '../lib/infer-section.js';
```

Add `lookupCsiSectionTitle` to the existing db import block (find the block importing from `'../db/index.js'`):

```typescript
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
  persistParsedSpec,
  lookupCsiSectionTitle,
} from '../db/index.js';
```

- [ ] **Step 2: Add two helpers above `handleParseDocument`**

Insert before the `async function handleParseDocument` line:

```typescript
async function resolveStandardTitleForMcp(section: string): Promise<string | null> {
  try {
    return await lookupCsiSectionTitle(section);
  } catch {
    return null;
  }
}

async function enrichInferenceForMcp(
  tree: CsiTree,
  refs: readonly SecRef[]
): Promise<{ tree: CsiTree; refs: readonly SecRef[]; sectionInference: SectionInference }> {
  const raw = inferSectionMeta(tree);
  if (raw.method === 'metadata' || raw.confidence === 'none') {
    return { tree, refs, sectionInference: raw };
  }
  const updatedTree = { ...tree, section: raw.inferredSection, title: raw.inferredTitle };
  const standardTitle = await resolveStandardTitleForMcp(raw.inferredSection);
  const { titleMatch, titleMatchScore } = computeTitleMatch(raw.inferredTitle, standardTitle);
  const sectionInference: SectionInference = {
    ...raw,
    standardTitle: standardTitle ?? undefined,
    titleMatch,
    titleMatchScore,
  };
  return { tree: updatedTree, refs, sectionInference };
}
```

- [ ] **Step 3: Replace `handleParseDocument` body**

Find the current `handleParseDocument`. The section after `if (isToolError(bufOrErr)) return bufOrErr;` should become:

```typescript
    const noop = (_stage: string, _pct: number): void => {};
    const raw: { tree: CsiTree; refs: readonly SecRef[] } =
      ext === '.sec'
        ? parseSec(bufOrErr as string)
        : { tree: await parseDocx(bufOrErr as Buffer, noop), refs: [] };
    const enriched = await enrichInferenceForMcp(raw.tree, raw.refs);
    const specId = await persistParsedSpec(enriched);
    const nodeCount = countNodes(enriched.tree.parts);
    const response: Record<string, unknown> = {
      specId,
      section: enriched.tree.section,
      title: enriched.tree.title,
      nodeCount,
    };
    if (enriched.sectionInference.method !== 'metadata') {
      response['sectionInference'] = {
        ...enriched.sectionInference,
        note: 'Section metadata missing. Section number and title inferred from content. Please verify.',
      };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
```

- [ ] **Step 4: Run lint + full test suite**

```bash
pnpm lint && pnpm test
```

Expected: all pass. If ESLint `max-lines` fires on `tools.ts` (currently 369 lines, adding ~30), extract `enrichInferenceForMcp` to a separate import from `'../lib/infer-section.js'`. If `cognitive-complexity` fires, the two helper functions already keep complexity low.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "feat(mcp): parse_document response includes sectionInference when content inference fires"
```

---

## Task 6: Integration tests

**Files:**
- Create: `src/lib/infer-section.integration.test.ts`

- [ ] **Step 1: Create `src/lib/infer-section.integration.test.ts`**

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pool, lookupCsiSectionTitle } from '../db/index.js';
import { loadFiles } from './file-loader.js';
import { parse } from '../parser/index.js';

const PROJECT_ROOT = path.resolve(process.cwd());
const ARCAT_DOCX = path.join(PROJECT_ROOT, 'docs/references/ARCAT/26_09_33.docx');
const UFGS_SEC = path.join(PROJECT_ROOT, 'docs/references/UFGS/DIVISION_27/27_10_00.SEC');

afterAll(async () => {
  await pool.end();
});

describe('lookupCsiSectionTitle', () => {
  it('returns standard title for known CSI section', async () => {
    const title = await lookupCsiSectionTitle('27 10 00');
    expect(typeof title).toBe('string');
    expect((title ?? '').length).toBeGreaterThan(0);
  });

  it('returns null for section not in csi_sections', async () => {
    const title = await lookupCsiSectionTitle('99 99 99');
    expect(title).toBeNull();
  });
});

describe('parse() with ARCAT DOCX — content inference', () => {
  it('infers a valid CSI section number from content', async () => {
    const buffer = await readFile(ARCAT_DOCX);
    const result = await parse(buffer, ARCAT_DOCX);
    // ARCAT docs lack dc:subject — inference should fire
    expect(result.sectionInference.method).not.toBe('none');
    if (result.sectionInference.confidence !== 'none') {
      expect(result.sectionInference.inferredSection).toMatch(/^\d{2} \d{2} \d{2}$/);
      expect(result.tree.section).toBe(result.sectionInference.inferredSection);
    }
  });
});

describe('parse() with UFGS SEC — metadata path', () => {
  it('uses existing metadata — no content inference fired', async () => {
    const buffer = await readFile(UFGS_SEC);
    const result = await parse(buffer, UFGS_SEC);
    expect(result.sectionInference.method).toBe('metadata');
    expect(result.tree.section).toBe('27 10 00');
  });
});

describe('loadFiles() with inference warnings', () => {
  it('UFGS SEC produces no inferenceWarnings', async () => {
    const result = await loadFiles([UFGS_SEC]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.inferenceWarnings).toHaveLength(0);
  });

  it('inferenceWarning structure is valid when present', async () => {
    const result = await loadFiles([ARCAT_DOCX]);
    expect(result.failed).toBe(0);
    for (const w of result.inferenceWarnings) {
      expect(w.inferredSection).toMatch(/^\d{2} \d{2} \d{2}$/);
      expect(w.confidence).toMatch(/^(high|medium)$/);
      expect(w.titleMatch).toMatch(/^(exact|close|divergent|unknown)$/);
      expect(typeof w.note).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
pnpm test:integration -- --reporter=verbose src/lib/infer-section.integration.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run full suite**

```bash
pnpm lint && pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/infer-section.integration.test.ts
git commit -m "test(lib): infer-section integration tests — ARCAT DOCX inference + CSI lookup + loadFiles warnings"
```

---

## Self-review

- [x] **Spec coverage:** Cascade levels 1+2 ✓ | `computeTitleMatch` Jaccard ✓ | `SectionInference` type ✓ | `ParseResult.sectionInference` always present ✓ | `parse()` applies inference + updates tree ✓ | `lookupCsiSectionTitle` ✓ | `resolveStandardTitle` swallows DB errors ✓ | `InferenceWarning` + `LoadResult.inferenceWarnings` ✓ | `handleParseDocument` conditional `sectionInference` in response ✓ | `load_files` auto-includes `inferenceWarnings` via `JSON.stringify` ✓ | dryRun skips lookup ✓ | inference never blocks parse/persist ✓
- [x] **No placeholders:** all steps have complete code
- [x] **Type consistency:** `SectionInference` defined Task 2, imported Tasks 3/4/5 | `computeTitleMatch` return `{ titleMatch, titleMatchScore }` used identically in Tasks 4 and 5 | `InferenceWarning` defined Task 4, never referenced elsewhere | `lookupCsiSectionTitle` returns `Promise<string | null>` consistent in Task 1 and both callers | `buildInferenceWarning` and `enrichInferenceForMcp` are parallel implementations (not shared) to respect module boundaries — db layer vs mcp layer
- [x] **line limits:** `infer-section.ts` ~90 lines, all functions under 50 | `file-loader.ts` ~75 lines, helper functions extracted | `tools.ts` grows by ~25 lines — check at Task 5 Step 4
