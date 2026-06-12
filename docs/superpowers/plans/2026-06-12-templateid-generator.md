# Wire templateId Through Generator (Phase 2c-iii, issue #32) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /specs/:id/generate` loads the requested (or default) style template from the DB and applies its font, spacing, indent, and numbering-format rules to the generated DOCX.

**Architecture:** The `StyleRule` data shape relocates from `db/queries/templates.ts` to `ast/types.ts` (the foundational layer) so `generator/` can accept rules without importing `db/` — mirroring the `ParagraphSnapshot`/`StyleNodeType` precedent. A new pure module `generator/styles.ts` translates ADR-021 `StyleProperties` JSONB payloads into dolanmiu/docx run/paragraph options; `generator/numbering.ts` accepts per-level numbering overrides; `generateDocx` takes an optional `styleRules` second arg. The API handler resolves `templateId` → rules: explicit unknown id → 404; omitted id → the seeded `UFGS-Default` template (so an explicit default-template request is provably identical to a no-template request — acceptance criterion 1).

**Tech Stack:** TypeScript/Node 22, Express, Zod v4 (`z.uuid()`, `.exactOptional()`), dolanmiu/docx 9.x, vitest, pg.

**Key design decisions (document in PR):**
1. **Default template applied when `templateId` omitted.** Acceptance criterion "default template ID → identical output to no-template request" only holds if the no-template path also applies `UFGS-Default`. If `UFGS-Default` is missing (un-migrated DB), fall back to unstyled output rather than fail.
2. **`numbering.ilvl` from template rules is ignored.** Structural level mapping is generator-owned (`getNodeLevel`); template `ilvl` describes the *source* document, not our output. Only `numFmt`, `lvlText`, `start` are applied.
3. **Unknown `numFmt` strings are ignored** (default level format kept) — open JSONB schema may carry values docx can't render; warn-don't-reject per ADR-021.
4. **`note`/`continuation`/title paragraphs stay unstyled** — `StyleNodeType` excludes them by design (migration 010/ADR-021).
5. **Identity comparison in tests uses `word/document.xml` + `word/numbering.xml`**, not whole-buffer bytes — `docProps/core.xml` carries timestamps.
6. **MCP `generate_docx` tool unchanged** (still template-less) — REST endpoint only, per issue scope.

---

### Task 1: Relocate `StyleRule` to ast + add `GenerateBodySchema`

**Files:**
- Modify: `src/ast/types.ts` (add `StyleRule` after `NumberingDef`)
- Modify: `src/ast/schemas.ts` (add `GenerateBodySchema` after `UpsertStyleRulesBody`)
- Modify: `src/ast/index.ts` (export both)
- Modify: `src/db/queries/templates.ts` (re-export instead of define)
- Test: `src/ast/style-schemas.test.ts`

- [ ] **Step 1: Write failing tests** — append to `src/ast/style-schemas.test.ts`:

```typescript
import { GenerateBodySchema } from './schemas.js';

describe('GenerateBodySchema (generate request body)', () => {
  it('accepts an empty body', () => {
    expect(GenerateBodySchema.parse({})).toEqual({});
  });

  it('accepts a valid templateId UUID', () => {
    const body = { templateId: '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef' };
    expect(GenerateBodySchema.parse(body)).toEqual(body);
  });

  it('rejects a non-UUID templateId', () => {
    expect(() => GenerateBodySchema.parse({ templateId: 'not-a-uuid' })).toThrow();
  });

  it('rejects explicit undefined templateId (exactOptional)', () => {
    expect(() => GenerateBodySchema.parse({ templateId: undefined })).toThrow();
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run --project unit src/ast/style-schemas.test.ts` — expect FAIL (no export).
- [ ] **Step 3: Implement.**

`src/ast/types.ts` — after `NumberingDef`:
```typescript
/**
 * One per-NodeType style rule: the (nodeType, properties) pair stored in
 * style_rules. Lives in ast/ (foundational layer) so generator/ can accept
 * rules without importing db/ — mirrors the StyleNodeType relocation (#31).
 */
export interface StyleRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}
```

`src/ast/schemas.ts` — after `UpsertStyleRulesBody`:
```typescript
export const GenerateBodySchema = z.object({
  templateId: z.uuid().exactOptional(),
});

export type GenerateBody = z.infer<typeof GenerateBodySchema>;
```

`src/ast/index.ts`: add `StyleRule` to the style type export block from `./types.js`; add `GenerateBodySchema` to the schema value exports and `GenerateBody` to the schema type exports.

`src/db/queries/templates.ts`: delete the local `export interface StyleRule {...}`; instead import `StyleRule` in the existing `import type` from `'../../ast/types.js'` and add it to the `export type { ... }` re-export line.

- [ ] **Step 4: Run** `pnpm vitest run --project unit src/ast src/db` — expect PASS; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(ast): StyleRule shape + GenerateBodySchema for templateId wiring (#32)`

### Task 2: `generator/styles.ts` — StyleProperties → docx options (pure)

**Files:**
- Create: `src/generator/styles.ts`
- Test: `src/generator/styles.test.ts`

- [ ] **Step 1: Write failing tests** `src/generator/styles.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildRuleMap, runStyleOptions, paragraphStyleOptions } from './styles.js';
import type { StyleRule } from '../ast/index.js';

describe('buildRuleMap', () => {
  it('maps nodeType to properties', () => {
    const rules: StyleRule[] = [{ nodeType: 'part', properties: { rPr: { b: true } } }];
    const map = buildRuleMap(rules);
    expect(map.get('part')).toEqual({ rPr: { b: true } });
    expect(map.get('article')).toBeUndefined();
  });
});

describe('runStyleOptions', () => {
  it('returns {} for undefined rPr', () => {
    expect(runStyleOptions(undefined)).toEqual({});
  });

  it('maps font family, size, bold, italics, caps, smallCaps', () => {
    expect(
      runStyleOptions({ rFonts: { ascii: 'Arial' }, sz: 24, b: true, i: true, caps: true, smallCaps: false })
    ).toEqual({ font: 'Arial', size: 24, bold: true, italics: true, allCaps: true, smallCaps: false });
  });

  it('omits keys absent from the payload (exactOptionalPropertyTypes-safe)', () => {
    expect(runStyleOptions({ sz: 20 })).toEqual({ size: 20 });
  });
});

describe('paragraphStyleOptions', () => {
  it('returns {} for undefined pPr', () => {
    expect(paragraphStyleOptions(undefined)).toEqual({});
  });

  it('maps spacing before/after/line/lineRule', () => {
    expect(paragraphStyleOptions({ spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' } })).toEqual({
      spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' },
    });
  });

  it('maps contextualSpacing out of the spacing object onto the paragraph', () => {
    expect(paragraphStyleOptions({ spacing: { contextualSpacing: true } })).toEqual({
      spacing: {},
      contextualSpacing: true,
    });
  });

  it('maps indent left/right/firstLine/hanging', () => {
    expect(paragraphStyleOptions({ ind: { left: 720, hanging: 360 } })).toEqual({
      indent: { left: 720, hanging: 360 },
    });
  });

  it('maps jc to alignment', () => {
    expect(paragraphStyleOptions({ jc: 'center' })).toEqual({ alignment: 'center' });
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run --project unit src/generator/styles.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** `src/generator/styles.ts`:

```typescript
import { AlignmentType, LineRuleType } from 'docx';
import type {
  NodeType,
  ParagraphProperties,
  RunProperties,
  StyleProperties,
  StyleRule,
} from '../ast/index.js';

/** Keyed by NodeType (superset of StyleNodeType) so callers can look up any node. */
export type StyleRuleMap = ReadonlyMap<NodeType, StyleProperties>;

export function buildRuleMap(rules: readonly StyleRule[]): StyleRuleMap {
  return new Map(rules.map((r) => [r.nodeType, r.properties]));
}

type DocxAlignment = (typeof AlignmentType)[keyof typeof AlignmentType];
type DocxLineRule = (typeof LineRuleType)[keyof typeof LineRuleType];

const ALIGNMENT: Record<NonNullable<ParagraphProperties['jc']>, DocxAlignment> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  both: AlignmentType.BOTH,
  distribute: AlignmentType.DISTRIBUTE,
  start: AlignmentType.START,
  end: AlignmentType.END,
};

const LINE_RULE: Record<'auto' | 'exact' | 'atLeast', DocxLineRule> = {
  auto: LineRuleType.AUTO,
  exact: LineRuleType.EXACT,
  atLeast: LineRuleType.AT_LEAST,
};

export interface RunStyleOptions {
  readonly font?: string;
  readonly size?: number; // half-points, same unit as OOXML w:sz
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly allCaps?: boolean;
  readonly smallCaps?: boolean;
}

export function runStyleOptions(rPr: RunProperties | undefined): RunStyleOptions {
  if (!rPr) return {};
  const out: { -readonly [K in keyof RunStyleOptions]: RunStyleOptions[K] } = {};
  if (rPr.rFonts?.ascii !== undefined) out.font = rPr.rFonts.ascii;
  if (rPr.sz !== undefined) out.size = rPr.sz;
  if (rPr.b !== undefined) out.bold = rPr.b;
  if (rPr.i !== undefined) out.italics = rPr.i;
  if (rPr.caps !== undefined) out.allCaps = rPr.caps;
  if (rPr.smallCaps !== undefined) out.smallCaps = rPr.smallCaps;
  return out;
}

interface SpacingOptions {
  readonly before?: number;
  readonly after?: number;
  readonly line?: number;
  readonly lineRule?: DocxLineRule;
}

interface IndentOptions {
  readonly left?: number;
  readonly right?: number;
  readonly firstLine?: number;
  readonly hanging?: number;
}

export interface ParagraphStyleOptions {
  readonly spacing?: SpacingOptions;
  readonly indent?: IndentOptions;
  readonly alignment?: DocxAlignment;
  readonly contextualSpacing?: boolean;
}

function spacingOptions(spacing: NonNullable<ParagraphProperties['spacing']>): SpacingOptions {
  const out: { -readonly [K in keyof SpacingOptions]: SpacingOptions[K] } = {};
  if (spacing.before !== undefined) out.before = spacing.before;
  if (spacing.after !== undefined) out.after = spacing.after;
  if (spacing.line !== undefined) out.line = spacing.line;
  if (spacing.lineRule !== undefined) out.lineRule = LINE_RULE[spacing.lineRule];
  return out;
}

function indentOptions(ind: NonNullable<ParagraphProperties['ind']>): IndentOptions {
  const out: { -readonly [K in keyof IndentOptions]: IndentOptions[K] } = {};
  if (ind.left !== undefined) out.left = ind.left;
  if (ind.right !== undefined) out.right = ind.right;
  if (ind.firstLine !== undefined) out.firstLine = ind.firstLine;
  if (ind.hanging !== undefined) out.hanging = ind.hanging;
  return out;
}

export function paragraphStyleOptions(
  pPr: ParagraphProperties | undefined
): ParagraphStyleOptions {
  if (!pPr) return {};
  const out: { -readonly [K in keyof ParagraphStyleOptions]: ParagraphStyleOptions[K] } = {};
  if (pPr.spacing !== undefined) {
    out.spacing = spacingOptions(pPr.spacing);
    if (pPr.spacing.contextualSpacing !== undefined) {
      out.contextualSpacing = pPr.spacing.contextualSpacing;
    }
  }
  if (pPr.ind !== undefined) out.indent = indentOptions(pPr.ind);
  if (pPr.jc !== undefined) out.alignment = ALIGNMENT[pPr.jc];
  return out;
}
```

- [ ] **Step 4: Run** `pnpm vitest run --project unit src/generator/styles.test.ts` — PASS. `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(generator): styles.ts — StyleProperties → docx run/paragraph options (#32)`

### Task 3: numbering overrides from template rules

**Files:**
- Modify: `src/generator/numbering.ts`
- Test: `src/generator/numbering.test.ts` (append)

- [ ] **Step 1: Write failing tests** — append to `src/generator/numbering.test.ts` (match existing import/describe style):

```typescript
import { buildRuleMap } from './styles.js';

describe('buildSpecNumberingConfig — template overrides', () => {
  it('no rules → identical to default config', () => {
    expect(buildSpecNumberingConfig(buildRuleMap([]))).toEqual(buildSpecNumberingConfig());
  });

  it('applies lvlText, numFmt, and start for the matching nodeType level', () => {
    const rules = buildRuleMap([
      { nodeType: 'part', properties: { numbering: { lvlText: 'SECTION %1 -', numFmt: 'upperRoman', start: 2 } } },
    ]);
    const config = buildSpecNumberingConfig(rules);
    const level0 = config.levels.find((l) => l.level === 0);
    expect(level0).toMatchObject({ text: 'SECTION %1 -', format: 'upperRoman', start: 2 });
    // other levels untouched
    expect(config.levels.find((l) => l.level === 1)).toEqual(
      buildSpecNumberingConfig().levels.find((l) => l.level === 1)
    );
  });

  it('ignores unknown numFmt (keeps default format)', () => {
    const rules = buildRuleMap([
      { nodeType: 'article', properties: { numbering: { numFmt: 'klingon' } } },
    ]);
    const level1 = buildSpecNumberingConfig(rules).levels.find((l) => l.level === 1);
    expect(level1?.format).toBe('decimal');
  });

  it('ignores template ilvl — level mapping stays generator-owned', () => {
    const rules = buildRuleMap([
      { nodeType: 'pr1', properties: { numbering: { ilvl: 5, lvlText: '%3:' } } },
    ]);
    const config = buildSpecNumberingConfig(rules);
    expect(config.levels.find((l) => l.level === 2)?.text).toBe('%3:');
    expect(config.levels.find((l) => l.level === 5)?.text).toBe('%6)');
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run --project unit src/generator/numbering.test.ts` — FAIL.
- [ ] **Step 3: Implement** — rewrite `src/generator/numbering.ts`:

```typescript
import { LevelFormat, AlignmentType } from 'docx';
import type { ILevelsOptions } from 'docx';
import type { NodeType, NumberingDef, StyleNodeType } from '../ast/index.js';
import type { StyleRuleMap } from './styles.js';

export function getNodeLevel(type: NodeType): number | null {
  // ... unchanged switch ...
}

// Index = numbering level; inverse of getNodeLevel for the styleable node types.
const LEVEL_NODE_TYPES: readonly StyleNodeType[] = [
  'part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5',
];

type DocxLevelFormat = (typeof LevelFormat)[keyof typeof LevelFormat];

// OOXML numFmt values the generator can render. Unknown values are ignored
// (default kept) — the open JSONB style schema is warn-don't-reject (ADR-021).
const NUM_FMT: Readonly<Record<string, DocxLevelFormat>> = {
  decimal: LevelFormat.DECIMAL,
  upperLetter: LevelFormat.UPPER_LETTER,
  lowerLetter: LevelFormat.LOWER_LETTER,
  upperRoman: LevelFormat.UPPER_ROMAN,
  lowerRoman: LevelFormat.LOWER_ROMAN,
  ordinal: LevelFormat.ORDINAL,
  bullet: LevelFormat.BULLET,
  none: LevelFormat.NONE,
};

function defaultLevels(): ILevelsOptions[] {
  return [ /* existing 7 level literals, unchanged */ ];
}

// Template `ilvl` is deliberately NOT consulted: it describes the source
// document's numbering; output levels are generator-owned via getNodeLevel.
function applyOverride(level: ILevelsOptions, num: NumberingDef | undefined): ILevelsOptions {
  if (!num) return level;
  const fmt = num.numFmt !== undefined ? NUM_FMT[num.numFmt] : undefined;
  return {
    ...level,
    ...(fmt !== undefined ? { format: fmt } : {}),
    ...(num.lvlText !== undefined ? { text: num.lvlText } : {}),
    ...(num.start !== undefined ? { start: num.start } : {}),
  };
}

export function buildSpecNumberingConfig(rules?: StyleRuleMap): {
  reference: 'spec-numbering';
  levels: ILevelsOptions[];
} {
  const levels = defaultLevels().map((level, i) => {
    const nodeType = LEVEL_NODE_TYPES[i];
    return applyOverride(level, nodeType !== undefined ? rules?.get(nodeType)?.numbering : undefined);
  });
  return { reference: 'spec-numbering', levels };
}
```

Note: `NumberingDef` needs exporting from the ast barrel — already exported. Check `'spec-numbering' as const` callers still typecheck.

- [ ] **Step 4: Run** `pnpm vitest run --project unit src/generator` — PASS; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(generator): numbering format/lvlText/start overrides from template rules (#32)`

### Task 4: `generateDocx` accepts style rules

**Files:**
- Modify: `src/generator/index.ts`
- Test: `src/generator/index.test.ts` (append)

- [ ] **Step 1: Write failing tests** — append to `src/generator/index.test.ts`:

```typescript
import type { StyleRule } from '../ast/index.js';

const ARIAL_RULES: readonly StyleRule[] = [
  {
    nodeType: 'part',
    properties: {
      rPr: { rFonts: { ascii: 'Arial' }, sz: 24, b: true, caps: true },
      pPr: { spacing: { before: 240, after: 240 }, ind: { left: 360 } },
      numbering: { lvlText: 'SECTION %1 -' },
    },
  },
];

describe('generateDocx — style rules', () => {
  it('applies font family and size to styled node runs', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('Arial');
    expect(xml).toMatch(/w:sz[^/>]*w:val="24"/);
  });

  it('applies paragraph spacing and indent', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const xml = await getDocXml(buffer);
    expect(xml).toMatch(/w:spacing[^/>]*w:before="240"/);
    expect(xml).toMatch(/w:ind[^/>]*"360"/);
  });

  it('applies numbering lvlText override to numbering.xml', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const zip = await JSZip.loadAsync(buffer);
    const numbering = await zip.file('word/numbering.xml')?.async('string');
    expect(numbering).toContain('SECTION %1 -');
  });

  it('no rules → output document.xml unchanged vs explicit empty rules absent', async () => {
    const plain = await getDocXml(await generateDocx(SYNTHETIC_TREE));
    expect(plain).not.toContain('Arial');
  });

  it('note and continuation paragraphs stay unstyled', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const xml = await getDocXml(buffer);
    // [NOTE] run carries no rPr font — there is exactly one Arial-free note text
    expect(xml).toContain('[NOTE]');
  });
});
```

- [ ] **Step 2: Run** — FAIL (generateDocx arity).
- [ ] **Step 3: Implement** `src/generator/index.ts`:

```typescript
import { Document, Paragraph, TextRun, Packer } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
import type { SpecNode, SpecTree, StyleProperties, StyleRule } from '../ast/index.js';
import { GeneratorError } from './error.js';
import { buildSpecNumberingConfig, getNodeLevel } from './numbering.js';
import { buildRuleMap, paragraphStyleOptions, runStyleOptions } from './styles.js';
import type { StyleRuleMap } from './styles.js';

const SPEC_NUM_REF = 'spec-numbering' as const;

function noteParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(`[NOTE] ${text}`)] });
}

function numberedParagraph(text: string, level: number, props?: StyleProperties): Paragraph {
  return new Paragraph({
    numbering: { reference: SPEC_NUM_REF, level },
    children: [new TextRun({ text, ...runStyleOptions(props?.rPr) })],
    ...paragraphStyleOptions(props?.pPr),
  });
}

function plainParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function emitNode(node: SpecNode, out: (Paragraph | SdtBlock)[], rules?: StyleRuleMap): boolean {
  if (node.type === 'note') {
    out.push(wrapWithControl(noteParagraph(node.text), node.id));
    return true;
  }
  if (node.meta.vanish) return false;
  if (node.type === 'continuation') {
    out.push(wrapWithControl(plainParagraph(node.text), node.id));
    return true;
  }
  // 'spec' is a root-container type; never appears as a paragraph node in tree.parts.
  // All unknown types fall through: getNodeLevel returns null, no paragraph emitted.
  const level = getNodeLevel(node.type);
  if (level !== null) {
    out.push(wrapWithControl(numberedParagraph(node.text, level, rules?.get(node.type)), node.id));
  }
  return true;
}

function collectParagraphs(
  nodes: readonly SpecNode[],
  out: (Paragraph | SdtBlock)[],
  rules?: StyleRuleMap
): void {
  for (const node of nodes) {
    if (emitNode(node, out, rules)) collectParagraphs(node.children, out, rules);
  }
}

/**
 * Render the spec tree to DOCX. `styleRules` (from a style template, ADR-021)
 * applies per-NodeType font/spacing/indent to styled paragraphs and
 * numFmt/lvlText/start to the numbering definition. Title, note, and
 * continuation paragraphs are not StyleNodeTypes and stay unstyled.
 */
export async function generateDocx(
  tree: SpecTree,
  styleRules?: readonly StyleRule[]
): Promise<Buffer> {
  try {
    const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
    // Title paragraph is synthetic — no SpecNode.id, not a round-trip anchor
    const children: (Paragraph | SdtBlock)[] = [
      plainParagraph(`SECTION ${tree.section} — ${tree.title}`),
    ];
    collectParagraphs(tree.parts, children, rules);
    const doc = new Document({
      numbering: { config: [buildSpecNumberingConfig(rules)] },
      sections: [{ properties: {}, children }],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX generation failed', { cause: err });
  }
}
```

- [ ] **Step 4: Run** `pnpm vitest run --project unit src/generator` — PASS (all existing + new); `pnpm exec tsc --noEmit` clean. Verify the exact emitted attribute names (`w:ind w:left` vs `w:start`) by printing the xml once if an assertion fails; adjust regexes to the real serialization, never the implementation.
- [ ] **Step 5: Commit** `feat(generator): generateDocx applies template style rules per paragraph (#32)`

### Task 5: API handler — resolve templateId, 404 unknown, default fallback

**Files:**
- Modify: `src/api/generate.ts`
- Test: `src/api/generate.integration.test.ts` (append)

- [ ] **Step 1: Write failing integration tests** — append to `src/api/generate.integration.test.ts`. Add imports (`JSZip`, `createTemplateWithRules`, `deleteTemplate` from `../db/index.js`); add to suite:

```typescript
async function fetchDocXml(specId: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/specs/${specId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`generate failed: ${res.status}`);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

describe('POST /specs/:id/generate — templateId (integration)', () => {
  let defaultTemplateId: string;
  let customTemplateId: string;

  beforeAll(async () => {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM style_templates WHERE name = 'UFGS-Default'`
    );
    const row = r.rows[0];
    if (!row) throw new Error('UFGS-Default template missing — run migrations');
    defaultTemplateId = row.id;
    const custom = await createTemplateWithRules('Generate-Test-Custom', null, [
      {
        nodeType: 'part',
        properties: {
          rPr: { rFonts: { ascii: 'Arial' }, sz: 28 },
          pPr: { spacing: { before: 480, after: 60 } },
        },
      },
    ]);
    customTemplateId = custom.id;
  });

  afterAll(async () => {
    await deleteTemplate(customTemplateId);
  });

  it('explicit default templateId → identical document.xml to no-template request', async () => {
    const withDefault = await fetchDocXml(testSpecId, { templateId: defaultTemplateId });
    const without = await fetchDocXml(testSpecId, {});
    expect(withDefault).toBe(without);
  });

  it('custom template font/spacing values appear in document.xml', async () => {
    const xml = await fetchDocXml(testSpecId, { templateId: customTemplateId });
    expect(xml).toContain('Arial');
    expect(xml).toMatch(/w:sz[^/>]*w:val="28"/);
    expect(xml).toMatch(/w:spacing[^/>]*w:before="480"/);
  });

  it('custom template output differs from default output', async () => {
    const custom = await fetchDocXml(testSpecId, { templateId: customTemplateId });
    const def = await fetchDocXml(testSpecId, {});
    expect(custom).not.toBe(def);
  });

  it('unknown templateId → 404', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: '00000000-0000-0000-0000-000000000000' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('template');
  });

  it('malformed (non-UUID) templateId → 400', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'nope' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body['success']).toBe(false);
  });
});
```

- [ ] **Step 2: Run** integration suite (needs the issue-32 Postgres on :5444) — new tests FAIL (template ignored / no 404).
- [ ] **Step 3: Implement** `src/api/generate.ts`:

```typescript
import type { Request, Response } from 'express';
import { z } from 'zod';
import { GenerateBodySchema } from '../ast/index.js';
import { getSpecTree, getTemplate, getTemplateByName } from '../db/index.js';
import type { StyleRule } from '../ast/index.js';
import { generateDocx } from '../generator/index.js';
import { logger } from '../lib/logger.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// When no templateId is given the seeded default applies, so an explicit
// default-template request and a bare request produce identical output.
// Missing default (un-migrated DB) degrades to unstyled output, never an error.
const DEFAULT_TEMPLATE_NAME = 'UFGS-Default';

export function safeFilename(section: string, title: string): string {
  // ... unchanged ...
}

type RulesResolution =
  | { readonly found: true; readonly rules: readonly StyleRule[] | undefined }
  | { readonly found: false };

async function resolveStyleRules(templateId: string | undefined): Promise<RulesResolution> {
  if (templateId !== undefined) {
    const template = await getTemplate(templateId);
    return template ? { found: true, rules: template.rules } : { found: false };
  }
  const fallback = await getTemplateByName(DEFAULT_TEMPLATE_NAME);
  return { found: true, rules: fallback?.rules };
}

export async function generateHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const bodyResult = GenerateBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid body: templateId must be a UUID' });
    return;
  }
  try {
    const result = await getSpecTree(idResult.data);
    if (!result) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    const resolution = await resolveStyleRules(bodyResult.data.templateId);
    if (!resolution.found) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    const buffer = await generateDocx(result.tree, resolution.rules);
    const filename = safeFilename(result.tree.section, result.tree.title);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'generate failed');
    res.status(500).json({ success: false, error: 'generation failed' });
  }
}
```

Note: `src/api/generate.test.ts` mocks `../db/index.js` with only `getSpecTree` — extend the mock factory with `getTemplate: vi.fn()` and `getTemplateByName: vi.fn()` so module import keeps working.

- [ ] **Step 4: Run** `pnpm vitest run --project unit src/api/generate.test.ts` PASS; integration suite PASS (migrate + seed first).
- [ ] **Step 5: Commit** `feat(api): POST /specs/:id/generate resolves templateId → style rules; 404 unknown template (#32)`

### Task 6: Docs — openapi.yaml, README, ARCHITECTURE

**Files:**
- Modify: `openapi.yaml` (`/specs/{id}/generate` requestBody)
- Modify: `README.md` (phase table rows 2c-ii/2c-iii, header line)
- Modify: `ARCHITECTURE.md` (Phase 2c bullet status)

- [ ] **Step 1:** openapi.yaml — under `/specs/{id}/generate: post:` add after `parameters`:

```yaml
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                templateId:
                  type: string
                  format: uuid
                  description: >
                    Style template to apply (font, spacing, indent, numbering format).
                    Omitted → the seeded UFGS-Default template is applied. Unknown id → 404.
```

- [ ] **Step 2:** README.md — phase table: after the `2c-i` row add:

```markdown
| 2c-ii | Template CRUD API over the JSONB style payload (ADR-021) + `POST /templates/import` DOCX style derivation | ✅ Complete (PRs #151, #156) |
| 2c-iii | `templateId` wired through generator — template font/spacing/indent/numbering applied to generated DOCX; `UFGS-Default` applied when omitted | ✅ Complete (issue #32) |
```

Change the `| 2c | Firm style template engine (issue #20) | Planned |` row status to `✅ Complete` and update the line-13 banner to reflect 2c complete, 2d next.

- [ ] **Step 3:** ARCHITECTURE.md — Phase 2c block: mark the four bullets ✅ (they are all now true); change "Generator accepts `templateId?` (already in body) — wired through to numbering + controls" to past tense with the default-template behavior noted.
- [ ] **Step 4:** `pnpm lint` clean.
- [ ] **Step 5: Commit** `docs: Phase 2c-iii status, templateId in openapi generate body (#32)`

### Task 7: Full verification + PR

- [ ] `pnpm lint` (eslint + tsc + prettier) — clean.
- [ ] `pnpm test` — all unit tests pass.
- [ ] `DATABASE_URL=postgres://specr:specr@localhost:5444/specr pnpm migrate && ... pnpm seed && ... pnpm test:integration` — pass.
- [ ] superpowers:finishing-a-development-branch → option 2 (Push + PR). PR: `Closes #32`, "## Design decisions" section (the 6 decisions above), Testing checkboxes, credit trailer.
