# ADR-001: TypeScript/Node.js Over Python or Java

## Status: Accepted

## Context

SpecR requires:
1. Parsing DOCX files using OOXML inference algorithms
2. Generating DOCX files with precise multilevel numbering control
3. A REST API runtime
4. Future: an Office Add-in for Microsoft Word (Word JS API)

Three languages had meaningful ecosystem support for at least one of these requirements: Python, Java, and TypeScript.

**Python** has the best DOCX parsers: docx-parser-converter (3-phase style resolution), Docling (59K stars, hierarchical tree output), and docxtpl/docxcompose for assembly. But python-docx has no high-level list API — anything beyond basic lists requires escaping to raw XML manipulation. No Python DOCX library supports the multilevel numbering generation we need.

**Java** has docx4j with `PropertyResolver` — the gold-standard ECMA-376 style resolver, and the only open-source implementation that correctly handles the full 6-layer cascade. But the JVM is a heavy runtime for a headless API. Java has no path to Office Add-in development. The algorithm we need from docx4j is portable.

**TypeScript** has dolanmiu/docx — MIT, 5700 stars, 8M downloads/week, full multilevel numbering control, content controls, and a write-only model that is intentional for our use case. No TS library resolves OOXML style inheritance (we must build this), but the algorithms exist in Clippit (C#) and docx4j (Java) and can be ported.

## Decision

TypeScript/Node.js.

- **Generation:** dolanmiu/docx is the only library with the numbering control we need, and it is TypeScript-native.
- **Parsing:** We implement the inference engine ourselves, porting Clippit's `ListItemRetriever` algorithm from C# and docx4j's style cascade from Java. The algorithms are the hard part, not the language.
- **Future Office Add-in:** Word JS API requires TypeScript. Writing the server in Python or Java would mean maintaining two languages when the client-side Word integration is eventually built.
- **Single language:** No IPC boundary between server and any future Office Add-in component. Shared type definitions for the AST.

## Consequences

- We must implement OOXML style resolution ourselves. No library does this in TypeScript. Estimated 2–3 weeks of inference engine work (Weeks 3–5 of Phase 1).
- The TypeScript DOCX parsing ecosystem is thin. We will rely heavily on JSZip for raw OOXML access, which is lower-level than docx4j but sufficient.
- Python's parsing advantages (Docling, docx-parser-converter) are permanently foregone. If a parsing edge case proves unsolvable in TypeScript, wrapping a Python sidecar is an escape hatch — but not the plan.
