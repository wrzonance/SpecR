# SpecR — Architecture Specification

> A headless REST API that treats CSI MasterFormat construction specification documents as structured data, not opaque Word files.

This file is the **index**. The detailed design lives in focused documents under [`docs/architecture/`](docs/architecture/) so agents and readers load only the topic they need. See the [Detailed design](#detailed-design) directory below.

## Vision

AEC design projects have always had a "document control problem" and multiple silos of information that can be the same thing in two places.

The idea behind SpecR is that not only should it serve as a way of manipulating construction specifications programmatically, but it should also have Revit models be a source of truth into generating those same specifications.

And oftentimes reviewers mark up those specifications, and writers manually reconcile changes back into their project or company standard files.

SpecR seeks to eliminate this by parsing specification documents into a structured database, generating them parametrically, and tracking changes through a git-style merge engine.

The target: a spec writer who connects a Revit model, sees their Part 2 (Products) sections auto-populate from equipment families, exports a clean DOCX, receives a redlined version from the client, and merges accepted changes back into the database, all without manual transcription.

## Problem Statement

Few open-source tools exist for CSI MasterFormat specification automation. Commercial tools (MasterSpec via Deltek Specpoint, RIB SpecLink, e-SPECS) dominate, and while they do offer BIM/Revit integration, it is proprietary and plugin-locked: there is no open, programmable API surface a third party can build on. For everyone outside those ecosystems, Revit models contain the ground truth of what's designed (equipment types, manufacturers, performance parameters), yet that data still has to be manually correlated into the construction specifications.

The technical challenge is not any single feature but the intersection of five requirements:

1. **Company-agnostic parsing:** every firm uses different styles, numbering, and authoring conventions
1. **Round-trip fidelity:** documents leave the system, get manually edited, and must return without data loss
1. **Hierarchy inference:** DOCX stores paragraphs flat; parent/child relationships must be inferred
1. **Full numbering control:** CSI multilevel numbering must be reproduced exactly
1. **All divisions, all firms:** cannot be scoped to one division or one firm's template

## Design Principles

1. **Parse the real world.** Don't assume clean DOCX. Analyze all five signals (numbering XML, style chains, document order, text content, indentation) and combine them. Design for the messiest spec you'll encounter, not the cleanest.
1. **Round-trip is the product.** One-way generation is solvable. Round-trip through manual editing is difficult to coordinate and error prone. SpecR wants to solve that.
1. **API-first.** No UI in the core. Every feature is an API call; any user or firm can build their own client (web-based tool, Revit, Word, whatever).
1. **The AST is the source of truth.** Not the DOCX. Not the XML. The canonical CSI hierarchy becomes an Abstract Syntax Tree (AST) in PostgreSQL: a structured, tree-shaped model of the document's content and hierarchy (parts, articles, paragraphs), independent of any file format.
1. **Public domain first.** UFGS provides 666 spec files across all CSI divisions, hierarchy already explicit, no copyright friction. Seed the database before building the library management layer.
1. **AI-native from the start.** The canonical AST stores plain text, not OOXML encoding. Every design decision that makes the data readable to humans also makes it readable to LLMs. MCP exposure (ADR-010) is a natural consequence of this, not a retrofit.
1. **Git-native versioning (future).** Once specs are serializable to pure text (JSON, Markdown, or SEC-XML), git becomes the natural version control layer: branching for master template, per-client template, and per-project tiers; commits for audit history; PRs for redline review. DOCX is an opaque binary and cannot participate. The canonical AST is the prerequisite: text-serializable AST unlocks direct GitHub/GitLab integration as a first-class feature. See ADR-011.

## Detailed design

Each document below is self-contained. Load the one your task touches rather than this whole file.

| Document | What's inside |
|----------|---------------|
| [system-overview.md](docs/architecture/system-overview.md) | Client-surface + module diagram; parse / generate / round-trip-merge data flows |
| [inference-engine.md](docs/architecture/inference-engine.md) | The 5-signal DOCX hierarchy engine, CSI numbering standard, conflict + confidence provenance |
| [canonical-ast.md](docs/architecture/canonical-ast.md) | The `CsiNode` / `CsiTree` source-of-truth model |
| [api.md](docs/architecture/api.md) | REST surface + `ApiResponse<T>` envelope (`openapi.yaml` is the authoritative contract) |
| [database.md](docs/architecture/database.md) | PostgreSQL schema, Revit parameter mappings, deferred tables |
| [coordination.md](docs/architecture/coordination.md) | Cross-reference model + coordination / errors-&-omissions findings |
| [data-strategy.md](docs/architecture/data-strategy.md) | Deterministic-first (grounded data, not RAG) + document concurrency |
| [roadmap.md](docs/architecture/roadmap.md) | Phased delivery, Phase 0 → Phase 6 |
| [module-boundaries.md](docs/architecture/module-boundaries.md) | Module dependency rules, error-context chains, enforced complexity gates |
| [mcp.md](docs/architecture/mcp.md) | MCP server transport, tool/resource patterns, session store, result anchors |
| [markdown-renderer.md](docs/architecture/markdown-renderer.md) | Pure AST → Markdown renderer + `getLabel` contract |
| [file-structure.md](docs/architecture/file-structure.md) | Repository layout |
| [tech-stack.md](docs/architecture/tech-stack.md) | Stack rationale, key dependencies, reference materials |
