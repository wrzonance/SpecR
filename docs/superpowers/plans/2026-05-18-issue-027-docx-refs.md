# DOCX Cross-Reference Extraction via Format-Agnostic Refs Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a format-agnostic cross-reference extractor (`src/parser/refs/`) that walks any `CsiTree` and surfaces CSI section refs + standards-org refs; wire it into the DOCX parse path so `refs` is no longer hardcoded `[]`.

**Architecture:** New module `src/parser/refs/` contains rules + extraction logic operating purely on `CsiTree` (no format dependencies). DOCX orchestrator calls `extractRefsFromTree(finalTree)` after inference. SEC keeps its current XML-structured extraction (RID→standard lookups have higher fidelity than regex). Existing DOCX rules file is trimmed to ilvl maps only.

**Tech Stack:** TypeScript, Vitest, `docx` library (already a dep — used to synthesize an integration fixture at test time).

**Branch:** `feat/issue-27` — already checked out in worktree `.worktrees/feat/issue-27`.

**Closes #27**

---

## File Structure

**Created:**
- `src/parser/refs/index.ts` — barrel exporting `extractRefsFromTree`, `SECTION_REF_RULES`, `STANDARD_ORG_PATTERNS`, `buildStandardRefRules`, `ExtractionRule`, `StandardOrgPattern`
- `src/parser/refs/rules.ts` — extraction-rule type + section rule + standards-org constants + `buildStandardRefRules` factory
- `src/parser/refs/extract.ts` — `extractRefsFromTree(tree, rules?): readonly SecRef[]` walks `CsiTree`
- `src/parser/refs/rules.test.ts` — unit tests for rule structure + regex behavior
- `src/parser/refs/extract.test.ts` — unit tests for `extractRefsFromTree`
- `src/parser/docx/refs.integration.test.ts` — integration test: synthesize DOCX with `docx` library, parse, assert refs

**Modified:**
- `src/parser/docx/rules.ts` — remove `SECTION_REF_RULES` + `ExtractionRule` interface (now in `refs/`); retain ilvl maps + `ilvlToNodeType`
- `src/parser/docx/rules.test.ts` — remove `SECTION_REF_RULES` test cases (covered by new tests in `refs/`)
- `src/parser/index.ts` — DOCX branch calls `extractRefsFromTree` instead of returning `refs: []`
- `README.md` — "What Works Today" → Parsing → add DOCX cross-ref extraction line

**Deleted:** none. **Migrations:** none. **New deps:** none.

---

## Task 1: Verify worktree branch + read context

**Files:**
- None (read-only)

- [ ] **Step 1: Confirm branch**

```bash
git branch --show-current
```

Expected: `feat/issue-27`. If not, stop and check out the correct branch.

- [ ] **Step 2: Confirm starting commit**

```bash
git log --oneline -1
```

Expected: starts with `b35598e` (or descendant). If you see commits unrelated to issue #27 design, stop.

- [ ] **Step 3: Verify no in-flight changes**

```bash
git status
```

Expected: only the untracked plan file you just created plus possibly untracked fixtures from main. No modified `src/` files.

---

## Task 2: Create `src/parser/refs/rules.ts` with failing test

**Files:**
- Create: `src/parser/refs/rules.test.ts`
- Create: `src/parser/refs/rules.ts`

This task ports `SECTION_REF_RULES` + `ExtractionRule` from `src/parser/docx/rules.ts` and adds `STANDARD_ORG_PATTERNS` + `buildStandardRefRules`.

- [ ] **Step 1: Write the failing test file**

Create `src/parser/refs/rules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SECTION_REF_RULES,
  STANDARD_ORG_PATTERNS,
  buildStandardRefRules,
} from './rules.js';

describe('SECTION_REF_RULES', () => {
  it('csi-section-keyword: each example string matches the pattern', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword');
    expect(rule).toBeDefined();
    for (const example of rule!.examples) {
      const fresh = new RegExp(rule!.pattern.source, rule!.pattern.flags);
      expect(fresh.test(example)).toBe(true);
    }
  });

  it('csi-section-keyword: rejects malformed section numbers', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = (): RegExp => new RegExp(rule.pattern.source, rule.pattern.flags);
    expect(fresh().test('Section 9 91 00')).toBe(false); // missing leading zero
    expect(fresh().test('Section 091 00')).toBe(false); // wrong grouping
  });

  it('every section rule has id, description, pattern, targetType=section, examples', () => {
    for (const rule of SECTION_REF_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(rule.targetType).toBe('section');
      expect(rule.examples.length).toBeGreaterThan(0);
    }
  });
});

describe('STANDARD_ORG_PATTERNS', () => {
  const expectedOrgs = [
    'ASTM', 'ANSI', 'IEEE', 'NFPA', 'UL',
    'NEMA', 'NEC', 'TIA', 'BICSI', 'ASME', 'ASHRAE',
  ];

  it('includes all 11 expected orgs', () => {
    const codes = STANDARD_ORG_PATTERNS.map((o) => o.orgCode);
    for (const expected of expectedOrgs) {
      expect(codes).toContain(expected);
    }
    expect(codes.length).toBe(expectedOrgs.length);
  });

  it('every org has orgCode, displayName, identifierPattern', () => {
    for (const org of STANDARD_ORG_PATTERNS) {
      expect(org.orgCode).toBeTruthy();
      expect(org.displayName).toBeTruthy();
      expect(org.identifierPattern).toBeTruthy();
    }
  });
});

describe('buildStandardRefRules', () => {
  it('returns one rule per org', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    expect(rules.length).toBe(STANDARD_ORG_PATTERNS.length);
  });

  it('each generated rule id is prefixed standard-<lowercased-org>', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    for (const rule of rules) {
      expect(rule.id).toMatch(/^standard-[a-z]+$/);
    }
  });

  it('each generated rule has targetType=standard', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    for (const rule of rules) {
      expect(rule.targetType).toBe('standard');
    }
  });

  it('pattern captures org code as group 1 and identifier as group 2', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const astmRule = rules.find((r) => r.id === 'standard-astm')!;
    const re = new RegExp(astmRule.pattern.source, astmRule.pattern.flags);
    const match = 'Comply with ASTM C150 throughout.'.match(re);
    expect(match).not.toBeNull();
    // Re-create non-global regex for capture extraction:
    const reSingle = new RegExp(astmRule.pattern.source);
    const capture = reSingle.exec('Comply with ASTM C150 throughout.');
    expect(capture).not.toBeNull();
    expect(capture![1]).toBe('ASTM');
    expect(capture![2]).toBe('C150');
  });

  it('ASTM example "ASTM C150" matches', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const re = new RegExp(rules.find((r) => r.id === 'standard-astm')!.pattern.source);
    expect(re.test('ASTM C150')).toBe(true);
  });

  it('NFPA example "NFPA 70" matches', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const re = new RegExp(rules.find((r) => r.id === 'standard-nfpa')!.pattern.source);
    expect(re.test('See NFPA 70 for compliance.')).toBe(true);
  });

  it('IEEE example "IEEE 802.3" matches', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const re = new RegExp(rules.find((r) => r.id === 'standard-ieee')!.pattern.source);
    expect(re.test('Comply with IEEE 802.3 Ethernet.')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/parser/refs/rules
```

Expected: FAIL — module `./rules.js` not found.

- [ ] **Step 3: Create `src/parser/refs/rules.ts`**

```typescript
// Format-agnostic extraction rules: CSI section refs + standards-org refs.
// Operates on any text content reachable through CsiTree walks.
// Rules are data — not code — so agents can inspect, propose, and fix them.

// ─── Rule type ────────────────────────────────────────────────────────────────

export interface ExtractionRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly targetType: 'section' | 'standard';
  readonly examples: readonly string[];
  readonly knownFalsePositives?: readonly string[];
}

// ─── CSI section refs ─────────────────────────────────────────────────────────

export const SECTION_REF_RULES: readonly ExtractionRule[] = [
  {
    id: 'csi-section-keyword',
    description:
      'Matches "Section XX XX XX" — standard CSI cross-reference with keyword prefix. ' +
      'Most reliable pattern; matches how spec writers are trained to cite other sections.',
    pattern: /\bSection\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/gi,
    targetType: 'section',
    examples: ['See Section 09 91 00', 'Section 27 21 00 applies to this work'],
    knownFalsePositives: [],
  },
];

// ─── Standards-org refs ───────────────────────────────────────────────────────

export interface StandardOrgPattern {
  readonly orgCode: string; // 'ASTM', 'NFPA', etc.
  readonly displayName: string;
  readonly identifierPattern: string; // regex fragment after orgCode
}

// 11 orgs in scope for Phase 1c-iii (per design doc).
// Phase 5 UI will migrate this to a standard_orgs DB table populated via CRUD endpoint.
// buildStandardRefRules is the seam — signature unchanged regardless of source.
export const STANDARD_ORG_PATTERNS: readonly StandardOrgPattern[] = [
  { orgCode: 'ASTM',   displayName: 'ASTM International',                              identifierPattern: '[A-Z]?\\d+(?:[\\-./]\\d+[A-Za-z]?)?' },
  { orgCode: 'ANSI',   displayName: 'American National Standards Institute',           identifierPattern: '[A-Z]?\\d+(?:\\.\\d+)?(?:[\\-./]\\d+)?' },
  { orgCode: 'IEEE',   displayName: 'Institute of Electrical & Electronics Eng.',      identifierPattern: '\\d+(?:\\.\\d+)?(?:[\\-./]\\d+)?' },
  { orgCode: 'NFPA',   displayName: 'National Fire Protection Association',            identifierPattern: '\\d+[A-Z]?(?:[\\-./]\\d+)?' },
  { orgCode: 'UL',     displayName: 'Underwriters Laboratories',                       identifierPattern: '\\d+[A-Z]?(?:[\\-./]\\d+)?' },
  { orgCode: 'NEMA',   displayName: 'National Electrical Manufacturers Assoc.',        identifierPattern: '[A-Z]+[\\-\\s]?\\d+(?:[\\-./]\\d+)?' },
  { orgCode: 'NEC',    displayName: 'National Electrical Code',                        identifierPattern: '\\d+(?:[\\-.]\\d+)?' },
  { orgCode: 'TIA',    displayName: 'Telecommunications Industry Association',         identifierPattern: '\\d+[\\-./]?[A-Z]?(?:[\\-./]\\d+)?' },
  { orgCode: 'BICSI',  displayName: 'Building Industry Consulting Service Intl.',      identifierPattern: '\\d+(?:[\\-./]\\d+)?' },
  { orgCode: 'ASME',   displayName: 'American Society of Mechanical Engineers',        identifierPattern: '[A-Z]?\\d+(?:\\.\\d+)?(?:[\\-./]\\d+)?' },
  { orgCode: 'ASHRAE', displayName: 'ASHRAE',                                          identifierPattern: '\\d+(?:[\\-./]\\d+)?' },
];

export function buildStandardRefRules(
  orgs: readonly StandardOrgPattern[]
): readonly ExtractionRule[] {
  return orgs.map((o) => ({
    id: `standard-${o.orgCode.toLowerCase()}`,
    description: `Matches "${o.orgCode} <identifier>" — ${o.displayName} standards.`,
    pattern: new RegExp(`\\b(${o.orgCode})\\s+(${o.identifierPattern})\\b`, 'g'),
    targetType: 'standard' as const,
    examples: [`${o.orgCode} 100`],
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/parser/refs/rules
```

Expected: all tests in the new file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser/refs/rules.ts src/parser/refs/rules.test.ts
git commit -m "feat(parser): add format-agnostic ref extraction rules (refs/rules.ts)

SECTION_REF_RULES + STANDARD_ORG_PATTERNS for 11 standards orgs
(ASTM, ANSI, IEEE, NFPA, UL, NEMA, NEC, TIA, BICSI, ASME, ASHRAE).
buildStandardRefRules factory is the seam for the future
standard_orgs DB table (Phase 5).

Refs: #27"
```

---

## Task 3: Create `src/parser/refs/extract.ts` with failing test

**Files:**
- Create: `src/parser/refs/extract.test.ts`
- Create: `src/parser/refs/extract.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/parser/refs/extract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { extractRefsFromTree } from './extract.js';
import type { CsiNode, CsiTree } from '../../ast/types.js';

function makeNode(
  type: CsiNode['type'],
  text: string,
  children: readonly CsiNode[] = []
): CsiNode {
  return { id: uuidv4(), type, text, children, meta: {} };
}

function treeWith(parts: readonly CsiNode[]): CsiTree {
  return { id: uuidv4(), section: '27 41 00', title: 'TEST', parts };
}

describe('extractRefsFromTree', () => {
  it('extracts section refs: "See Section 09 91 00"', () => {
    const node = makeNode('pr1', 'See Section 09 91 00 for paint.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const sectionRefs = refs.filter((r) => r.targetType === 'section');
    expect(sectionRefs).toHaveLength(1);
    expect(sectionRefs[0]?.targetSpecSection).toBe('09 91 00');
    expect(sectionRefs[0]?.sourceNodeId).toBe(node.id);
    expect(sectionRefs[0]?.referenceText).toMatch(/Section\s+09\s+91\s+00/);
  });

  it('extracts ASTM standard: "Comply with ASTM C150"', () => {
    const node = makeNode('pr1', 'Comply with ASTM C150 throughout.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const standardRefs = refs.filter((r) => r.targetType === 'standard');
    expect(standardRefs).toHaveLength(1);
    expect(standardRefs[0]?.standardCode).toBe('ASTM C150');
    expect(standardRefs[0]?.sourceNodeId).toBe(node.id);
  });

  it('extracts multiple orgs in same node: NFPA 70 and IEEE 802.3', () => {
    const node = makeNode('pr1', 'Per NFPA 70 and IEEE 802.3, install per code.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const codes = refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(codes).toContain('NFPA 70');
    expect(codes).toContain('IEEE 802.3');
  });

  it('extracts both section and standard refs from same node', () => {
    const node = makeNode(
      'pr1',
      'See Section 09 91 00 and comply with ASTM C150.'
    );
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    expect(refs.some((r) => r.targetType === 'section')).toBe(true);
    expect(refs.some((r) => r.targetType === 'standard')).toBe(true);
  });

  it('walks nested children: ref in pr3 returns with correct sourceNodeId', () => {
    const pr3 = makeNode('pr3', 'Per ASTM C150 cement.');
    const pr1 = makeNode('pr1', 'Materials.', [pr3]);
    const article = makeNode('article', '1.1 SCOPE', [pr1]);
    const part = makeNode('part', 'PART 1', [article]);
    const tree = treeWith([part]);
    const refs = extractRefsFromTree(tree);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sourceNodeId).toBe(pr3.id);
  });

  it('case-insensitive section match: lowercase "section 09 91 00"', () => {
    const node = makeNode('pr1', 'see section 09 91 00 for details.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    expect(refs.filter((r) => r.targetType === 'section')).toHaveLength(1);
  });

  it('empty tree (parts: []) → empty refs array', () => {
    const refs = extractRefsFromTree(treeWith([]));
    expect(refs).toEqual([]);
  });

  it('preserves sourceNodeId across all rule types', () => {
    const node = makeNode('pr1', 'See Section 09 91 00, comply with ASTM C150.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    expect(refs.every((r) => r.sourceNodeId === node.id)).toBe(true);
  });

  it('rules parameter override: empty rules array → no refs', () => {
    const node = makeNode('pr1', 'See Section 09 91 00 and ASTM C150.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree, []);
    expect(refs).toEqual([]);
  });

  it('handles all 11 supported orgs', () => {
    const text =
      'Refs: ASTM C150, ANSI 100, IEEE 802.3, NFPA 70, UL 94, ' +
      'NEMA WC-70, NEC 250, TIA 568, BICSI 002, ASME B31.1, ASHRAE 90.1.';
    const node = makeNode('pr1', text);
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const orgs = new Set(
      refs
        .filter((r) => r.targetType === 'standard')
        .map((r) => r.standardCode?.split(' ')[0])
    );
    for (const expected of [
      'ASTM', 'ANSI', 'IEEE', 'NFPA', 'UL',
      'NEMA', 'NEC', 'TIA', 'BICSI', 'ASME', 'ASHRAE',
    ]) {
      expect(orgs).toContain(expected);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/parser/refs/extract
```

Expected: FAIL — module `./extract.js` not found.

- [ ] **Step 3: Create `src/parser/refs/extract.ts`**

```typescript
import type { CsiNode, CsiTree, SecRef } from '../../ast/types.js';
import {
  SECTION_REF_RULES,
  STANDARD_ORG_PATTERNS,
  buildStandardRefRules,
  type ExtractionRule,
} from './rules.js';

const DEFAULT_RULES: readonly ExtractionRule[] = [
  ...SECTION_REF_RULES,
  ...buildStandardRefRules(STANDARD_ORG_PATTERNS),
];

/**
 * Walks the canonical CsiTree, applies each extraction rule against every
 * node.text, and returns SecRef rows ready for insertRefs().
 *
 * Format-agnostic: any parser that produces a CsiTree (DOCX, .txt, future
 * PDF) can call this to fill ParseResult.refs.
 */
export function extractRefsFromTree(
  tree: CsiTree,
  rules: readonly ExtractionRule[] = DEFAULT_RULES
): readonly SecRef[] {
  const refs: SecRef[] = [];
  const walk = (node: CsiNode): void => {
    for (const rule of rules) {
      // Fresh iterator per (rule, node) — global regex state is per-iterator
      // in matchAll, so this is safe and deterministic.
      for (const match of node.text.matchAll(rule.pattern)) {
        refs.push(buildRef(node.id, rule, match));
      }
    }
    node.children.forEach(walk);
  };
  tree.parts.forEach(walk);
  return refs;
}

function buildRef(
  sourceNodeId: string,
  rule: ExtractionRule,
  match: RegExpMatchArray
): SecRef {
  if (rule.targetType === 'section') {
    return {
      sourceNodeId,
      targetType: 'section',
      targetSpecSection: `${match[1]} ${match[2]} ${match[3]}`,
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

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/parser/refs/extract
```

Expected: all tests in the new file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser/refs/extract.ts src/parser/refs/extract.test.ts
git commit -m "feat(parser): extractRefsFromTree walks CsiTree (refs/extract.ts)

Pure, format-agnostic walker — operates on any CsiTree, applies each
ExtractionRule to every node.text, returns SecRef rows. Default rule
set composes SECTION_REF_RULES with buildStandardRefRules over
STANDARD_ORG_PATTERNS.

Refs: #27"
```

---

## Task 4: Add barrel `src/parser/refs/index.ts`

**Files:**
- Create: `src/parser/refs/index.ts`

- [ ] **Step 1: Create the barrel**

```typescript
export {
  extractRefsFromTree,
} from './extract.js';

export {
  SECTION_REF_RULES,
  STANDARD_ORG_PATTERNS,
  buildStandardRefRules,
  type ExtractionRule,
  type StandardOrgPattern,
} from './rules.js';
```

- [ ] **Step 2: Verify build still compiles**

```bash
pnpm build
```

Expected: clean compile, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/parser/refs/index.ts
git commit -m "feat(parser): refs module barrel — exports extractRefsFromTree + rules

Refs: #27"
```

---

## Task 5: Wire `extractRefsFromTree` into orchestrator DOCX branch

**Files:**
- Modify: `src/parser/index.ts`
- Create: `src/parser/refs-wiring.test.ts` (temporary — consolidated in Task 8)

- [ ] **Step 1: Write failing test for orchestrator wiring**

Create `src/parser/refs-wiring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parse } from './index.js';
import { Document, Paragraph, TextRun, Packer } from 'docx';

async function buildDocxBuffer(lines: readonly string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: lines.map(
          (l) =>
            new Paragraph({
              children: [new TextRun(l)],
            })
        ),
      },
    ],
  });
  return await Packer.toBuffer(doc);
}

describe('parse() orchestrator — DOCX refs wiring', () => {
  it('DOCX path returns refs from extractRefsFromTree (no longer empty)', async () => {
    const buffer = await buildDocxBuffer([
      'PART 1 - GENERAL',
      '1.1 REFERENCES',
      'A. See Section 09 91 00 and comply with ASTM C150.',
    ]);
    const result = await parse(buffer, 'fixture.docx');
    expect(result.refs.length).toBeGreaterThan(0);
    const targetSections = result.refs
      .filter((r) => r.targetType === 'section')
      .map((r) => r.targetSpecSection);
    const standardCodes = result.refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(targetSections).toContain('09 91 00');
    expect(standardCodes).toContain('ASTM C150');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/parser/refs-wiring
```

Expected: FAIL — `result.refs.length` is 0 because DOCX branch returns hardcoded `[]`.

- [ ] **Step 3: Modify `src/parser/index.ts` DOCX branch**

Open `src/parser/index.ts`. Add a new import alongside the existing parser imports near the top:

```typescript
import { extractRefsFromTree } from './refs/index.js';
```

Replace the DOCX branch body (currently lines 42-47):

```typescript
  if (ext === '.docx') {
    const noop = (_stage: string, _pct: number): void => {};
    const tree = await parseDocx(buffer, noop);
    const sectionInference = inferSectionMeta(tree);
    const finalTree = applyInference(tree, sectionInference);
    const refs = extractRefsFromTree(finalTree);
    return { tree: finalTree, refs, sectionInference };
  }
```

Also add a re-export from the orchestrator barrel so downstream callers can import from `../parser`:

Append to the block of re-exports near the top of `src/parser/index.ts`:

```typescript
export { extractRefsFromTree } from './refs/index.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/parser/refs-wiring
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser/index.ts src/parser/refs-wiring.test.ts
git commit -m "feat(parser): wire extractRefsFromTree into DOCX parse path

Orchestrator DOCX branch no longer returns refs: []. Calls
extractRefsFromTree(finalTree) after inference; refs now flow through
ParseResult into persistParsedSpec → insertRefs and participate in
broken-reference detection.

Refs: #27"
```

---

## Task 6: Trim `src/parser/docx/rules.ts` — remove `SECTION_REF_RULES` + `ExtractionRule`

**Files:**
- Modify: `src/parser/docx/rules.ts`
- Modify: `src/parser/docx/rules.test.ts`

- [ ] **Step 1: Find all importers of `SECTION_REF_RULES` from `docx/rules`**

```bash
grep -rn "from.*docx/rules" src/ tests/
grep -rn "SECTION_REF_RULES\|ExtractionRule" src/ tests/
```

If anything outside of `parser/docx/rules.ts` and `parser/docx/rules.test.ts` imports `SECTION_REF_RULES` or `ExtractionRule` from `docx/rules`, update those imports to come from `../refs/index.js` instead. (As of the design, no such importer exists, but verify.)

- [ ] **Step 2: Modify `src/parser/docx/rules.ts` — remove section refs**

Open `src/parser/docx/rules.ts` and remove:
- The `ExtractionRule` interface (lines 9-16 in current file)
- The `SECTION_REF_RULES` constant (lines 18-29 in current file)
- The comment block "// ─── Cross-reference extraction rules ─────"

The file should retain ONLY:
- The top comment "// Extraction rules and ilvl signal maps..."
- `import type { NodeType } from '../../ast/types.js';`
- `// ─── ilvl → NodeType signal maps ─────`
- `IlvlSignalRule` interface
- `ARCAT_ILVL_MAP`
- `CPI_ILVL_MAP`
- `NODE_TYPE_SEQUENCE`
- `ilvlToNodeType` function

Tighten the top comment to reflect the narrower scope:

```typescript
// ilvl signal maps and ilvl → NodeType resolution for DOCX parsing.
// Plain-language descriptions make these surfaceable to LLMs via MCP tools.
// Rules are data — not code — so agents can inspect, propose, and fix them.
//
// Format-agnostic cross-reference extraction (SECTION_REF_RULES, standards
// orgs) now lives in src/parser/refs/.
```

- [ ] **Step 3: Modify `src/parser/docx/rules.test.ts` — remove section-ref tests**

Open `src/parser/docx/rules.test.ts`. Remove:
- The import of `SECTION_REF_RULES` from the top import line
- The entire `describe('SECTION_REF_RULES — structure', ...)` block (lines 30-55 currently)

Top import becomes:

```typescript
import { ilvlToNodeType, ARCAT_ILVL_MAP, CPI_ILVL_MAP } from './rules.js';
```

Retain the `describe('ilvlToNodeType', ...)` and `describe('ilvl maps — documentation completeness', ...)` blocks.

- [ ] **Step 4: Verify all tests still pass**

```bash
pnpm test src/parser/docx/rules
```

Expected: PASS (only ilvl tests now).

```bash
pnpm test src/parser/docx
```

Expected: full DOCX suite PASSES — no regressions from removing the import surface.

- [ ] **Step 5: Verify build**

```bash
pnpm build
```

Expected: clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/parser/docx/rules.ts src/parser/docx/rules.test.ts
git commit -m "refactor(parser): move SECTION_REF_RULES out of docx/rules

src/parser/docx/rules.ts now contains only ilvl signal maps and
ilvlToNodeType — the DOCX-specific parts. Format-agnostic extraction
rules live in src/parser/refs/rules.ts (Task 2).

Refs: #27"
```

---

## Task 7: Integration test — synthetic DOCX through orchestrator

**Files:**
- Create: `src/parser/docx/refs.integration.test.ts`

This test exercises the full DOCX parse path end-to-end (`parse(buffer, 'fixture.docx')` produces refs) using a DOCX synthesized via the `docx` library, avoiding any copyrighted fixture.

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { Document, Paragraph, TextRun, Packer } from 'docx';
import { parse } from '../index.js';
import type { SecRef } from '../../ast/types.js';

async function buildDocxBuffer(lines: readonly string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: lines.map(
          (l) =>
            new Paragraph({
              children: [new TextRun(l)],
            })
        ),
      },
    ],
  });
  return await Packer.toBuffer(doc);
}

describe('integration: DOCX cross-reference extraction', () => {
  let refs: readonly SecRef[];

  beforeAll(async () => {
    const buffer = await buildDocxBuffer([
      'PART 1 - GENERAL',
      '1.1 REFERENCES',
      'A. See Section 09 91 00 for paint and coating requirements.',
      'B. Comply with ASTM C150 for cement.',
      'C. All wiring per NFPA 70 and IEEE 802.3 standards.',
      'D. Listed UL 94 V-0 plenum rated.',
      '1.2 SCOPE',
      'A. Work includes Section 26 05 19 conductors.',
    ]);
    const result = await parse(buffer, 'fixture.docx');
    refs = result.refs;
  });

  it('returns a non-empty refs array', () => {
    expect(refs.length).toBeGreaterThan(0);
  });

  it('extracts CSI section ref "Section 09 91 00"', () => {
    const sections = refs
      .filter((r) => r.targetType === 'section')
      .map((r) => r.targetSpecSection);
    expect(sections).toContain('09 91 00');
  });

  it('extracts second CSI section ref "Section 26 05 19"', () => {
    const sections = refs
      .filter((r) => r.targetType === 'section')
      .map((r) => r.targetSpecSection);
    expect(sections).toContain('26 05 19');
  });

  it('extracts ASTM standard ref "ASTM C150"', () => {
    const codes = refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(codes).toContain('ASTM C150');
  });

  it('extracts NFPA standard ref "NFPA 70"', () => {
    const codes = refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(codes).toContain('NFPA 70');
  });

  it('extracts IEEE standard ref "IEEE 802.3"', () => {
    const codes = refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(codes).toContain('IEEE 802.3');
  });

  it('extracts UL standard ref "UL 94"', () => {
    const codes = refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(codes).toContain('UL 94');
  });

  it('every ref has a non-empty sourceNodeId (valid UUID-ish)', () => {
    expect(refs.every((r) => r.sourceNodeId.length > 0)).toBe(true);
  });

  it('every ref has a non-empty referenceText', () => {
    expect(refs.every((r) => r.referenceText.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
pnpm test src/parser/docx/refs.integration
```

Expected: all tests PASS. (Wiring from Task 5 made this possible.)

- [ ] **Step 3: Commit**

```bash
git add src/parser/docx/refs.integration.test.ts
git commit -m "test(parser): DOCX cross-ref extraction integration test

Synthesizes a DOCX buffer with the docx library (already a dep)
containing CSI section refs and refs to ASTM/NFPA/IEEE/UL — no
copyrighted fixture needed. Drives the full parse() orchestrator
path and asserts refs flow through.

Refs: #27"
```

---

## Task 8: Remove the standalone wiring test (redundant with integration)

**Files:**
- Delete: `src/parser/refs-wiring.test.ts`

- [ ] **Step 1: Rationale**

The integration test in `src/parser/docx/refs.integration.test.ts` is a strict superset of `src/parser/refs-wiring.test.ts` (more orgs covered, more assertions). Delete the wiring file to avoid duplication.

- [ ] **Step 2: Delete + verify**

```bash
git rm src/parser/refs-wiring.test.ts
pnpm test src/parser
```

Expected: parser suite passes; integration file covers all the wiring assertions.

- [ ] **Step 3: Commit**

```bash
git commit -m "test(parser): consolidate refs-wiring test into refs.integration

The integration test in src/parser/docx/refs.integration.test.ts is a
superset — covers section refs, all 4 example standards, and node-id
preservation. Removing duplicate.

Refs: #27"
```

---

## Task 9: Update README "What Works Today" → Parsing

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the inference engine line**

```bash
grep -n "5-signal hierarchy inference" README.md
```

Expected: matches line 44.

- [ ] **Step 2: Add DOCX cross-ref line**

In `README.md` under "### Parsing", insert a new bullet immediately after the 5-signal inference engine bullet (line 44) and before the "Extraction rules as typed data constants" bullet:

```markdown
- **DOCX cross-reference extraction** — format-agnostic refs module (`src/parser/refs/`) walks the canonical `CsiTree` after inference; extracts CSI section refs (`Section XX XX XX`) and standards-org refs for ASTM, ANSI, IEEE, NFPA, UL, NEMA, NEC, TIA, BICSI, ASME, ASHRAE. Refs flow into `spec_references` and participate in `GET /projects/:id/references/broken` cascade detection.
```

- [ ] **Step 3: Verify README diff**

```bash
git diff README.md | head -40
```

Confirm only the one new bullet is added in the Parsing subsection.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document DOCX cross-reference extraction

Refs: #27"
```

---

## Task 10: Full verification — lint, typecheck, full test, build

**Files:**
- None (verification only)

- [ ] **Step 1: Lint + typecheck**

```bash
pnpm lint
```

Expected: 0 errors, 0 warnings. If `complexity`, `max-lines-per-function`, or `sonarjs/cognitive-complexity` flags `extractRefsFromTree`, refactor (split `walk` into a helper that returns refs immutably) until under the threshold.

- [ ] **Step 2: Full unit test pass**

```bash
pnpm test
```

Expected: green. Specifically:
- `src/parser/refs/rules.test.ts` — green
- `src/parser/refs/extract.test.ts` — green
- `src/parser/docx/rules.test.ts` — green (no SECTION_REF_RULES tests, ilvl tests intact)
- `src/parser/docx/refs.integration.test.ts` — green
- All other DOCX, SEC, text parser, generator, MCP, db tests — green

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: clean compile to `dist/`.

- [ ] **Step 4: (If postgres available) integration tests**

```bash
pnpm test:integration
```

Expected: green. (If integration races locally, retry with `--pool=forks --poolOptions.forks.singleFork=true` per the issue note.)

- [ ] **Step 5: Confirm no commits to main**

```bash
git log main..feat/issue-27 --oneline
```

Expected: several commits from Tasks 2-9, none on `main`.

```bash
git diff --stat main..feat/issue-27
```

Expected: LOC delta under 500 excluding test files / fixtures.

- [ ] **Step 6: Commit nothing — this task is verification only**

If a commit IS needed (e.g. a lint fix), add it as its own small commit:

```bash
git add <fixed-file>
git commit -m "chore(parser): lint fixup in refs/<file>

Refs: #27"
```

---

## Task 11: Push and open PR (handled by `finishing-a-development-branch`)

**Files:** none

- [ ] **Step 1: Final state**

Ensure `git status` shows a clean tree and `git log` shows the Task 2-9 commits in order.

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`**

Choose option 2 (Push + PR). The PR body MUST include `Closes #27`.

PR title: `feat(parser): DOCX cross-reference extraction — format-agnostic refs module`

PR body should include:
- Summary of the new `src/parser/refs/` module + standards-org coverage
- Test plan (the commands from Task 10)
- `Closes #27`
- A note that SEC / text / PDF parsers keep their current ref behavior (out of scope per design)

---

## Out of Scope (reminder — do NOT do these)

- SEC parser migration to shared `refs/` module
- Text parser ref extraction
- PDF parser
- `standard_orgs` DB table or CRUD endpoint
- Dedupe between regex-extracted and structurally-extracted refs
- API `parseHandler` modification to call `insertRefs` (that path uses `persistTree` not `persistParsedSpec`; separate gap, not this issue)
- Surfacing refs in MCP tools
- Validating standard codes against external registries

---

## Self-Review Notes

- Spec coverage: every acceptance criterion in the design's "Acceptance Criteria" is covered:
  - `src/parser/refs/` exists with `extractRefsFromTree` — Tasks 2, 3, 4
  - DOCX with `See Section 09 91 00` → `target_spec_section = '09 91 00'` — Task 7
  - DOCX with `ASTM C150` → `standard_code = 'ASTM C150'` — Task 7
  - 11 supported orgs — Task 3 (unit) + Task 7 (integration)
  - No regression — Task 6 + Task 10
  - SEC parser behavior unchanged — no SEC files modified
  - Lint + build green — Task 10
- Placeholders: none. Every code block contains complete, ready-to-paste source.
- Type consistency: `ExtractionRule`, `StandardOrgPattern`, `extractRefsFromTree`, `buildStandardRefRules` — signatures match across rules.ts, extract.ts, index.ts, and tests.
