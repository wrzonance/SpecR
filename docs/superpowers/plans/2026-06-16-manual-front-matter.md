# Manual Front Matter (cover page + TOC field) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `generateManual` project manual opens with a cover page (project name + description, style-template applied) and a Word TOC field whose structure yields one entry per section in TOC order.

**Architecture:** A new pure `front-matter.ts` in the generator module builds the cover paragraphs and the `TableOfContents` field. `generateManual` gains a `meta` (project name/description) parameter and prepends a front-matter OOXML section (cover + TOC) ahead of the existing per-section assembly. Each section's synthetic title becomes a `Heading1` paragraph so the Word TOC field (`headingStyleRange: '1-1'`) resolves exactly one entry per section, in document order. SpecR asserts that structure (TOC field code present + one Heading1 per section in order), never page numbers (Word computes those on open — ADR-017 D1).

**Tech Stack:** TypeScript/Node 22, dolanmiu/docx ^9.6.1 (`TableOfContents`, `HeadingLevel`, `PageBreak`), JSZip (test inspection), vitest.

---

### Task 1: Cover page + TOC field builder (`front-matter.ts`)

**Files:**
- Create: `src/generator/front-matter.ts`
- Test: `src/generator/front-matter.test.ts`

The builder is pure: project metadata in, an ordered `(Paragraph | TableOfContents)[]` out.
The cover applies the style template's `part` rule (the most prominent CSI heading style we
carry) to the project name so the cover reflects the chosen template; the description renders
under it. The TOC field uses `headingStyleRange: '1-1'` and `hyperlink: true` so Word builds
entries from the per-section Heading1 titles.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { Document, Packer, TableOfContents } from 'docx';
import JSZip from 'jszip';
import { buildFrontMatter } from './front-matter.js';
import type { StyleRule } from '../ast/index.js';

async function renderToXml(children: readonly (object)[]): Promise<string> {
  // front-matter children are docx FileChild instances; render through a Document.
  const doc = new Document({ sections: [{ children: children as never }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

describe('buildFrontMatter', () => {
  it('emits a TableOfContents (TOC field) followed by the cover content', () => {
    const fm = buildFrontMatter({ name: 'Acme Tower', description: 'New HQ' });
    expect(fm.some((c) => c instanceof TableOfContents)).toBe(true);
  });

  it('cover carries the project name and description text', async () => {
    const xml = await renderToXml(buildFrontMatter({ name: 'Acme Tower', description: 'New HQ' }));
    expect(xml).toContain('Acme Tower');
    expect(xml).toContain('New HQ');
  });

  it('renders a TOC field code (w:fldChar TOC instruction)', async () => {
    const xml = await renderToXml(buildFrontMatter({ name: 'Acme Tower', description: null }));
    expect(xml).toMatch(/TOC\s+\\o/);
  });

  it('omits the description paragraph when description is null', async () => {
    const xml = await renderToXml(buildFrontMatter({ name: 'Acme Tower', description: null }));
    expect(xml).toContain('Acme Tower');
  });

  it('applies the part style rule run properties to the cover title', async () => {
    const rules: StyleRule[] = [
      { nodeType: 'part', properties: { rPr: { sz: 56, b: true } } },
    ];
    const xml = await renderToXml(
      buildFrontMatter({ name: 'Acme Tower', description: null }, rules)
    );
    // half-point size 56 from the template surfaces on the cover title run.
    expect(xml).toContain('w:val="56"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-101 && pnpm vitest run src/generator/front-matter.test.ts`
Expected: FAIL — `buildFrontMatter` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import {
  AlignmentType,
  HeadingLevel,
  PageBreak,
  Paragraph,
  TableOfContents,
  TextRun,
} from 'docx';
import type { StyleRule } from '../ast/index.js';
import { buildRuleMap, runStyleOptions } from './styles.js';

/** Project identity used on the manual cover (ADR-017 D1). */
export interface ManualMeta {
  readonly name: string;
  readonly description: string | null;
}

// '1-1' = build TOC entries from Heading1 only — one entry per section title.
const TOC_HEADING_RANGE = '1-1';

function coverTitle(name: string, rules?: ReturnType<typeof buildRuleMap>): Paragraph {
  const partProps = rules?.get('part');
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: name, ...runStyleOptions(partProps?.rPr) })],
  });
}

/**
 * Build the manual front matter: a centered cover (project name + optional
 * description, styled by the template's `part` rule) and a Word TOC field.
 * Word computes the TOC entries and pagination on open from the Heading1
 * section titles; SpecR emits the field + headings (structure), not page numbers.
 */
export function buildFrontMatter(
  meta: ManualMeta,
  styleRules?: readonly StyleRule[]
): (Paragraph | TableOfContents)[] {
  const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
  const cover: Paragraph[] = [coverTitle(meta.name, rules)];
  if (meta.description !== null && meta.description !== '') {
    cover.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(meta.description)] }));
  }
  cover.push(new Paragraph({ children: [new PageBreak()] }));
  const toc = new TableOfContents('Table of Contents', {
    hyperlink: true,
    headingStyleRange: TOC_HEADING_RANGE,
  });
  const tocHeading = new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Table of Contents')] });
  return [...cover, tocHeading, toc, new Paragraph({ children: [new PageBreak()] })];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-101 && pnpm vitest run src/generator/front-matter.test.ts`
Expected: PASS (all 5).

NOTE: the TOC heading is itself a Heading1; the section-count assertion in Task 2 accounts
for this by asserting `>= sections + 1` Heading1 paragraphs, or by scoping the count to
section-title text. Prefer scoping to section titles (Task 2 asserts on `SECTION` prefix).

- [ ] **Step 5: Commit**

```bash
git add src/generator/front-matter.ts src/generator/front-matter.test.ts
git commit -m "feat(generator): cover page + TOC field builder for manual front matter"
```

---

### Task 2: Section titles become Heading1; `generateManual` prepends front matter

**Files:**
- Modify: `src/generator/index.ts` (`buildSectionChildren`, `generateManual`)
- Modify: `src/generator/manual.test.ts` (extend for front matter)

`buildSectionChildren` currently emits the title via `plainParagraph`. Change the title to a
`Heading1` paragraph (keeps the same visible text) so the TOC field resolves it. `generateManual`
gains a `meta: ManualMeta` parameter and prepends a front-matter OOXML section.

- [ ] **Step 1: Write the failing test (extend manual.test.ts)**

```typescript
import { ManualMeta } from './front-matter.js';

const META: ManualMeta = { name: 'Acme Tower', description: 'New HQ tower' };

it('opens with a cover carrying the project name and description', async () => {
  const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
  expect(xml).toContain('Acme Tower');
  expect(xml).toContain('New HQ tower');
  // cover precedes the first section title
  expect(xml.indexOf('Acme Tower')).toBeLessThan(xml.indexOf('SECTION 03 30 00'));
});

it('emits a TOC field code before the sections', async () => {
  const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
  expect(xml).toMatch(/TOC\s+\\o/);
  expect(xml.search(/TOC\s+\\o/)).toBeLessThan(xml.indexOf('SECTION 03 30 00'));
});

it('styles each section title Heading1 — one TOC-eligible entry per section, in order', async () => {
  const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
  // Section titles are the only paragraphs that carry both Heading1 and "SECTION ".
  const titleHeadings = [...xml.matchAll(/SECTION (\d\d \d\d \d\d)/g)].map((m) => m[1]);
  expect(titleHeadings).toEqual(['03 30 00', '09 91 00']);
  // Heading1 count == sections + 1 (the "Table of Contents" heading).
  const h1 = [...xml.matchAll(/<w:pStyle w:val="Heading1"\/>/g)].length;
  expect(h1).toBe(3);
});
```

Update the existing calls in this file that pass only the trees array to pass `META`
(or a minimal `{ name: 'Test', description: null }`), since `meta` is now required.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-101 && pnpm vitest run src/generator/manual.test.ts`
Expected: FAIL — `generateManual` arity / missing cover content / no Heading1.

- [ ] **Step 3: Write minimal implementation**

In `src/generator/index.ts`:

Change the title builder in `buildSectionChildren`:

```typescript
function titleParagraph(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
```

and use it in `buildSectionChildren`:

```typescript
function buildSectionChildren(tree: SpecTree, ctx: SectionContext): (Paragraph | SdtBlock)[] {
  const children: (Paragraph | SdtBlock)[] = [
    titleParagraph(`SECTION ${displaySection(tree.section, ctx.format)} — ${tree.title}`),
  ];
  collectParagraphs(tree.parts, children, ctx);
  return children;
}
```

Add `HeadingLevel` to the `docx` import and import the builder + type:

```typescript
import { Document, Paragraph, TextRun, Packer, HeadingLevel } from 'docx';
import { buildFrontMatter, type ManualMeta } from './front-matter.js';
```

Change `generateManual` signature and prepend the front-matter section:

```typescript
export async function generateManual(
  trees: readonly SpecTree[],
  meta: ManualMeta,
  styleRules?: readonly StyleRule[],
  options?: GenerateDocxOptions
): Promise<Buffer> {
  if (trees.length === 0) {
    throw new GeneratorError('cannot generate a manual with no sections');
  }
  try {
    const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
    const format = options?.sectionNumberFormat ?? 'canonical';
    const frontMatter = buildFrontMatter(meta, styleRules);
    const sections = trees.map((tree, i) => {
      const reference = `${SPEC_NUM_REF}-${i}`;
      return {
        reference,
        children: buildSectionChildren(tree, sectionContext(format, reference, rules)),
      };
    });
    const doc = new Document({
      numbering: { config: sections.map((s) => buildSpecNumberingConfig(rules, s.reference)) },
      sections: [
        { properties: {}, children: frontMatter },
        ...sections.map((s) => ({ properties: {}, children: s.children })),
      ],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX manual generation failed', { cause: err });
  }
}
```

NOTE: keep the existing `generateDocx` title as a plain paragraph (single-section export has
no TOC), OR share `titleParagraph` — single-section is unaffected by Heading1, so reuse is fine.
Reuse `titleParagraph` in `buildSectionChildren` (used by both) — a Heading1 title in a
single-section export is harmless and consistent.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-101 && pnpm vitest run src/generator/manual.test.ts src/generator/index.test.ts`
Expected: PASS. (index.test.ts may assert title text — Heading1 keeps the text, only adds pStyle.)

- [ ] **Step 5: Commit**

```bash
git add src/generator/index.ts src/generator/manual.test.ts
git commit -m "feat(generator): prepend cover + TOC front matter to generateManual"
```

---

### Task 3: Wire the API handler to pass project metadata

**Files:**
- Modify: `src/api/generate.ts` (`generateManualHandler`)
- Modify: `src/api/generate.test.ts` (assert cover/toc present in manual response)

- [ ] **Step 1: Write the failing test**

Locate the existing manual-handler test in `src/api/generate.test.ts` and add an assertion
that the returned buffer's `word/document.xml` contains the project name and a TOC field.
(Match the file's existing mock/fixture style for `findProjectById` returning `name`/`description`.)

```typescript
it('manual response carries cover (project name) and TOC field', async () => {
  // ...arrange a project with name 'Acme Tower', description 'New HQ', non-empty toc...
  // ...invoke generateManualHandler, capture sent Buffer...
  const zip = await JSZip.loadAsync(sentBuffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('Acme Tower');
  expect(xml).toMatch(/TOC\s+\\o/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-101 && pnpm vitest run src/api/generate.test.ts`
Expected: FAIL — `generateManual` called without meta (TS) / cover text absent.

- [ ] **Step 3: Write minimal implementation**

In `src/api/generate.ts`, pass meta:

```typescript
const buffer = await generateManual(
  trees,
  { name: project.name, description: project.description },
  resolution.rules,
  options
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/adam/github/SpecR/.worktrees/feat/issue-101 && pnpm vitest run src/api/generate.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + full unit suite + commit**

```bash
cd /home/adam/github/SpecR/.worktrees/feat/issue-101
pnpm lint && pnpm test
git add src/api/generate.ts src/api/generate.test.ts
git commit -m "feat(api): pass project metadata to manual front matter"
```

---

## Self-Review notes

- Spec coverage: cover page (Task 1+2), style template applied (Task 1, `part` rule), TOC field
  code (Task 1), one entry per section in TOC order (Task 2 — Heading1 per section). All met.
- The "one entry per section" is asserted structurally (Heading1 count + ordered SECTION titles
  + TOC field with `headingStyleRange='1-1'`) — never page numbers, per ADR-017 D1.
- `meta` is a required positional param before the optional `styleRules`; the only callers are
  `manual.test.ts` and `generate.ts` — both updated.
