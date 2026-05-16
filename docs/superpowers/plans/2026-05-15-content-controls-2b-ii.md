# Plan: Phase 2b-ii — w:sdt Content Control UUID Injection

**Date:** 2026-05-15 (post-review revision)
**Issue:** #28
**Branch:** `feat/content-controls-2b-ii`
**Milestone:** Phase 2b
**Blocked by:** nothing (Phase 2b-i merged PR #26)
**Critical path:** #28 → #34 (merge core) → #35 → #36 → Phase 5 UI

---

## Phase 0: Documentation Discovery (Complete — findings embedded below)

### What was checked

| Source | Finding |
|--------|---------|
| `node_modules/docx/dist/index.d.ts` | `FileChild` **IS exported** (`export declare class FileChild extends XmlComponent`) |
| `node_modules/docx/dist/index.d.ts` | `Paragraph extends FileChild extends XmlComponent` — valid `this.root.push()` child |
| `node_modules/docx/dist/index.d.ts` | `StringValueElement` **IS exported** — `constructor(name: string, val: string)` — pushes `new Attributes({ val })` → produces `<name w:val="val"/>` |
| `node_modules/docx/dist/index.mjs` line 9637–9640 | `StringValueElement` confirmed: `super(name); this.root.push(new Attributes({ val }))` |
| `node_modules/docx/dist/index.mjs` line ~18533 | Internal SDT pattern: `StructuredDocumentTagContent extends XmlComponent { super("w:sdtContent") }` |
| `node_modules/docx/dist/index.mjs` line ~18538 | Internal SDT properties: `StructuredDocumentTagProperties extends XmlComponent { super("w:sdtPr"); this.root.push(new StringValueElement(...)) }` |
| `node_modules/docx/dist/index.mjs` | `addChildElement` marked `@deprecated` — use `this.root.push(child)` instead |
| `src/ast/types.ts` line 13–14 | `CsiNode { readonly id: string; ... }` — DB UUID from `paragraphs.id` |
| `src/ast/types.ts` line 21–26 | `CsiTree { id, section, title, parts }` — field names are `section` and `title` (NOT `specNumber`/`specTitle`) |
| `src/db/migrations/003_create_paragraphs.ts` | `paragraphs.id` is `uuid` type, `gen_random_uuid()` — confirms `CsiNode.id` is UUID string |
| `src/generator/index.ts` | No content controls yet. `emitNode(node: CsiNode, out: Paragraph[]): boolean`. `collectParagraphs` and `generateDocx` use `Paragraph[]` as child type |
| `src/generator/index.test.ts` | Uses `JSZip` (already installed). Has `SYNTHETIC_TREE` fixture with UUIDs. Has `getDocXml(buffer)` helper. `CsiNode.meta` fields are optional |
| `src/generator/controls.ts` | **Does not exist** — must create |

### Confirmed Allowed APIs (no guessing beyond these)

```typescript
// All exported from 'docx' v9.6.1:
import { FileChild, XmlComponent, Paragraph, StringValueElement } from 'docx'

// StringValueElement(name, val) → <name w:val="val"/>
// XmlComponent.root: protected (BaseXmlComponent | string | any)[] — push children here
// FileChild extends XmlComponent — use as base for top-level SDT (accepted in Document.children)
// Paragraph extends FileChild — valid as root.push() child inside SdtContent

// Internal usage pattern (mirrors StructuredDocumentTagProperties in index.mjs):
this.root.push(new StringValueElement('w:tag', `specr-uuid-${uuid}`))
this.root.push(child)  // child is XmlComponent subclass
```

### What does NOT exist in docx v9.6.1 public API

- `SdtBlock`, `SdtRun`, `StructuredDocumentTag` — not exported
- `StructuredDocumentTagContent`, `StructuredDocumentTagProperties` — internal only
- `addChildElement` — deprecated, do not use
- `_attr` raw injection — works but fragile, unnecessary now that `StringValueElement` is confirmed

### Content control XML format (target output)

```xml
<w:sdt>
  <w:sdtPr>
    <w:tag w:val="specr-uuid-<CsiNode.id>"/>
  </w:sdtPr>
  <w:sdtContent>
    <w:p>...</w:p>  <!-- the Paragraph XML -->
  </w:sdtContent>
</w:sdt>
```

### Title paragraph decision

The synthetic title paragraph in `generateDocx` (`SECTION ${tree.section} — ${tree.title}`) is NOT a `CsiNode` and has no DB UUID. It MUST NOT be wrapped. Leave as bare `Paragraph`. Add a comment at the push site:
```typescript
// Title paragraph is synthetic — no CsiNode.id, not a round-trip anchor
children.push(plainParagraph(`SECTION ${tree.section} — ${tree.title}`))
```
Phase 3 merge engine must treat unwrapped paragraphs as non-anchored (skip them during `extractContentControls`).

---

## Phase 1: Pre-flight Verification

Run before writing any code:

```bash
# Confirm controls.ts does not exist
ls src/generator/

# Confirm CsiTree field names
grep -n "readonly section\|readonly title\|readonly id" src/ast/types.ts

# Confirm FileChild exported
grep -n "^export declare class FileChild" node_modules/docx/dist/index.d.ts

# Confirm StringValueElement exported and signature
grep -A 3 "^export declare class StringValueElement" node_modules/docx/dist/index.d.ts

# Confirm Document.section children type
grep -n "children.*FileChild\|FileChild.*children" node_modules/docx/dist/index.d.ts | head -5
```

Expected output for each: all should produce matches. If any fails, stop and investigate before proceeding.

---

## Phase 2: Write Failing Tests (RED — mandatory before any implementation)

**TDD rule:** `pnpm test` must be RED on the new tests before writing `controls.ts`.

### 2a. Create `src/generator/controls.test.ts`

Unit tests avoid `prepForXml` (requires complex context stub) — rely on integration test for XML structure verification. Unit tests verify type contract and export shape.

```typescript
import { describe, it, expect } from 'vitest'
import { Paragraph, TextRun, XmlComponent } from 'docx'
import { wrapWithControl, SdtBlock } from './controls.js'

describe('wrapWithControl', () => {
  it('returns an SdtBlock instance', () => {
    const para = new Paragraph({ children: [new TextRun('test')] })
    const result = wrapWithControl(para, 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
    expect(result).toBeInstanceOf(SdtBlock)
  })

  it('SdtBlock is an XmlComponent (prepForXml exists)', () => {
    const para = new Paragraph({ children: [new TextRun('test')] })
    const sdt = wrapWithControl(para, 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
    expect(typeof sdt.prepForXml).toBe('function')
  })

  it('returns distinct instances for distinct paragraphs', () => {
    const p1 = new Paragraph({ children: [new TextRun('a')] })
    const p2 = new Paragraph({ children: [new TextRun('b')] })
    const s1 = wrapWithControl(p1, 'uuid-1')
    const s2 = wrapWithControl(p2, 'uuid-2')
    expect(s1).not.toBe(s2)
  })
})
```

**Run:** `pnpm test src/generator/controls.test.ts` → must fail with "Cannot find module './controls.js'".

### 2b. Add integration test block to `src/generator/index.test.ts`

Add AFTER the existing `generateDocx` describe block. Use the existing `SYNTHETIC_TREE` fixture and `getDocXml` helper. Do NOT add new imports — `JSZip` and `getDocXml` are already in the file.

```typescript
describe('generateDocx — content controls', () => {
  it('document.xml contains w:sdt elements', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE)
    const xml = await getDocXml(buffer)
    expect(xml).toContain('w:sdt')
  })

  it('wraps part node in specr-uuid content control', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE)
    const xml = await getDocXml(buffer)
    // part node id: 00000000-0000-0000-0000-000000000002
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-000000000002')
  })

  it('wraps note node in specr-uuid content control', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE)
    const xml = await getDocXml(buffer)
    // note node id: 00000000-0000-0000-0000-000000000006
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-000000000006')
  })

  it('wraps continuation node in specr-uuid content control', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE)
    const xml = await getDocXml(buffer)
    // continuation node id: 00000000-0000-0000-0000-000000000007
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-000000000007')
  })

  it('does not wrap vanished node', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE)
    const xml = await getDocXml(buffer)
    // vanished node id: 00000000-0000-0000-0000-000000000012
    expect(xml).not.toContain('specr-uuid-00000000-0000-0000-0000-000000000012')
  })

  it('title paragraph is not wrapped (no CsiNode.id)', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE)
    const xml = await getDocXml(buffer)
    // Title text must appear outside any specr-uuid tag
    // Verify title text present AND there are fewer sdtPr entries than non-vanished nodes+1
    expect(xml).toContain('27 21 00')  // section
    expect(xml).toContain('Structured Cabling')  // title
    // The tree has 6 non-vanished CsiNodes (002,003,004,005,006,007) + title paragraph
    // Only 6 should have specr-uuid tags
    const uuidMatches = xml.match(/specr-uuid-/g) ?? []
    expect(uuidMatches.length).toBe(6)
  })
})
```

**Run:** `pnpm test` → must be RED (all content-control tests fail, existing tests still green).

---

## Phase 3: Implementation (GREEN)

### 3a. Create `src/generator/controls.ts`

No `SdtTag` class needed. No `addChildElement`. No `_attr`. No type assertions.

```typescript
import { FileChild, XmlComponent, Paragraph, StringValueElement } from 'docx'

class SdtProperties extends XmlComponent {
  constructor(uuid: string) {
    super('w:sdtPr')
    this.root.push(new StringValueElement('w:tag', `specr-uuid-${uuid}`))
  }
}

class SdtContent extends XmlComponent {
  constructor(para: Paragraph) {
    super('w:sdtContent')
    this.root.push(para)
  }
}

export class SdtBlock extends FileChild {
  constructor(para: Paragraph, uuid: string) {
    super('w:sdt')
    this.root.push(new SdtProperties(uuid))
    this.root.push(new SdtContent(para))
  }
}

export function wrapWithControl(para: Paragraph, uuid: string): SdtBlock {
  return new SdtBlock(para, uuid)
}
```

ESLint guards:
- No `any` in public API — not needed with this approach
- No `addChildElement` (deprecated) — not used
- No `console.log` — no I/O in this module
- File length: ~30 lines — well within 400-line limit
- Function length: all under 50 lines

### 3b. Modify `src/generator/index.ts`

Four changes:

**Change 1** — Add import:
```typescript
import { wrapWithControl, SdtBlock } from './controls.js'
```

**Change 2** — Update `emitNode` signature and `out` array type:
```typescript
// Before:
function emitNode(node: CsiNode, out: Paragraph[]): boolean

// After:
function emitNode(node: CsiNode, out: (Paragraph | SdtBlock)[]): boolean
```

**Change 3** — In `emitNode`, wrap paragraphs before pushing:
Replace every `out.push(para)` with `out.push(wrapWithControl(para, node.id))`.
There are three push sites (note, continuation, numbered) — all must be wrapped.
Vanished nodes return `false` without pushing — no change needed there.

**Change 4** — Update `generateDocx` local variable type and add title comment:
```typescript
// Before:
const children: Paragraph[] = [plainParagraph(`SECTION ${tree.section} — ${tree.title}`)]

// After:
// Title paragraph is synthetic — no CsiNode.id, not a round-trip anchor
const children: (Paragraph | SdtBlock)[] = [
  plainParagraph(`SECTION ${tree.section} — ${tree.title}`)
]
```

**TypeScript check:** `Document` section `children` is `readonly FileChild[]`. Since both `Paragraph` and `SdtBlock` extend `FileChild`, `(Paragraph | SdtBlock)[]` satisfies `FileChild[]` without cast. Verify:
```bash
grep -n "children.*FileChild\|FileChild.*children" node_modules/docx/dist/index.d.ts | head -5
```

**collectParagraphs signature** — also update to `(Paragraph | SdtBlock)[]`:
```typescript
// Before:
function collectParagraphs(nodes: readonly CsiNode[], out: Paragraph[]): void

// After:
function collectParagraphs(nodes: readonly CsiNode[], out: (Paragraph | SdtBlock)[]): void
```

---

## Phase 4: Verify Green

```bash
pnpm test       # all tests pass — existing + new content control tests
pnpm lint       # ESLint + tsc --noEmit + prettier check
pnpm build      # compilation succeeds
```

All three must be green before proceeding.

**If `pnpm lint` fails on `Paragraph | SdtBlock` union:** Extract a type alias in `controls.ts`:
```typescript
export type ParagraphOrSdt = Paragraph | SdtBlock
```
Import and use in `index.ts` to simplify the union type across signatures.

**Manual verification (optional but recommended):** Run dev server, call `POST /specs/:id/generate` with a seeded spec, save the buffer as `.docx`, open in LibreOffice Writer. Use Format > Content Controls or the Navigator to confirm SDT regions around each paragraph.

---

## Phase 5: README + ARCHITECTURE Update

### README.md

Read the current file before editing. Find the phase status table.

**Status table change** — split Phase 2b row into two:

Current row (approximate):
```
| Phase 2b  | AST → DOCX generator + content controls | Planned |
```

Replace with:
```
| Phase 2b-i  | AST → DOCX generator, 7-level CSI multilevel numbering | ✅ Complete (PR #26) |
| Phase 2b-ii | `w:sdt` content control UUID injection (round-trip anchors) | ✅ Complete (this PR) |
```

**"What Works Today" section** — add Generator subsection (or extend if present):
```
**Generator**
- `POST /specs/:id/generate` → streams DOCX buffer with 7-level CSI multilevel numbering
- Each paragraph wrapped in `w:sdt` content control with `specr-uuid-<id>` UUID tag (round-trip merge anchors)
```

**"Not Yet Built" section** — remove "AST → DOCX generator + content controls (Phase 2b)" entry (now complete). Keep Phase 2b-iii (MCP tools, issue #29), Phase 2c, Phase 3, Phase 4, Phase 5.

**API endpoint table** — if `POST /specs/:id/generate` is missing, add:
```
| POST /specs/:id/generate | Generate DOCX from stored spec AST |
```

### ARCHITECTURE.md

Find the Phase 2b description. Update to reflect both sub-phases shipped:
- Phase 2b-i: ✅ Complete (PR #26) — `generateDocx()`, `buildCsiNumberingConfig()`, 7-level CSI numbering, `POST /specs/:id/generate`
- Phase 2b-ii: ✅ Complete (this PR) — `wrapWithControl()`, `SdtBlock`, `specr-uuid-<id>` tags in `w:sdtPr`, round-trip merge anchors per ADR-004

---

## Phase 6: Commit + PR

```bash
git add \
  src/generator/controls.ts \
  src/generator/controls.test.ts \
  src/generator/index.ts \
  src/generator/index.test.ts \
  README.md \
  ARCHITECTURE.md
```

Commit message:
```
feat(generator): Phase 2b-ii — w:sdt content control UUID injection

Creates src/generator/controls.ts: SdtBlock extends FileChild (docx v9),
wrapWithControl(para, uuid) wraps each generated paragraph in w:sdt with
specr-uuid-<CsiNode.id> tag as round-trip merge anchor (ADR-004).

Uses StringValueElement('w:tag', ...) for idiomatic docx-native attribute
injection. Title paragraph intentionally left unwrapped (synthetic, no DB id).

Modifies src/generator/index.ts: out array typed as (Paragraph | SdtBlock)[],
emitNode wraps all three paragraph types (numbered, note, continuation).
Vanished nodes continue to return false without wrapping.

Updates README.md and ARCHITECTURE.md: Phase 2b-i marked complete (PR #26),
Phase 2b-ii marked complete (this PR).

Closes #28
```

PR body:
```markdown
## Summary

- Creates `src/generator/controls.ts`: `SdtBlock extends FileChild`, `wrapWithControl(paragraph, uuid)` — no `_attr` injection, no deprecated `addChildElement`, mirrors docx internals exactly
- Wraps every emitted paragraph (numbered, note, continuation) in `w:sdt` with `specr-uuid-<CsiNode.id>` UUID tag (ADR-004 round-trip anchor)
- Title paragraph intentionally bare — synthetic, no CsiNode.id, Phase 3 merge skips unwrapped paragraphs
- Updates README.md: Phase 2b-i → ✅ Complete (PR #26), Phase 2b-ii → ✅ Complete
- Updates ARCHITECTURE.md: Phase 2b section reflects both sub-phases shipped

## Why this matters

Phase 3 merge engine (issue #34) needs `extractContentControls()` to read `specr-uuid-` tags from an owner-redlined DOCX and map them back to DB paragraph records. This PR establishes that contract: every DB-backed paragraph in the generated DOCX carries its `paragraphs.id` as a `w:tag w:val` attribute.

## Test plan

- [ ] `pnpm test` — `controls.test.ts` (3 unit tests) + `index.test.ts` (6 new content control tests, all pre-existing tests still green)
- [ ] `pnpm lint` — ESLint + tsc + prettier clean
- [ ] `pnpm build` — compilation succeeds
- [ ] Integration (optional): `POST /specs/:id/generate` → save `.docx` → open in LibreOffice → verify content controls visible in Navigator
- [ ] `word/document.xml` in generated DOCX contains 6 `specr-uuid-` tags for `SYNTHETIC_TREE`, none for vanished node
```

---

## Out of Scope (do NOT include in this PR)

- Phase 2b-iii MCP tools (issue #29) — separate PR
- Phase 1c-iii DOCX cross-ref extraction (issue #27) — separate PR
- Phase 3 merge engine (issue #34) — depends on this PR but is a separate sub-MVP
- Style template engine (Phase 2c) — separate milestone
- Any changes to parse pipeline
- `extractContentControls()` inverse function — Phase 3a deliverable
