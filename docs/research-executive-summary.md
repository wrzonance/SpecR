# SpecR Research & Executive Summary

**Date:** 2026-05-05
**Status:** Research phase complete. No code written. This document captures all findings, architectural decisions, and hard truths from an extensive analysis of the DOCX/OOXML ecosystem and real-world CSI specification files.

> Point-in-time snapshot: library figures (stars, downloads, versions) reflect May 2026 and are not maintained. Factual errors found in later review have been corrected in place.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Why This Is Hard](#why-this-is-hard)
3. [The OOXML Format: What We're Fighting](#the-ooxml-format-what-were-fighting)
4. [Real-World Spec Analysis: Three Sources, Three Nightmares](#real-world-spec-analysis-three-sources-three-nightmares)
5. [Why "Just Build Adapters" Won't Work](#why-just-build-adapters-wont-work)
6. [The Open-Source Landscape](#the-open-source-landscape)
7. [Architecture Decisions Made](#architecture-decisions-made)
8. [What the Final Deliverable Should Look Like](#what-the-final-deliverable-should-look-like)
9. [What MVP Should Look Like](#what-mvp-should-look-like)
10. [Build Sequence](#build-sequence)
11. [Open Questions and Risks](#open-questions-and-risks)

---

## The Problem

No established open-source tool exists for CSI MasterFormat specification document automation. Commercial tools (MasterSpec via Deltek Specpoint, RIB SpecLink, e-SPECS) dominate, but their BIM integration is proprietary and plugin-locked rather than an open, programmable API. Revit models contain the ground truth of what's actually designed (what equipment is specified, what manufacturers were selected, what quantities exist), yet this data is manually transcribed into specification documents by humans who copy-paste between Revit schedules and Word files.

The goal is to build **SpecR**: a headless API service that treats specification documents as structured data, not opaque Word files. It should:

- Parse any firm's existing DOCX specifications into a structured database with true parent/child paragraph relationships
- Generate specification documents parametrically from a library of tagged paragraphs
- Accept Revit model data to auto-populate Part 2 (Products) sections
- Support git-style 3-way merge when Owner/Client edits come back
- Work across all CSI divisions from day one
- Support multiple firms, each with their own master libraries and style templates
- Be company-agnostic: not tied to any single firm's conventions

---

## Why This Is Hard

The difficulty is not in any single feature. It's in the intersection of five requirements that each individually seem manageable but together create a combinatorial explosion:

1. **Company-agnostic parsing**: Every firm uses different styles, numbering, and authoring conventions. There is no single "correct" DOCX spec format.

2. **Round-trip fidelity**: Documents leave the system, get manually edited by people who don't have this tool, and must come back in without losing their changes.

3. **Hierarchy inference**: The DOCX format stores paragraphs flat. Parent/child relationships do not exist in the file. They must be inferred, and the inference rules change depending on who authored the document.

4. **Full numbering control**: CSI specifications use specific multilevel numbering (PART 1, 1.1, A., 1., a., 1), a)...) that must be reproduced exactly. "Close enough" numbering in a construction specification is a liability issue.

5. **All divisions, all firms**: Division 27 (telecom) and Division 28 (electronic safety) are the initial use cases, but the system must handle Division 03 (concrete) or Division 09 (finishes) with equal fidelity.

---

## The OOXML Format: What We're Fighting

### The Flat Paragraph Model

A DOCX file's `document.xml` is a flat sequence of `<w:p>` elements. There is no nesting, no grouping, no parent references. A paragraph knows only two things about its list membership:

- `numId`: which numbering instance it belongs to
- `ilvl`: which level (0-8) within that numbering

The fact that "Paragraph A is the parent of Paragraph 1" is **never stated** in the file. It must be inferred from document order and level comparison. This is the fundamental architectural limitation everything else flows from.

### The 6-Layer Style Resolution Cascade

Effective paragraph formatting comes from six layers, applied in this order:

1. Document defaults (`w:docDefaults`)
2. Table style properties (if in a table)
3. Numbering style properties (from `abstractNum/lvl/pPr`)
4. Paragraph style properties (walking the `basedOn` chain)
5. Numbering definition direct properties (when `numPr` is applied directly)
6. Direct formatting (inline on the paragraph)

Each layer can set, override, or remove properties from lower layers. Toggle properties (bold, italic, caps) use XOR semantics across layers: bold inherited + bold applied = NOT bold. The cascade is intricate enough that the specification's own presentation of it is widely considered easy to misread, and implementations disagree in practice. If the standard itself is this hard to read correctly, every third-party implementation is suspect.

### The 276 Latent Built-In Styles

Word ships with 276 built-in styles that are NOT written to `styles.xml` until a user explicitly uses them. A document can reference a style that has no definition in the file, and the consuming application is expected to "just know" what `Heading 1` looks like. This means a parser that only reads `styles.xml` will miss critical style information.

### The Numbering System's Two-Tier Architecture

Numbering definitions have an abstraction layer:

- `abstractNum`: defines formatting for up to 9 levels. Cannot be directly referenced by paragraphs.
- `num`: an instance that references an `abstractNum` and CAN be referenced. Can override specific levels via `lvlOverride`.

Multiple `num` instances can reference the same `abstractNum` with different overrides. A single document can have dozens of numbering instances, some sharing formatting and some diverging. The `pStyle` element in a numbering level creates a bidirectional link between a style and a numbering level, but only if both sides agree. If either side is missing, behavior degrades silently.

### What Nobody Tells You

- `multiLevelType` is a UI hint only. The spec explicitly says it "shall not be used to limit the behavior of the list." A list marked `singleLevel` can use all 9 levels.
- `numId="0"` is a sentinel that means "remove numbering from this paragraph": it doesn't reference numbering definition zero.
- Numbering inherited from a paragraph style has LOWER precedence than the paragraph style's own properties, but numbering applied directly to a paragraph has HIGHER precedence. This dual-source, split-precedence model is one of the most confusing aspects of OOXML.

---

## Real-World Spec Analysis: Three Sources, Three Nightmares

We analyzed 60 specification files across three sources in the `SpecR/docs/references/` directory. Each represents a different authoring ecosystem with fundamentally different approaches to the same CSI structure.

### ARCAT (23 files, manufacturer guide specs)

ARCAT specs are **machine-generated** from ARCAT's content management system. Every element carries the revision ID `ABFFABFF` and metadata shows 1 minute of edit time. This makes them the cleanest to parse, but also the least representative of real-world editing.

**Key patterns:**
- 14 custom styles, ALL root-level (no `basedOn` inheritance whatsoever)
- Single `abstractNum` with single `num` instance: one numbering system for the entire document
- Rigid 1:1 pStyle ↔ ilvl mapping: `ARCATPart`=ilvl 0, `ARCATArticle`=ilvl 1, `ARCATParagraph`=ilvl 2, etc.
- **Redundant numPr everywhere**: both the style definition AND every paragraph carry explicit `numPr`. Defensive pattern: if one source breaks, the other still works.
- No continuation styles: every content paragraph is numbered
- 76% of content at SubSub1 or deeper (ilvl 4+): manufacturer specs are bottom-heavy product data
- Zero content controls (`w:sdt`), zero custom XML parts
- Specifier notes use `ARCATnote` style: red text, dotted red border, `w:vanish` (hidden)
- Part numbering renders as `PART  1  GENERAL` (double-spaced, no dash): differs from standard CSI `PART 1 - GENERAL`

**Numbering hierarchy (ilvl → format):**
```
0: PART %1     (decimal, suffix=nothing)
1: %1.%2       (decimal, composite Part.Article)
2: %3.          (upperLetter: A., B., C.)
3: %4.          (decimal: 1., 2., 3.)
4: %5.          (lowerLetter: a., b., c.)
5: %6)          (decimal: 1), 2), 3))
6: %7)          (lowerLetter: a), b), c))
7: %8)          (decimal: 1), 2), 3))  [defined but unused]
8: %9)          (lowerLetter: a), b), c))  [defined but unused]
```

### Chatsworth Products Inc. (CPI) (6 files, CSI MasterFormat manufacturer specs)

Chatsworth Products Inc. (CPI) is a telecom equipment manufacturer whose guide specs implement CSI MasterFormat. Their DOCX files are more sophisticated than ARCAT's but introduce several complications.

**Key patterns:**
- Style naming in CPI files: `PRT`, `ART`, `PR1`-`PR5`, `SCT`, `EOS`, `CMT`
- Numbering lives in style definitions: paragraphs do NOT redundantly carry numPr (opposite of ARCAT)
- **Continuation styles (lc variants)**: `PR1lc` through `PR5lc` suppress numbering while maintaining indentation. 34% of content uses these. The `next` style property means pressing Enter after an lc paragraph switches to the numbered variant.
- **Manual numbering in text is rampant**: People type "A." or "1.5" in the paragraph text on lc-styled paragraphs, defeating OOXML automatic numbering. A parser seeing `PR1lc` with text "A. ANSI/TIA-569..." must recognize the "A." is cosmetic, not structural.
- **Override numbering**: Multiple numId values reference different abstractNums or the same abstractNum with different `lvlOverride` settings. Product section headers like "2.2 ZETAFRAME CABINET SYSTEM" use PR1 with numId=12 instead of the ART style, creating "fake" article headings outside the main numbering sequence.
- **numId=0 for explicit suppression**: Some paragraphs explicitly disable numbering that their style would otherwise provide.
- **ilvl gap**: CPI files reserve ilvl 1 and 2 for Schedule and Product Data Sheet (rarely used), so Article jumps to ilvl 3. PR1 is ilvl 4. This means the same logical CSI level maps to different ilvl values depending on which template authored the document.
- **outlineLvl=9 overrides**: 307 paragraphs override their style's outline level to 9 (body text), suppressing them from the document outline.
- **Unit markup**: Character styles `IP` (red) and `SI` (teal) mark Imperial/metric alternatives within the same paragraph, with `esUOMDelimiter` separating them. This is semantic markup that could be programmatically toggled.
- 215 hidden `CMT` paragraphs (29% of document): specifier notes in blue with `w:vanish`
- Zero content controls, but does have an empty `customXml/` with a bibliography placeholder

**Numbering hierarchy (ilvl → format):**
```
0: PART %1 -           (decimal, suffix=space)
1: SCHEDULE %2 -       (decimal, suffix=nothing)  [rarely used]
2: PRODUCT DATA SHEET %3 -  (decimal, suffix=nothing)  [rarely used]
3: %1.%4               (decimal, composite Part.Article)
4: %5.                  (upperLetter: A., B., C.)
5: %6.                  (decimal: 1., 2., 3.)
6: %7.                  (lowerLetter: a., b., c.)
7: %8)                  (decimal: 1), 2), 3))
8: %9)                  (lowerLetter: a), b), c))
```

### UFGS / SpecsIntact (31 directories by division, .SEC files)

UFGS specifications are NOT DOCX files. They are SpecsIntact XML (`.SEC` format): a purpose-built semantic XML schema from SpecsIntact, software originally developed by NASA (1963, long maintained at Kennedy Space Center; USACE took over program management in 2023) and used by USACE/NAVFAC/AFCEC. This is the most important finding of the analysis because UFGS is the richest potential seed data source and it already solves the hierarchy problem.

**Key patterns:**
- Files are XML with a `<SEC>` root element, using the schema at `specsintactSEC.xsd`
- **Hierarchy IS the XML tree**: `<PRT>` (Part) contains `<SPT>` (Sub-Part/Article) contains `<TXT>` (body text) and `<LST>`/`<ITM>` (lists/items). No inference needed.
- `<NTE>` wraps specifier notes with `<NPR>` for note paragraphs, equivalent to CMT/ARCATnote but semantically tagged
- `<MET>`/`<ENG>` tags wrap metric/English unit alternatives, similar to IP/SI unit-alternation approaches in DOCX templates but as proper XML elements
- `<TAI OPT="ARMY">` elements mark service-branch-specific tailoring options
- `<RID>` tags mark reference identifiers (linked to the References article)
- `<URL>` tags with `HREF` attributes for linked resources
- `<SRF>` for section cross-references
- `<BRK>` and `<BRL>` for line/paragraph breaks
- `AUTONUMBER="TRUE"` in metadata indicates automatic numbering
- Files are dated as recently as November 2025: current MasterFormat
- US government work = public domain, no copyright restrictions

**Why this matters:** UFGS .SEC files give us a pre-parsed, hierarchically structured, semantically tagged, public domain corpus of specification content across all CSI divisions. It's the perfect seed data source because we don't need to solve the parsing problem to ingest it: the hierarchy is explicit.

### The Universal CSI Numbering Pattern

Despite wildly different encodings, all three sources use the same logical hierarchy:

| Logical Level | CSI Role | ARCAT ilvl | CPI ilvl | UFGS XML | Rendered |
|---|---|---|---|---|---|
| Part | Part heading | 0 | 0 | `<PRT>` | PART 1 - GENERAL |
| Article | Section heading | 1 | 3 | `<SPT>` | 1.1 REFERENCES |
| PR1 | First paragraph tier | 2 | 4 | `<TXT>` depth 1 | A. text |
| PR2 | Second paragraph tier | 3 | 5 | `<TXT>` depth 2 | 1. text |
| PR3 | Third paragraph tier | 4 | 6 | `<TXT>` depth 3 | a. text |
| PR4 | Fourth paragraph tier | 5 | 7 | `<TXT>` depth 4 | 1) text |
| PR5 | Fifth paragraph tier | 6 | 8 | `<TXT>` depth 5 | a) text |

The numbering format sequence (decimal → upperLetter → decimal → lowerLetter → decimal → lowerLetter) is identical across all sources. This is the CSI standard. It is the one thing you can count on.

---

## Why "Just Build Adapters" Won't Work

The temptation after analyzing ARCAT and CPI is to think: "Two known formats, two adapters, done." This would be a critical mistake. Here's why:

### 1. Every Firm Customizes Their Templates

No two firms implement CSI MasterFormat DOCX templates the same way. A firm might:
- Rename styles (`PR1` → `SpecParagraph1`, `ART` → `SectionHeading`)
- Add custom styles not in any standard template
- Use Word's built-in Heading styles instead of CSI MasterFormat template styles
- Mix standard CSI styles with custom styles in the same document
- Override numbering definitions to match their house style
- Change the numbering format (some firms use `1)` instead of `1.` at certain levels)

An adapter that pattern-matches on style names will break the moment it encounters a firm that renamed their styles.

### 2. Manual Editing Destroys Structural Consistency

The CPI analysis proved this. Even in a manufacturer-authored "clean" spec:
- Article-level headings were created with PR1 + override numbering instead of the ART style
- 34% of content used lc continuation styles with manual numbering typed into the text
- numId=0 was used to suppress numbering on paragraphs that should have been a different style
- outlineLvl was overridden on 300+ paragraphs

Now imagine what happens when a junior spec writer at a 50-person firm edits this document for 6 months. Styles get mixed. Numbering breaks. People "fix" it by hardcoding numbers. Format Painter smears properties across unrelated paragraphs. Paragraphs get pasted from other documents carrying foreign styles and numbering definitions. The document still looks correct when printed: Word's rendering engine is forgiving. But the underlying XML is a disaster.

### 3. The "Looks Right, Parses Wrong" Problem

A document can render identically to a human reader while having completely different XML structures:

**Document A** (clean):
```
ART style, ilvl=3, numId=1 → renders "2.1 PRODUCTS"
  PR1 style, ilvl=4, numId=1 → renders "A. Manufacturer: Corning"
```

**Document B** (messy, looks identical):
```
Normal style, no numPr → text contains "2.1 PRODUCTS" (hardcoded)
  PR1lc style, no numPr → text contains "A. Manufacturer: Corning" (hardcoded)
```

**Document C** (also looks identical):
```
Heading 2, outline level 1 → text "2.1 PRODUCTS" (number from heading numbering)
  List Paragraph, ilvl=0, numId=7 → renders "A. Manufacturer: Corning"
```

All three render the same. A style-name adapter handles A. A generic inference engine handles A and maybe B. Only a hybrid approach with fallback heuristics handles C. And D through Z are waiting in the wild.

### 4. Numbering Restart Edge Cases

When do counters restart? The OOXML spec says "when a higher-level item appears" but:
- `lvlRestart` can override this per-level
- `lvlOverride` with `startOverride` can reset at specific paragraphs
- Multiple `num` instances sharing the same `abstractNum` can have different restart behavior
- Non-list paragraphs between list items don't reset counters (OOXML counters persist across gaps)
- But some firms expect them to restart. Because that's how it worked in their old WordPerfect template.

### 5. The Round-Trip Problem Amplifies Everything

If this were one-way (database → DOCX), you control the output. You generate clean XML. But round-trip means:
- You generate clean DOCX
- Owner opens it in Word 2016 on Windows
- Their junior associate opens it in Word for Mac
- Someone else opens it in LibreOffice
- It goes through a PDF conversion and back
- Track changes accumulate
- Someone pastes content from a completely different spec
- It comes back to you

Your parser must handle whatever comes back. You cannot assume the structural conventions you generated will survive. Content controls might get stripped. Styles might get remapped. Numbering definitions might get duplicated with different IDs.

### 6. What Actually Has to Happen

Instead of named adapters, the parser needs a **multi-signal inference engine**:

**Signal 1: Numbering XML analysis.** Read `numbering.xml`. Map every `abstractNum` → `num` → `pStyle` linkage. This is the most reliable structural signal because it's the one thing Word's numbering engine actually respects.

**Signal 2: Style analysis.** Read `styles.xml`. Build the `basedOn` chain. Identify which styles carry `numPr`. Map styles to their effective numbering levels. Recognize known template signatures (ARCAT, CPI) but don't depend on them.

**Signal 3: Document-order heuristics.** Walk `document.xml` in order. Track ilvl transitions. When ilvl increases, that's a child. When ilvl decreases, walk back up the tree. When ilvl stays the same, that's a sibling. This is the fallback when style and numbering signals are ambiguous.

**Signal 4: Text-content heuristics.** Regex for leading numbering patterns in paragraph text ("A.", "1.", "a)", "PART 1 -"). Cross-reference against the numbering definition. If the text contains a number that matches what the numbering engine should generate, it's redundant (manual numbering on a numbered paragraph). If the text contains a number but the paragraph has no numbering, it's hardcoded. If the text says "PART 2 - PRODUCTS", that's a Part heading regardless of what style it's using.

**Signal 5: Indentation analysis.** Even when numbering is absent, left indent values often follow the CSI staircase pattern (each level adds ~576 twips / 0.4"). Indentation can be a fallback signal for hierarchy depth.

These signals must be weighted, combined, and capable of disagreeing. A paragraph with style PR1lc (signal 2 says "no number, PR1 level") that has text starting with "A." (signal 4 says "looks like A. numbering") and left indent of 1152 twips (signal 5 says "level 2") should be classified as a PR1-level paragraph with manually hardcoded numbering. The parser should strip the leading "A." and let the numbering engine handle it on regeneration, or preserve it if round-trip fidelity requires it.

---

## The Open-Source Landscape

### Libraries That Actually Resolve Style Inheritance

Out of dozens of DOCX libraries across all languages, only four resolve the style cascade:

| Library | Language | License | What It Does |
|---|---|---|---|
| **docx4j** `PropertyResolver` | Java | Apache 2.0 | Full ECMA-376 style resolution. Walks basedOn chain, caches results. Gold standard. |
| **Clippit** (ex-Open-Xml-PowerTools) | C# | MIT | Full style resolution + `ListItemRetriever` for hierarchy. The one library that reconstructs Word's OOXML-numbering-faithful list tree. |
| **docx-parser-converter** | Python | MIT | 3-phase parse→resolve→convert with Pydantic models. 22 GitHub stars but architecturally sound. |

### Libraries That Infer List Hierarchy

Only Clippit's `ListItemRetriever` reconstructs Word's numbering-faithful parent/child list tree with `LevelNumbers` arrays (Docling and Dedoc build heuristic/semantic section trees instead; `docx-parser-converter` and `officeParser` expose list/`ilvl` metadata but not a numbering-faithful tree). Most other libraries give you flat paragraphs with ilvl values and say "good luck."

### Libraries for DOCX Generation

| Library | Language | License | Stars | Downloads | Notes |
|---|---|---|---|---|---|
| **dolanmiu/docx** | TypeScript | MIT | 5,700 | 8M/week | Best writer. Full numbering control. Write-only. |
| **docxtemplater** | JavaScript | MIT/GPL | 3,600 | 600K/week | Template-based. Paid modules for advanced features. |
| **python-docx** | Python | MIT | 5,560 | — | Read+write. No high-level list API. Low-level XML escape hatch. |
| **docxtpl** | Python | LGPL-2.1 | 2,626 | — | Jinja2 templates. `Subdoc` for fragment assembly. |
| **docxcompose** | Python | MIT | 131 | — | DOCX merging with style/numbering consistency. |

### Libraries for DOCX Parsing/Reading

| Library | Language | License | Stars | Style Resolution | List Hierarchy |
|---|---|---|---|---|---|
| **officeParser** | TypeScript | MIT | 428 | StyleMap (partial) | AST with listId, indentation, itemIndex |
| **docx-parser-converter** | Python | MIT | 22 | Full 3-phase | Yes, with counter tracking |
| **mammoth.js** | JavaScript | BSD-2 | 6,200 | No | Partial (known bugs at 3+ levels) |
| **Docling** (IBM) | Python | MIT | 59,172 | Not detailed | Hierarchical tree output |
| **Dedoc** | Python | Apache 2.0 | 661 | Not detailed | Tree with headings/lists |
| **python-docx** | Python | MIT | 5,560 | Exposes chain, no resolution | No API |

### The Gap

No permissively licensed, headless TypeScript/JavaScript library exposes a fully resolved style cascade plus a numbering-faithful paragraph tree as a consumable AST (docx-preview resolves styles only to render HTML; officeParser emits a structural AST but doesn't walk the full `basedOn` chain), and none does heuristic inference when numbering is absent — the hard part. Building SpecR in TypeScript means porting the inference algorithms from Clippit (C#) or docx4j (Java).

### Document Assembly Tools

| Tool | License | Language | Key Feature |
|---|---|---|---|
| **Docassemble** | MIT | Python | Full guided interview → DOCX generation. Legal tech standard. |
| **docxtpl** `Subdoc` | LGPL-2.1 | Python | Compose DOCX from reusable fragments with Jinja2 logic. |
| **docxcompose** | MIT | Python | Merge multiple DOCX with style/numbering consistency. |
| **Carbone** | CCL | JavaScript | Mustache templates, 10ms/doc generation. |

### Office Add-ins (Office.js)

The Word JavaScript API provides paragraph, style, and list control from within Word Online and Desktop:
- `Word.Style.baseStyle` (WordApi 1.5), `linkToListTemplate()` (WordApiDesktop 1.3 — desktop-only, unavailable in Word on the web)
- `getOoxml()` / `insertOoxml()` for full OOXML round-trip from client-side
- NPM packages (JSZip, docxtemplater, dolanmiu/docx) work inside the add-in sandbox
- **Critical limitation**: `Word.ListLevel` and `Word.ListTemplate` are Desktop-only. No custom list level manipulation in Word Online.

---

## Architecture Decisions Made

These were confirmed during the research session and should be treated as requirements:

1. **API-first (headless)**: No UI in the core. REST API that any client can consume. Primary clients will be a Revit add-in and a web interface.

2. **Revit add-in calls API directly**: Not file export → upload. Direct API calls from within Revit. Web interface shows incoming diffs and change review. Autodesk Platform Services (APS/Forge cloud) as later-stage goal. Architecture must support it from start.

3. **Git-style 3-way merge**: Not "last writer wins." Full conflict detection and resolution. User can reject changes. Base version tracked for every paragraph.

4. **All CSI divisions from day one**: Not telecom-only. The data model and parser must handle any division.

5. **Multi-tier paragraph libraries**:
   - **Seed tier**: Public domain sources (UFGS) as optional baseline
   - **Firm tier**: Master paragraph library maintained per division/section
   - **Style tier**: DOCX output template (firm's formatting/branding)
   - **Project tier**: Project-specific overrides and Revit-injected content

6. **TypeScript/Node.js**: Best ecosystem coverage for both DOCX generation (dolanmiu/docx) and future Office Add-in development. Single language across server and potential client-side extensions.

7. **Content controls as merge anchors**: Every API-generated paragraph wrapped in `w:sdt` with UUID tag for round-trip tracking.

8. **Canonical CSI AST as internal representation**: Not raw OOXML. A normalized tree structure that can render to DOCX, Markdown, HTML, or JSON. The database IS the AST.

9. **Markdown as future parallel output**: For true git text diffing and AI-friendly document processing. Not MVP but the AST-based architecture must support it from day one.

---

## What the Final Deliverable Should Look Like

### For a Spec Writer

1. Open web interface. Select firm, division, section (e.g., 27 21 00 - Audio/Visual Systems).
2. System presents the firm's master spec for that section, with Part 1 (General), Part 2 (Products), Part 3 (Execution) pre-populated from the firm library.
3. Connect to a Revit model (via add-in or APS). System reads equipment families, types, and parameters.
4. Part 2 auto-populates with manufacturer, model, and performance data pulled from the Revit model. Paragraphs are tagged with Revit parameter sources.
5. Spec writer reviews, edits, exports to DOCX using the firm's style template.
6. DOCX goes to the Owner/Client for review. They redline it in Word.
7. Redlined DOCX comes back. System parses it, shows a diff view. Spec writer accepts/rejects changes.
8. System merges accepted changes back into the database. Rejected changes are documented.
9. Next design iteration in Revit changes some equipment. Revit add-in pushes updates. System shows what changed in Part 2. Spec writer reviews.
10. Cycle repeats until construction documents are issued.

### For a Firm Administrator

1. Upload the firm's existing spec library (DOCX files for each section).
2. System parses them into structured data, inferring hierarchy and tagging paragraphs.
3. Admin reviews the parsed structure, corrects any inference errors.
4. Sets up Revit parameter → spec paragraph mappings for their standard families.
5. Configures the firm's DOCX style template (fonts, margins, header/footer, numbering format).
6. New projects inherit from the firm library but can override at the project level.

### For a Developer / Integrator

1. REST API with endpoints for: libraries, paragraphs (CRUD + tree operations), specs (generate, parse, diff, merge), Revit mappings, style templates.
2. OpenAPI spec for code generation in any language.
3. Webhook support for Revit add-in integration and CI/CD pipelines.
4. Export formats: DOCX, JSON (AST), Markdown.
5. Import formats: DOCX (any firm), .SEC (UFGS), JSON (AST).

---

## What MVP Should Look Like

MVP is the smallest thing that proves the core thesis: **specification documents can be treated as structured data with true parent/child relationships, and round-tripped through manual editing without data loss.**

### MVP Scope

1. **UFGS .SEC parser** → canonical AST → PostgreSQL
   - Easiest win. Hierarchy is already explicit in the XML.
   - Seeds the database with public domain spec content across all divisions.
   - Proves the database schema works.

2. **DOCX parser** (generic, not template-specific)
   - Reads numbering.xml, styles.xml, document.xml
   - Infers hierarchy using the multi-signal approach (numbering + style + document order + text heuristics + indentation)
   - Outputs canonical CSI AST
   - Handles at least ARCAT and CPI conventions, plus a "best effort" fallback for unknown templates
   - Identifies and strips specifier notes (vanish text)

3. **DOCX generator**
   - Takes canonical AST → produces DOCX with correct multilevel numbering
   - Content controls with UUID tags on every generated paragraph
   - Single hardcoded style template (can be CPI or ARCAT convention)

4. **Round-trip proof of concept**
   - Generate DOCX from database
   - Open in Word, make edits (add paragraph, modify text, delete paragraph)
   - Re-parse the edited DOCX
   - Diff against the database version
   - Show what was added, modified, deleted
   - Apply accepted changes back to database

5. **REST API** (no web UI in MVP)
   - `POST /parse`: upload DOCX or .SEC → returns a parse job (async)
   - `GET /parse/jobs/{jobId}`: poll parse status, get AST back
   - `GET /specs/{id}`: get spec tree from database
   - `POST /specs/{id}/generate`: generate DOCX from spec tree
   - `POST /specs/{id}/diff`: upload edited DOCX, get diff against stored version
   - `POST /specs/{id}/merge`: apply accepted changes

### MVP Does NOT Include

- Revit integration (Phase 2)
- Web UI (Phase 2)
- Multi-firm library management (Phase 3)
- Style template configuration (Phase 3)
- Markdown output (Phase 4)
- APS cloud integration (Phase 5)
- Firm-specific adapter plugins (handled by generic parser with heuristics)

### MVP Success Criteria

Take a real ARCAT spec DOCX. Parse it. Store it. Regenerate it. Open in Word. Edit 5 paragraphs. Delete 2. Add 3. Save. Parse the edited version. Correctly identify all 10 changes. Apply them. Regenerate. The result should be structurally identical to what a human would have produced, with correct numbering throughout.

---

## Build Sequence

### Phase 0: Foundation (Weeks 1-2)
- Project scaffolding (TypeScript, Node.js, PostgreSQL)
- CSI MasterFormat division/section reference data in database
- Paragraph tree data model with parent/child relationships, versioning
- Basic CRUD API for specs and paragraphs

### Phase 1: Parser (Weeks 3-6)
- UFGS .SEC parser (semantic XML → canonical AST → database)
- DOCX numbering.xml analyzer (map all abstractNum → num → pStyle linkages)
- DOCX styles.xml analyzer (build basedOn chains, identify numPr-carrying styles)
- Hierarchy inference engine (multi-signal: numbering + style + order + text + indent)
- Content control tag injection on parse
- Port Clippit's ListItemRetriever algorithm to TypeScript
- Test against all 60 reference files

### Phase 2: Generator (Weeks 5-7, overlaps with Phase 1)
- AST → DOCX with dolanmiu/docx library
- Multilevel numbering engine (reproduce exact CSI numbering from AST)
- Content control wrapping for round-trip anchoring
- Style template loading (at minimum: ARCAT and CPI conventions)
- OOXML direct manipulation via JSZip for anything dolanmiu/docx can't handle

### Phase 3: Merge Engine (Weeks 7-9)
- Content-control-based paragraph matching (UUID tag lookup)
- 3-way diff algorithm (base + theirs + ours)
- Conflict detection (same paragraph modified by both sides)
- Merge resolution API (accept/reject per conflict)
- Version tracking (base_version on every paragraph)

### Phase 4: Revit Integration (Weeks 10-12)
- Revit parameter → CSI paragraph mapping schema
- Revit add-in (C#/.NET) calling SpecR API
- Part 2 auto-population from Revit model data
- Change detection (Revit model updated → show spec changes)

### Phase 5: Web UI + Polish (Weeks 12-16)
- Spec editor (tree view with inline editing)
- Diff/merge review interface
- Library management (firm → project hierarchy)
- Style template configuration
- User management and multi-firm support

### Phase 6: Scale (Ongoing)
- Markdown parallel output
- APS cloud integration
- AI-assisted paragraph generation/suggestion
- Full-text search across paragraph libraries
- Analytics (which paragraphs change most, which get rejected by owners)

---

## Open Questions and Risks

### Unresolved Technical Questions

1. **Content control survival rate**: How often do Word, LibreOffice, and Google Docs strip or modify content controls during editing? If content controls don't survive the round-trip, the entire merge strategy collapses. Need to test with real editing workflows across all three applications.

2. **Numbering regeneration fidelity**: When regenerating a DOCX from the AST, can we reproduce the exact numbering the user saw in the original? Or will minor differences (extra space in "PART  1  " vs "PART 1 -") confuse users who compare old and new?

3. **Table handling**: CSI specs contain tables (product schedules, performance data). Tables have their own paragraph model with cells. How deep does table parsing need to go for MVP?

4. **Cross-reference integrity**: Specs cross-reference other sections ("See Section 26 00 00"). When Part 2 content changes, cross-references may need updating. How much cross-reference management is in scope?

5. **Image and drawing handling**: Some specs embed detail drawings or product images. These need to survive round-trip even if we don't parse their content.

6. **Track changes**: Owner redlines may use Word's track changes feature. Should the parser read tracked changes as "their" changes? Or require the owner to accept/reject before returning the file?

### Risks

1. **The "messy middle" of real-world specs**: Our analysis covered machine-generated (ARCAT) and manufacturer-authored (CPI) specs. The hardest specs to parse will be the ones that started from a template, were edited by 5 different people over 3 years, had content pasted from 4 other documents, and were last saved in compatibility mode from Word 2010. This is the majority of specs in production.

2. **OOXML version differences**: Word 2007, 2010, 2013, 2016, 2019, 2021, and 365 each introduced OOXML extensions. LibreOffice and Google Docs produce slightly different OOXML. The parser must handle all of them.

3. **Performance at scale**: A firm library might have 500+ sections with 50,000+ paragraphs. The merge engine must handle large diffs without degrading. PostgreSQL with proper indexing should handle this, but the tree queries (recursive CTEs for ancestor/descendant operations) need benchmarking.

4. **Legal/licensing**: UFGS content is public domain. ARCAT specs may have usage restrictions despite being freely downloadable. MasterSpec content is copyrighted by the AIA and published/licensed by Deltek (Specpoint). The paragraph library must be clearly separated from copyrighted source material: the tool processes documents, it doesn't redistribute their content.

5. **Adoption chicken-and-egg**: The tool is most valuable with a populated paragraph library, but building the library requires the tool. UFGS import partially solves this for the seed tier, but firm-specific content must be built by each firm.

6. **The "just use SpecLink" argument**: Commercial tools have 30+ years of accumulated spec content. SpecR's advantage is BIM integration and open-source flexibility, not content library depth. The value proposition must be clearly differentiated from "we're a worse SpecLink."

---

## Reference Materials

### Specifications Analyzed
- `docs/references/ARCAT/`: 23 DOCX files, ARCAT manufacturer guide specs
- `docs/references/MANUFACTURER_CPI/`: 6 DOCX files, Chatsworth Products Inc. CSI MasterFormat specs
- `docs/references/UFGS/`: 31 directories by division, SpecsIntact .SEC format

### Key Libraries (with repository links)
- dolanmiu/docx (TS, MIT): https://github.com/dolanmiu/docx
- officeParser (TS, MIT): https://github.com/harshankur/officeParser
- Clippit (C#, MIT): https://github.com/sergey-tihon/Clippit
- docx4j (Java, Apache 2.0): https://github.com/plutext/docx4j
- docx-parser-converter (Python, MIT): https://github.com/omer-go/docx-parser-converter
- python-docx (Python, MIT): https://github.com/python-openxml/python-docx
- docxtpl (Python, LGPL-2.1): https://github.com/elapouya/python-docx-template
- docxcompose (Python, MIT): https://github.com/4teamwork/docxcompose
- Docling (Python, MIT): https://github.com/docling-project/docling
- Docassemble (Python, MIT): https://github.com/jhpyle/docassemble

### OOXML Specifications
- ECMA-376 (5th edition): https://ecma-international.org/publications-and-standards/standards/ecma-376/
- Office Open XML reference: http://officeopenxml.com/
- Style hierarchy (Section 17.7.2): https://ooxml.info/docs/17/17.7/17.7.2/

### Academic Papers on Document Hierarchy
- "Detect-Order-Construct" (2024, Microsoft): https://arxiv.org/abs/2401.11874
- "LayerDoc" (WACV 2023, Adobe): spatial hierarchy extraction
- "DocStruct" (EMNLP 2020): multimodal hierarchy extraction
- "Document Parsing Unveiled" (2024 survey): https://arxiv.org/html/2410.21169v4
