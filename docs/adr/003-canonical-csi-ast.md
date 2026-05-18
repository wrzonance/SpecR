# ADR-003: Canonical CSI AST as Internal Representation

## Status: Accepted

## Context

SpecR must support multiple input formats (DOCX from various firms, UFGS .SEC) and multiple output formats (DOCX, JSON, future Markdown). The obvious implementation is format-specific pipelines: a DOCX-in/DOCX-out pipeline, a SEC-in/DOCX-out pipeline, etc.

This breaks down at the merge engine. A 3-way merge between a base DOCX, an edited DOCX, and a database version requires a common representation. Diffing raw OOXML is not viable — the same logical change can have dozens of XML-level representations, and two documents that render identically can have completely different OOXML structures.

An alternative is storing raw OOXML in the database. This preserves every formatting detail but makes the merge engine dependent on OOXML internals, makes BIM parameter injection require OOXML manipulation, and makes Markdown output require OOXML-to-Markdown conversion (which is lossy and complex).

## Decision

A canonical CSI AST (`SpecNode` / `SpecTree`) is the single internal representation. All inputs parse to this AST. All outputs render from this AST. The database stores the AST, not raw OOXML.

The AST is defined in `src/ast/types.ts` and validated by Zod schemas in `src/ast/schemas.ts`. It captures:
- `NodeType`: part, article, pr1–pr5, note, continuation
- `text`: plain text content (numbering stripped — numbering is structural, not content)
- `children`: explicit parent/child relationships (the hierarchy that DOCX doesn't store)
- `meta`: source, vanish flag, Revit parameter binding, base version

Formatting details (fonts, margins, indentation values) are not stored in the AST. They are a concern of the output template, not the content.

## Consequences

- Formatting fidelity is intentionally limited. We reproduce CSI structural formatting (numbering, hierarchy, heading styles) exactly. We do not reproduce every font choice, custom color, or margin variation from the original DOCX. This is a feature, not a bug: it normalizes house-style differences across firms.
- The merge engine operates on AST nodes, not OOXML. This makes conflict detection tractable.
- BIM parameter injection (Phase 4) is AST manipulation: find the node with `revitParam: 'Manufacturer'`, update its `text`. No OOXML surgery required.
- Markdown output (Phase 6) is AST traversal with a different renderer. No OOXML-to-Markdown conversion needed.
- We lose the ability to perfectly round-trip a document's original formatting. If a firm needs their exact custom styles preserved, the output template system (Phase 5) addresses this — the content is always preserved, only the presentation normalizes.
