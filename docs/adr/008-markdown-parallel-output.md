# ADR-008: Markdown as Future Parallel Output — AST Must Support It From Day One

## Status: Accepted (deferred implementation)

## Context

The canonical CSI AST is format-agnostic by design (ADR-003). The MVP outputs only DOCX. Two future use cases motivate Markdown as a parallel output format:

1. **Git-native text diffing:** DOCX diffs are binary-unfriendly. Storing specs as Markdown alongside the database would enable `git diff` across spec versions — a workflow familiar to developers and increasingly relevant for infrastructure-as-code adjacent work.

2. **AI-friendly document processing:** LLMs process Markdown significantly better than DOCX. Markdown output would enable AI-assisted paragraph suggestion, compliance checking, and specification review without OOXML parsing overhead.

The risk is that designing the AST for DOCX output now and adding Markdown later requires refactoring the AST — which would break the generator, merge engine, and database schema simultaneously.

## Decision

Markdown output is **not implemented in MVP** (Phase 1–3). It is a Phase 6 feature.

However, the canonical CSI AST must be designed to support Markdown rendering without modification:
- `text` fields store plain text — no OOXML encoding, no numbering prefixes (numbering is structural, not content)
- `NodeType` maps cleanly to Markdown hierarchy: `part` → `# PART 1`, `article` → `## 1.1`, `pr1` → `**A.**`, etc.
- `meta.vanish` notes map to Markdown blockquotes or admonitions
- No OOXML-specific fields in `CsiNode`

The generator module is designed as a renderer: `render(tree: CsiTree, format: 'docx' | 'json'): Buffer | object`. Adding `'markdown'` as a third format option must not require changes to `CsiTree` or `CsiNode` types.

## Consequences

- The AST type definitions must not reference OOXML concepts. If a field is needed for DOCX generation only (e.g., raw `numId` preservation for a specific round-trip edge case), it belongs in `meta` with a clear DOCX-specific key — not as a top-level field.
- When implementing the DOCX generator, any temptation to store OOXML-specific formatting in AST fields must be resisted. Formatting belongs in the output template, not the AST.
- The `'markdown'` format option placeholder in the renderer type signature can be added as a `// Phase 6` comment stub to make the intent visible without implementing it.
