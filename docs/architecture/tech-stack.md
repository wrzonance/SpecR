# Tech Stack & Dependencies

> ↩ [Architecture index](../../ARCHITECTURE.md)

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Language | **TypeScript** | One language across the server and a future Word add-in. The best DOCX-writing library (dolanmiu/docx) is TypeScript, and Office add-ins are written in JavaScript/TypeScript too. |
| Runtime | **Node.js 22 LTS** | Long-term-support release (maintenance until April 2027), with a built-in `fetch` and native TypeScript type-stripping. |
| API framework | **Express** | A small, widely used web framework with no hidden behavior, so it's easy to read and reason about. |
| Database | **PostgreSQL** | Walks the paragraph tree in a single query (recursive CTEs), stores each spec's document tree as JSON (JSONB), and keeps a version history of every row. |
| Input validation | **Zod** | Checks that incoming data is the right shape at every edge of the system: API requests, environment config, and parsed XML. |
| DOCX generation | **dolanmiu/docx** | The only widely used TypeScript library with a first-class API for defining Word's full multi-level numbering from scratch (the heart of CSI specs); template-based tools only inherit numbering from a pre-authored template. Permissively licensed (MIT), popular, and actively maintained. It has no parser (it cannot read an arbitrary DOCX into a structured model), so SpecR does its own parsing. |
| DOCX parsing | **JSZip** (raw OOXML) | A `.docx` is a zip of XML files; JSZip opens it. No permissively licensed headless library exposes Word's fully resolved styles and list hierarchy as a consumable tree (renderers like docx-preview resolve them only to emit HTML), so we read the raw XML and infer the structure ourselves. |
| SEC parsing | **fast-xml-parser** | SpecsIntact `.SEC` files follow a predictable XML layout, so a fast, pure-JavaScript XML reader is enough. |
| PDF text layer | **unpdf** (primary) + **pdfjs-dist** (fallback) | Pulls the selectable text out of a PDF; falls back to the lower-level `pdfjs-dist` for malformed files. The extracted text feeds the same structure-inference path (ADR-034). |
| PDF OCR | **tesseract.js** + **@napi-rs/canvas** | For scanned PDFs with no selectable text, renders each page to an image (@napi-rs/canvas) and reads it with optical character recognition (tesseract.js). Runs fully offline when language data is provisioned locally (the documented production setup) and won't hang (ADR-039). |
| MCP server | **@modelcontextprotocol/sdk** | Lets an AI assistant use SpecR directly (searching paragraphs, reading specs, reviewing diffs) over the Model Context Protocol (ADR-010). |
| Logging | **pino** | Fast structured (JSON) logging with very little overhead. |
| HTTP upload | **multer** | Handles DOCX/SEC file uploads from web forms (multipart requests). |

### Why not Python

docx-parser-converter and Docling are better *parsers* than anything in the TS ecosystem. But dolanmiu/docx has no Python equivalent for *generation* with full numbering control. python-docx has no high-level list API: you escape to raw XML for anything beyond basic lists. Office Add-in development (Phase 4+) requires JavaScript/TypeScript regardless. One language wins.

### Why not Java

docx4j's `PropertyResolver` is the gold-standard ECMA-376 style resolver. But the JVM is a heavy runtime for a headless API, Java has no path into Office Add-in client code (add-ins run JavaScript/TypeScript in a webview), and the ecosystem investment is wrong for a TypeScript/Node-first architecture. The algorithms we need (Clippit's `ListItemRetriever`, docx4j's style cascade) are portable: we port them, not the runtime.

### Why not C#

Clippit is the only open-source library that builds the actual parent/child paragraph tree. We will port its `ListItemRetriever` algorithm to TypeScript. Running a .NET service alongside Node adds operational complexity with no benefit once the algorithm is ported.

## Key Dependencies

Versions live in `package.json` / `pnpm-lock.yaml`. The lockfile is the authority. What each key dependency is for:

- `express` (v5): HTTP server
- `zod` (v4): all external-input validation (request bodies, env, parsed XML/OOXML); note v4 idioms like `z.uuid()`
- `docx` (dolanmiu): DOCX generation
- `jszip` / `yauzl`: OOXML zip reading and archive safety checks
- `fast-xml-parser`: `.SEC` (SpecsIntact XML) and OOXML parsing
- `pg` + `node-pg-migrate`: PostgreSQL driver + reversible TypeScript migrations
- `pino`: structured logging
- `multer`: multipart upload handling
- `uuid`: content-control anchor and entity ids
- `piscina`: worker-thread pool for CPU-bound parsing
- `express-rate-limit`: rate limiting on public endpoints
- `@modelcontextprotocol/sdk`: MCP server (Streamable HTTP)
- `chardet` + `iconv-lite`: encoding detection / decoding
- Dev: `typescript`, `vitest` (+ `@vitest/coverage-v8`), `eslint` 9 flat config with `typescript-eslint` + `eslint-plugin-sonarjs` + `eslint-config-prettier`, `prettier`, `tsx` (dev server), `@redocly/cli` (OpenAPI lint), `depcheck`

## Reference Materials

### Specifications Analyzed
- `docs/references/UFGS/`: 666 .SEC files (SpecsIntact XML), 31 divisions, public domain
- ARCAT: 23 DOCX files (machine-generated, cleanest). See `docs/references/ARCAT/README.md`.
- Chatsworth Products Inc. (CPI): 6 DOCX files (telecom equipment manufacturer specs implementing CSI MasterFormat). See `docs/references/MANUFACTURER_CPI/README.md`.

### Key Libraries
- dolanmiu/docx (TS, MIT): DOCX generation
- Clippit (C#, MIT): Reference implementation for `ListItemRetriever`, hierarchy inference algorithm to port
- docx4j (Java, Apache 2.0): Reference for ECMA-376 style cascade resolution
- officeParser (TS, MIT): Reference for partial OOXML parsing approach

### OOXML Specifications
- ECMA-376 5th edition: https://ecma-international.org/publications-and-standards/standards/ecma-376/
- Style hierarchy (§17.7.2): https://ooxml.info/docs/17/17.7/17.7.2/

### Full Research
- `docs/research-executive-summary.md`: complete landscape analysis, OOXML deep dive, format comparisons, open questions, risks
