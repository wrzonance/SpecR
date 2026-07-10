# System Architecture

> ↩ [Architecture index](../../ARCHITECTURE.md)

```text
┌──────────────────────────────────────────────────────────────────────┐
│                    Client Surfaces                                     │
│                                                                        │
│  REST API (Express)         MCP (Streamable HTTP, same process)        │
│  ─────────────────          ────────────────────────────────           │
│  POST /parse                POST /mcp  ← stateless or session         │
│  GET  /specs/:id            GET  /mcp  (405 stub)                     │
│  POST /specs/:id/generate   DELETE /mcp (terminates a session)        │
│  POST /specs/:id/diff       tools: search_library, get_spec           │
│  POST /specs/:id/merge             list_sections                       │
│                             resources: specr://specs/{id} (Markdown)  │
│                                       specr://sections                 │
│            │                                │                          │
│            └────────────┬───────────────────┘                          │
│                         │  shared service layer                        │
│  ┌──────────────┐  ┌────┴─────────┐  ┌──────────────┐                │
│  │   Parser     │  │  Merge       │  │  Generator   │                │
│  │              │  │  Engine      │  │              │                │
│  │ .SEC → AST   │  │              │  │  AST → DOCX  │                │
│  │ DOCX → AST   │  │ 3-way diff   │  │  AST → MD    │                │
│  │  (5-signal   │  │ conflict det │  │  w/ content  │                │
│  │  inference)  │  │ merge resol  │  │  controls    │                │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                │
│         │                 │                 │                         │
│         └─────────────────┼─────────────────┘                         │
│                           │                                           │
│                    ┌──────▼──────┐                                    │
│                    │  AST Layer  │                                    │
│                    │  CsiNode    │                                    │
│                    │  CsiTree    │                                    │
│                    └──────┬──────┘                                    │
│                           │                                           │
│                    ┌──────▼──────┐                                    │
│                    │ PostgreSQL  │                                    │
│                    │ libraries   │                                    │
│                    │ paragraphs  │                                    │
│                    │ specs       │                                    │
│                    │ division    │                                    │
│                    │ general     │                                    │
│                    │ versions    │                                    │
│                    └─────────────┘                                    │
└──────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                        ▲
        │ DOCX/.SEC upload   │ Revit add-in (Ph. 4)   │ Claude/MCP client
        │ (multipart/REST)   │ C#/.NET direct calls   │ (Ph. 2+, ADR-010)
```

## Data Flow: Parse

```text
DOCX upload
    ↓
JSZip: extract document.xml, numbering.xml, styles.xml
    ↓
numbering.ts: build abstractNum → num → pStyle linkage map
    ↓
styles.ts:    build basedOn chains, identify numPr-carrying styles
    ↓
inference.ts: walk flat paragraph sequence
              combine 5 signals → assign parent/child relationships
    ↓
Canonical CSI AST (CsiTree with CsiNode hierarchy)
    ↓
PostgreSQL: insert spec + paragraph rows with parent_id, ilvl, version
    ↓
Return spec ID + summary
```

`.SEC`, `.txt`, and `.pdf` uploads enter the same pipeline through format adapters that converge on the AST. PDF (ADR-034) extracts the text layer via `unpdf` (falling back to `pdfjs-dist`); pages with no usable text layer are rasterized and OCR'd with `tesseract.js`, with font-encoding recovery, then fed to the text-based inference path. OCR worker init is time-bounded and offline-safe so scanned PDFs degrade with warnings rather than hang (ADR-039). A parse may also apply a saved structural numbering profile as a deterministic override instead of the default 5-signal inference (`numberingProfileId`, #299).

## Data Flow: Generate

```text
GET /specs/:id from PostgreSQL
    ↓
Reconstruct CsiTree from paragraph rows (recursive CTE → tree)
    ↓
generator/numbering.ts: assign CSI numbering (PART 1, 1.1, A., 1., a., 1), a))
    ↓
generator/controls.ts: wrap each paragraph in w:sdt with UUID tag
    ↓
dolanmiu/docx: build DOCX with multilevel list definition
    ↓
Return DOCX buffer
```

## Data Flow: Round-Trip Merge

```text
Client: POST /specs/:id/diff  (upload edited DOCX)
    ↓
Parse edited DOCX → new AST
    ↓
Match paragraphs by UUID tag (content control lookup)
    ↓
3-way diff: base_version (DB) + theirs (edited DOCX) + ours (current DB)
    ↓
Return diff: added[], modified[], deleted[], conflicts[]
    ↓
Client: POST /specs/:id/merge  (send accepted change IDs)
    ↓
Apply accepted changes to paragraph rows, bump base_version
    ↓
Return updated spec summary
```
