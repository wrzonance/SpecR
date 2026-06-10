# WT-2 — Effective-Style Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Follow TDD: red before green.

**Goal:** A pure module that resolves the OOXML style cascade into effective `StyleProperties` per paragraph style:
`resolveStyleCascade(stylesXml, numberingXml?) → Map<styleId, StyleProperties>`.

**Architecture (design, approved):** Resolve the cascade **docDefaults → paragraph-style `basedOn` chain → the style's own `rPr`/`pPr`**, plus numbering context (`ilvl`/`numFmt`/`lvlText`) from `numbering.xml` via the style's `numPr`. Output is **per-`styleId`** and **NodeType-agnostic** — the "which style is `part`/`pr1`" mapping + consensus is WT-3's job. **Scope = style cascade only** — this WT does NOT touch `document.ts` / per-paragraph direct formatting (that's the Layer-2 deviation concern, WT-4/5). Merge semantics: **value** props (`sz`, `rFonts.ascii`, `ind`, `spacing`, `jc`, `color`, `u`, `highlight`) = last-wins (closest ancestor); **toggle** props (`b`, `i`, `caps`, `smallCaps`, `strike`) = presence/`val` with absent = inherit.

**Tech stack:** TypeScript (strict), `fast-xml-parser` (reuse the `styles.ts` config: `ignoreAttributes:false`, `attributeNamePrefix:'@_'`, `isArray: name==='w:style'`), the `xml-utils.ts` helpers (`getAttrVal`, `extractAttrStr`, `toArray`), the PR-1a `StyleProperties`/`RunProperties`/`ParagraphProperties`/`NumberingDef` types from `../../ast/types.js`, Vitest.

**Prerequisites:** worktree `feat/effective-style-resolver` (stacked on PR-1a `feat/style-jsonb` — has `StyleProperties`). No DB needed (pure module → unit tests only). Commands: `pnpm test <file>`, `pnpm lint`.

**Deferred (note in code comments, NOT implemented):** theme fonts (`w:rFonts w:asciiTheme` → use `w:ascii`, skip theme lookup); numbering-level `pPr`/`rPr` (cascade layer 3); table styles; character styles (paragraph styles only, as today); the full toggle-XOR-across-chain case (implement the common `val=0`→off / present→on / absent→inherit; the parent-bold + child-`<w:b/>` XOR edge is rare — leave a `// KNOWN AMBIGUITY` comment).

**File structure:**
- Create: `src/parser/docx/resolver.ts` (the resolver; keep ≤400 lines — extract helpers if needed)
- Create: `src/parser/docx/resolver.test.ts` (unit tests)
- (No changes to `styles.ts`/`document.ts`/`index.ts` in this WT — the resolver is standalone; pipeline wiring happens in WT-3.)

---

## Task 1: Visual-property extraction (one style's own `rPr`/`pPr`, no cascade)

**Files:** Create `src/parser/docx/resolver.ts`, `src/parser/docx/resolver.test.ts`.

- [ ] **Step 1 — failing test** (`resolver.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
import { extractRunProps, extractParaProps } from './resolver.js';

describe('extractRunProps', () => {
  it('reads fonts, size, toggles, underline, color from a w:rPr object', () => {
    const rPr = {
      'w:rFonts': { '@_w:ascii': 'Courier New' },
      'w:sz': { '@_w:val': 20 },
      'w:b': {},                       // present, no val → true
      'w:i': { '@_w:val': '0' },       // explicit off → false
      'w:caps': { '@_w:val': '1' },    // explicit on → true
      'w:u': { '@_w:val': 'single' },
      'w:color': { '@_w:val': 'FF0000' },
    };
    expect(extractRunProps(rPr)).toEqual({
      rFonts: { ascii: 'Courier New' },
      sz: 20, b: true, i: false, caps: true, u: 'single', color: 'FF0000',
    });
  });

  it('returns an empty object for an empty w:rPr', () => {
    expect(extractRunProps({})).toEqual({});
  });
});

describe('extractParaProps', () => {
  it('reads spacing, indent, alignment from a w:pPr object', () => {
    const pPr = {
      'w:spacing': { '@_w:before': 0, '@_w:after': 120, '@_w:line': 360, '@_w:lineRule': 'auto' },
      'w:ind': { '@_w:left': 720, '@_w:hanging': 360 },
      'w:jc': { '@_w:val': 'both' },
    };
    expect(extractParaProps(pPr)).toEqual({
      spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' },
      ind: { left: 720, hanging: 360 },
      jc: 'both',
    });
  });
});
```

- [ ] **Step 2 — run, expect FAIL:** `pnpm test src/parser/docx/resolver.test.ts` → `extractRunProps`/`extractParaProps` not exported.

- [ ] **Step 3 — implement extraction** in `resolver.ts`:

```typescript
import { getAttrVal, extractAttrStr } from './xml-utils.js';
import type { RunProperties, ParagraphProperties } from '../../ast/types.js';

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

// Numeric attribute (e.g. '@_w:left') on a nested element; undefined if absent/non-numeric.
function numAttr(el: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!el) return undefined;
  const s = extractAttrStr(el, key);
  if (s === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

// String attribute (e.g. '@_w:ascii'); undefined if absent/empty.
function strAttr(el: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!el) return undefined;
  const s = extractAttrStr(el, key);
  return s === '' ? undefined : s;
}

// OOXML toggle: absent → undefined (inherit); present with val 0/false/off → false; else true.
function toggle(el: unknown): boolean | undefined {
  const obj = asObj(el);
  if (el === undefined) return undefined;
  const v = obj ? extractAttrStr(obj, '@_w:val') : '';
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

// Only set defined keys (keeps the JSONB payload clean — absent ≠ explicit).
function compact<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function extractRunProps(rPr: Record<string, unknown> | undefined): RunProperties {
  if (!rPr) return {};
  const rFontsEl = asObj(rPr['w:rFonts']);
  const rFonts = rFontsEl
    ? compact({
        ascii: strAttr(rFontsEl, '@_w:ascii'),
        hAnsi: strAttr(rFontsEl, '@_w:hAnsi'),
        cs: strAttr(rFontsEl, '@_w:cs'),
        eastAsia: strAttr(rFontsEl, '@_w:eastAsia'),
      })
    : undefined;
  return compact({
    rFonts: rFonts && Object.keys(rFonts).length ? rFonts : undefined,
    sz: numAttr(asObj(rPr['w:sz']), '@_w:val'),
    b: toggle(rPr['w:b']),
    i: toggle(rPr['w:i']),
    caps: toggle(rPr['w:caps']),
    smallCaps: toggle(rPr['w:smallCaps']),
    strike: toggle(rPr['w:strike']),
    u: getAttrVal(rPr['w:u']) || undefined,
    color: getAttrVal(rPr['w:color']) || undefined,
    highlight: getAttrVal(rPr['w:highlight']) || undefined,
  }) as RunProperties;
}

export function extractParaProps(pPr: Record<string, unknown> | undefined): ParagraphProperties {
  if (!pPr) return {};
  const sp = asObj(pPr['w:spacing']);
  const ind = asObj(pPr['w:ind']);
  const spacing = sp
    ? compact({
        before: numAttr(sp, '@_w:before'), after: numAttr(sp, '@_w:after'),
        line: numAttr(sp, '@_w:line'), lineRule: strAttr(sp, '@_w:lineRule'),
      })
    : undefined;
  const indent = ind
    ? compact({
        left: numAttr(ind, '@_w:left'), right: numAttr(ind, '@_w:right'),
        firstLine: numAttr(ind, '@_w:firstLine'), hanging: numAttr(ind, '@_w:hanging'),
      })
    : undefined;
  return compact({
    spacing: spacing && Object.keys(spacing).length ? spacing : undefined,
    ind: indent && Object.keys(indent).length ? indent : undefined,
    jc: getAttrVal(pPr['w:jc']) || undefined,
  }) as ParagraphProperties;
}
```

- [ ] **Step 4 — run, expect PASS.** Then `pnpm lint` (no `any`; types align with `RunProperties`/`ParagraphProperties`).
- [ ] **Step 5 — commit:** `git add src/parser/docx/resolver.ts src/parser/docx/resolver.test.ts && git commit -m "feat(parser): rPr/pPr visual-property extraction for the style resolver"`

---

## Task 2: Parse the full styles.xml (docDefaults + per-style own props + basedOn graph)

**Files:** Modify `resolver.ts`, `resolver.test.ts`.

- [ ] **Step 1 — failing test:**

```typescript
import { parseStylesFull } from './resolver.js';

const STYLES_XML = `<?xml version="1.0"?>
<w:styles xmlns:w="x">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="PRT"><w:name w:val="Part"/><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="PR1"><w:basedOn w:val="PRT"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  <w:style w:type="character" w:styleId="IP"><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

describe('parseStylesFull', () => {
  it('extracts docDefaults + paragraph styles (own props) + basedOn, skipping character styles', () => {
    const parsed = parseStylesFull(STYLES_XML);
    expect(parsed.docDefaults).toEqual({
      rPr: { rFonts: { ascii: 'Times New Roman' }, sz: 22 },
      pPr: { spacing: { after: 0 } },
    });
    expect(parsed.styles.get('IP')).toBeUndefined(); // character style skipped
    const prt = parsed.styles.get('PRT');
    expect(prt?.own).toEqual({ rPr: { b: true, sz: 20 }, pPr: { jc: 'center' } });
    expect(prt?.basedOn).toBeUndefined();
    const pr1 = parsed.styles.get('PR1');
    expect(pr1?.basedOn).toBe('PRT');
    expect(pr1?.own).toEqual({ pPr: { ind: { left: 720 } } });
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement:** add to `resolver.ts`:

```typescript
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { toArray } from './xml-utils.js';
import type { StyleProperties } from '../../ast/types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => name === 'w:style',
});

interface RawStyle {
  readonly basedOn?: string;
  readonly own: StyleProperties;
}
export interface ParsedStyles {
  readonly docDefaults: StyleProperties;
  readonly styles: ReadonlyMap<string, RawStyle>;
}

function ownProps(rPr: Record<string, unknown> | undefined, pPr: Record<string, unknown> | undefined): StyleProperties {
  const r = extractRunProps(rPr);
  const p = extractParaProps(pPr);
  return compact({
    rPr: Object.keys(r).length ? r : undefined,
    pPr: Object.keys(p).length ? p : undefined,
  }) as StyleProperties;
}

export function parseStylesFull(xml: string): ParsedStyles {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse styles.xml for cascade resolution', { cause: err });
  }
  const root = asObj((parsed as Record<string, unknown>)['w:styles']);
  if (!root) return { docDefaults: {}, styles: new Map() };

  // docDefaults
  const dd = asObj(root['w:docDefaults']);
  const ddRpr = asObj(asObj(dd?.['w:rPrDefault'])?.['w:rPr']);
  const ddPpr = asObj(asObj(dd?.['w:pPrDefault'])?.['w:pPr']);
  const docDefaults = ownProps(ddRpr, ddPpr);

  // styles (paragraph only)
  const styles = new Map<string, RawStyle>();
  for (const raw of toArray(root['w:style'] as readonly unknown[] | undefined)) {
    const s = asObj(raw);
    if (!s) continue;
    if ((extractAttrStr(s, '@_w:type') || 'paragraph') !== 'paragraph') continue;
    const styleId = extractAttrStr(s, '@_w:styleId');
    if (!styleId) continue;
    const basedOn = getAttrVal(s['w:basedOn']) || undefined;
    const own = ownProps(asObj(s['w:rPr']), asObj(s['w:pPr']));
    styles.set(styleId, compact({ basedOn, own }) as RawStyle);
  }
  return { docDefaults, styles };
}
```

- [ ] **Step 4 — run PASS; `pnpm lint`.**
- [ ] **Step 5 — commit:** `feat(parser): parse styles.xml docDefaults + per-style props for cascade`

---

## Task 3: Cascade merge (docDefaults → basedOn chain → own) with value/toggle semantics + guards

**Files:** Modify `resolver.ts`, `resolver.test.ts`.

- [ ] **Step 1 — failing test:**

```typescript
import { mergeStyleProps, resolveStyleChain, parseStylesFull } from './resolver.js';

describe('mergeStyleProps (value last-wins; nested merge)', () => {
  it('overrides value props and merges nested rPr/pPr', () => {
    const base = { rPr: { sz: 22, b: false }, pPr: { spacing: { after: 0 } } };
    const over = { rPr: { sz: 20 }, pPr: { ind: { left: 720 } } };
    expect(mergeStyleProps(base, over)).toEqual({
      rPr: { sz: 20, b: false },
      pPr: { spacing: { after: 0 }, ind: { left: 720 } },
    });
  });
});

describe('resolveStyleChain', () => {
  const XML = `<?xml version="1.0"?>
  <w:styles xmlns:w="x">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:styleId="PRT"><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="PR1"><w:basedOn w:val="PRT"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  </w:styles>`;
  it('layers docDefaults -> basedOn parent -> own (closest wins)', () => {
    const parsed = parseStylesFull(XML);
    expect(resolveStyleChain('PR1', parsed)).toEqual({
      rPr: { rFonts: { ascii: 'Times New Roman' }, sz: 20, b: true },
      pPr: { ind: { left: 720 } },
    });
  });
  it('tolerates a missing basedOn target (resolves what exists)', () => {
    const parsed = parseStylesFull(
      `<w:styles xmlns:w="x"><w:style w:type="paragraph" w:styleId="X"><w:basedOn w:val="Ghost"/><w:rPr><w:i/></w:rPr></w:style></w:styles>`
    );
    expect(resolveStyleChain('X', parsed)).toEqual({ rPr: { i: true } });
  });
  it('terminates on a basedOn cycle without infinite recursion', () => {
    const parsed = parseStylesFull(
      `<w:styles xmlns:w="x">
        <w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style>
      </w:styles>`
    );
    expect(() => resolveStyleChain('A', parsed)).not.toThrow();
    expect(resolveStyleChain('A', parsed).rPr?.sz).toBe(20);
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement merge + chain** in `resolver.ts`. Value props last-wins; nested objects (`rPr`,`pPr`,`rFonts`,`spacing`,`ind`,`numbering`) merge key-by-key; the cascade applies docDefaults as the base, then each ancestor from the chain root down to the style itself (closest wins). Cycle guard via a visited set; missing target stops the walk.

```typescript
const MAX_DEPTH = 20;

function mergeRecord(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const b = out[k];
    if (asObj(v) && asObj(b)) out[k] = mergeRecord(b as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v; // value / toggle: last (closest) wins
  }
  return out;
}

export function mergeStyleProps(base: StyleProperties, over: StyleProperties): StyleProperties {
  return mergeRecord(base as Record<string, unknown>, over as Record<string, unknown>) as StyleProperties;
}

// Collect the basedOn chain from the style up to its furthest ancestor (or cycle/missing stop).
function chainTopDown(styleId: string, parsed: ParsedStyles): readonly StyleProperties[] {
  const seen = new Set<string>();
  const stack: StyleProperties[] = [];
  let id: string | undefined = styleId;
  let depth = 0;
  while (id && !seen.has(id) && depth < MAX_DEPTH) {
    const s = parsed.styles.get(id);
    if (!s) break;
    seen.add(id);
    stack.push(s.own);          // [self, parent, grandparent, ...]
    id = s.basedOn;
    depth += 1;
  }
  return stack.reverse();        // [ancestor ... parent, self] — apply in order, closest last
}

export function resolveStyleChain(styleId: string, parsed: ParsedStyles): StyleProperties {
  let acc: StyleProperties = parsed.docDefaults;
  for (const layer of chainTopDown(styleId, parsed)) acc = mergeStyleProps(acc, layer);
  return acc;
}
```

- [ ] **Step 4 — run PASS; `pnpm lint`.**
- [ ] **Step 5 — commit:** `feat(parser): style cascade merge (docDefaults -> basedOn chain -> own)`

---

## Task 4: Numbering context (`ilvl`/`numFmt`/`lvlText`) from the style's numPr

**Files:** Modify `resolver.ts`, `resolver.test.ts`.

**Context:** `buildStyleMap` (`styles.ts`) already resolves a style's effective `{numId, ilvl}` via the basedOn chain (`resolvedNumPr`). `buildNumberingMap` (`numbering.ts`) maps `numId → abstractNum → per-ilvl { numFmt, lvlText, start }`. The resolver looks up the style's resolved numPr, then reads that level's format from the numbering map, producing the `numbering` part of `StyleProperties`. **Read `numbering.ts` for the exact `NumberingMap` shape and accessor before implementing.**

- [ ] **Step 1 — failing test** asserting that for a style whose resolved numPr is `{numId:2, ilvl:0}` and whose abstractNum level 0 has `numFmt='decimal'`, `lvlText='PART %1 -'`, the resolver's output for that style includes `numbering: { ilvl: 0, numFmt: 'decimal', lvlText: 'PART %1 -' }`. (Build a small styles.xml + numbering.xml fixture in the test; mirror the structures `buildStyleMap`/`buildNumberingMap` already parse — confirm by reading those modules.)

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** a `numberingFor(styleId, styleMap, numberingMap): NumberingDef | undefined` that reuses `buildStyleMap(stylesXml).resolvedNumPr.get(styleId)` and `buildNumberingMap(numberingXml)`; map `{numId, ilvl}` → the abstractNum level's `{ numFmt, lvlText, start }` and set `ilvl`. Import `buildStyleMap` from `./styles.js` and `buildNumberingMap` from `./numbering.js`. Merge the result into the style's `StyleProperties` under `numbering`.

- [ ] **Step 4 — run PASS; `pnpm lint`.**
- [ ] **Step 5 — commit:** `feat(parser): resolve numbering context (numFmt/lvlText/ilvl) per style`

---

## Task 5: Public `resolveStyleCascade` + real-fixture integration test

**Files:** Modify `resolver.ts`, `resolver.test.ts`.

- [ ] **Step 1 — failing test:**

```typescript
import { resolveStyleCascade } from './resolver.js';

describe('resolveStyleCascade (public API)', () => {
  it('returns effective StyleProperties for every paragraph style', () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Courier New"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:styleId="PRT"><w:rPr><w:b/><w:caps/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="PR1"><w:basedOn w:val="PRT"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:b w:val="0"/></w:rPr></w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null);
    expect(map.get('PRT')).toEqual({ rPr: { rFonts: { ascii: 'Courier New' }, sz: 20, b: true, caps: true } });
    // PR1 inherits caps + font/size from PRT+docDefaults, but turns bold OFF explicitly:
    expect(map.get('PR1')).toEqual({
      rPr: { rFonts: { ascii: 'Courier New' }, sz: 20, b: false, caps: true },
      pPr: { ind: { left: 720 } },
    });
  });

  it('validates against the StyleProperties schema (open, JSON-safe)', () => {
    // every produced value must pass StylePropertiesSchema.parse without throwing
  });
});
```

Also add an integration-style test that unzips `tests/fixtures/libreoffice/csi-spec-sample.docx`, reads `word/styles.xml` (+ `word/numbering.xml` if present), calls `resolveStyleCascade`, and asserts the map is non-empty and each value parses via `StylePropertiesSchema`. (Use the same unzip/read approach the existing `libreoffice.integration.test.ts` uses — read it first.)

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** the public entry:

```typescript
import { StylePropertiesSchema } from '../../ast/index.js';

export function resolveStyleCascade(
  stylesXml: string,
  numberingXml?: string | null
): Map<string, StyleProperties> {
  const parsed = parseStylesFull(stylesXml);
  const styleMap = buildStyleMap(stylesXml);
  const numberingMap = numberingXml ? buildNumberingMap(numberingXml) : undefined;
  const out = new Map<string, StyleProperties>();
  for (const styleId of parsed.styles.keys()) {
    let eff = resolveStyleChain(styleId, parsed);
    const numbering = numberingMap ? numberingFor(styleId, styleMap, numberingMap) : undefined;
    if (numbering) eff = mergeStyleProps(eff, { numbering });
    // Defensive: the resolver only emits JSON values; parse keeps the contract honest.
    out.set(styleId, StylePropertiesSchema.parse(eff));
  }
  return out;
}
```

- [ ] **Step 4 — run PASS; `pnpm lint`; run the full `pnpm test` (unit) to confirm no regressions.**
- [ ] **Step 5 — commit:** `feat(parser): resolveStyleCascade public API + real-fixture test`

---

## Done criteria (WT-2)

- [ ] `resolveStyleCascade(stylesXml, numberingXml?)` returns `Map<styleId, StyleProperties>` with docDefaults → basedOn → own resolved, value/toggle semantics correct.
- [ ] Cycle + missing-basedOn + character-style cases handled (tests prove it).
- [ ] Numbering context populated when `numbering.xml` provided.
- [ ] Every produced value passes `StylePropertiesSchema.parse`.
- [ ] Real `csi-spec-sample.docx` styles resolve without error.
- [ ] `pnpm lint` + `pnpm test` green; `resolver.ts` ≤400 lines (extract helpers if near).
- [ ] No `document.ts`/pipeline changes (scope = style cascade only); WT-3 wires this into the import path.

**Next:** WT-3 maps `styleId → NodeType` (via the inference engine) + the consensus derivation (§5 of the program spec), seeding the firm template from these effective styles.
