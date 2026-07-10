# Inference Engine

> ↩ [Architecture index](../../ARCHITECTURE.md)

## The 5-Signal Inference Engine

The core technical challenge of SpecR. DOCX files store paragraphs flat: hierarchy must be inferred. No single signal is reliable across all firms and documents. The engine **classifies** each paragraph by first-hit signal priority (1 → 2 → 4 → 5, with an article/indent correction) and records disagreements as conflicts; a read-time scorer then derives a 0–1 **confidence** by weighting the winning signal's tier (`src/parser/docx/hierarchy-confidence.ts`). The five signals and their confidence tiers:

| Signal | Source | Reliability |
|--------|--------|-------------|
| 1. Numbering XML | `numbering.xml` abstractNum→num→pStyle map | Highest — what Word actually respects |
| 2. Style chain | `styles.xml` basedOn traversal + numPr identification | High for clean documents |
| 3. Document order | Document-order fallback for continuations; default when signals 1/2/4/5 don't fire | Medium — always present |
| 4. Text content | Regex for leading numbering patterns ("A.", "1.", "PART 1") | Medium — catches hardcoded numbering |
| 5. Indentation | Left indent follows CSI staircase (~576 twips/0.4" per level) | Low — fallback only |

Algorithm is a port of Clippit's `ListItemRetriever` from C#, extended with signals 4 and 5 for real-world messy documents. Reference: `docs/research-executive-summary.md` § "Why Just Build Adapters Won't Work".

## CSI Numbering Standard

Universal across all spec sources, the one thing you can count on:

| Level | CSI Role | ARCAT ilvl | CPI ilvl | UFGS XML | Format |
|-------|----------|------------|-----------------|----------|--------|
| Part | Part heading | 0 | 0 | `<PRT>` | `PART 1 - GENERAL` |
| Article | Section heading | 1 | 3 | `<SPT>` | `1.1 REFERENCES` |
| PR1 | First tier | 2 | 4 | `<TXT>` depth 1 | `A. text` |
| PR2 | Second tier | 3 | 5 | `<TXT>` depth 2 | `1. text` |
| PR3 | Third tier | 4 | 6 | `<TXT>` depth 3 | `a. text` |
| PR4 | Fourth tier | 5 | 7 | `<TXT>` depth 4 | `1) text` |
| PR5 | Fifth tier | 6 | 8 | `<TXT>` depth 5 | `a) text` |
| PR6 | Sixth tier (deep extension) | 7 | 9 | `<TXT>` depth 6 | `1) text` |
| PR7 | Seventh tier (deep extension) | 8 | 10 | `<TXT>` depth 7 | `a) text` |

Note: CPI files reserve ilvl 1-2 for Schedule/PDS (rarely used), so the same logical CSI Article level maps to different ilvl values depending on which template authored the document. The inference engine normalizes this.

Note: CSI does not define PR6/PR7 labels. SpecR caps DOCX output at Word's nine numbering levels and repeats the final CSI paren pair (`1)` / `a)`) at deeper indent levels. See ADR-027.

Note: the `A. → 1. → a. → 1) → a)` rendering is the CSI PageFormat convention used by commercial masters (ARCAT, CPI, MasterSpec). UFGS renders the same logical tiers as decimal numbering (1.1.1.1); the table maps its XML depth onto the shared hierarchy.

**Conflict persistence (#56):** when multiple signals fire and disagree, the losing signals are recorded as `{ signal, reportedIlvl, reportedNodeType }` and persisted to `paragraphs.conflicts` (JSONB, `NOT NULL DEFAULT '[]'`). They surface as `meta.conflicts` on tree nodes (`get_spec` MCP tool and the shared `getSpecTree` query) and as a top-level `conflicts` field on the node and each ancestor returned by the `get_paragraph` MCP tool. Empty arrays are omitted on the wire. This makes inference ambiguity transparent to agents and the future UI instead of silently picking a winner.

Winner provenance is persisted alongside conflicts (ADR-055): `paragraphs.signal_provenance` (nullable JSONB) records `{ signalUsed, agreed }` — which signal won and which independently agreed with the final resolution. A pure read-time scorer (`src/parser/docx/hierarchy-confidence.ts`, exported via the parser barrel) derives `meta.inference` = `{ confidence 0–1, signalUsed, agreed, evidence[] }` from provenance + conflicts on every read, so the formula can improve without migration or reparse. NULL provenance = honestly unscored (pre-provenance parse or explicit-structure source), never a fake number. The onboarding report's `hierarchy` section (`src/lib/hierarchy-summary.ts`, review threshold 0.6) triages scored paragraphs worst-first.
