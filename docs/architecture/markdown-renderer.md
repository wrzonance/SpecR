# Markdown Renderer

> ↩ [Architecture index](../../ARCHITECTURE.md)

`src/generator/markdown.ts` is a pure module (no I/O, no DB), shared between MCP resources and the future DOCX generator.

- `renderMarkdown(tree: CsiTree): string`: full spec as Markdown.
- `getLabel(type: NodeType, index: number, partNumber?: number): string`: the CSI label for any node type (`A.` / `1.` / `a.` / `1)` / `a)`, repeated `1)` / `a)` for PR6/PR7, `PART N -`, `N.N`). Uses base-26 arithmetic for the `pr1` / `pr3` / `pr5` / `pr7` letter tiers so it handles >26 siblings correctly.
- `note` nodes always render as `> **[NOTE]** text` regardless of `meta.vanish`: editorial notes are structural metadata for spec writers, not owner-facing content.
- `meta.vanish` on non-note nodes → returns `''` (suppressed from output).

When the DOCX generator (Phase 2b) needs numbering labels, import `getLabel` from here rather than reimplementing.
