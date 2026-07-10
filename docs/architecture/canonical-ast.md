# Canonical CSI AST

> ↩ [Architecture index](../../ARCHITECTURE.md)

Internal representation shared by all modules. Not OOXML. Renders to: DOCX, JSON, Markdown (Phase 6), HTML.

```typescript
type NodeType =
  | 'spec'        // root
  | 'part'        // PART 1 - GENERAL
  | 'article'     // 1.1 REFERENCES
  | 'pr1'         // A. text
  | 'pr2'         // 1. text
  | 'pr3'         // a. text
  | 'pr4'         // 1) text
  | 'pr5'         // a) text
  | 'pr6'         // deep extension: 1) text
  | 'pr7'         // deep extension: a) text
  | 'note'        // specifier note (hidden in output)
  | 'continuation' // unnumbered continuation paragraph

interface CsiNode {
  id: string           // UUID — stable across round-trips
  type: NodeType
  text: string         // plain text content (numbers stripped)
  children: CsiNode[]
  meta: {
    vanish?: boolean   // specifier note (CMT / ARCATnote / NTE)
    source?: 'ufgs' | 'arcat' | 'cpi' | 'unknown'
    articleRole?: string // derived Article role — 'related-sections' | 'references' | 'submittals' | … (ADR-033, not persisted)
    revitParam?: string // Revit parameter binding (Phase 4)
    baseVersion?: number // for 3-way merge
  }
}

interface CsiTree {
  id: string           // spec ID
  section: string      // CSI section number, e.g. "27 21 00", "26 00 13.10", "01 32 01.00 10"
  title: string
  parts: CsiNode[]     // root-level Part nodes
}
```

> **Runtime types.** The authoritative shapes are `SpecNode` / `SpecNodeMeta` / `SpecTree` in `src/ast/types.ts`. `CsiNode`/`CsiTree` above are the conceptual model; the runtime `SpecNodeMeta` additionally carries `conflicts`, `inference`, `sourceFacts`, `editability`, and `associations`, and types `articleRole` as the shared `ArticleRole` (not a bare `string`).
