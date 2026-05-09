# ADR-011: Git-Native Spec Versioning as Optional Organizational Sync Layer

## Status: Accepted (deferred implementation — Phase 6)

## Context

SpecR's 3-way merge engine (ADR-005) already tracks `base_version` per paragraph and snapshots text in `paragraph_versions`. The canonical CSI AST stores plain text with no OOXML encoding (ADR-003), making every spec fully text-serializable. Markdown output is planned as a parallel renderer (ADR-008).

Construction specification libraries are organizational IP — master paragraphs built and refined over years. Firms need:

1. **Version history** — who changed what paragraph, when, and why
2. **Branching** — master firm library vs. client-specific variants vs. per-project overrides (ADR-006 tier model)
3. **Review workflow** — Owner redlines reviewed before acceptance; same workflow as a PR
4. **Audit trail** — liability-driven; spec writers must demonstrate what was in a spec at contract time
5. **Ownership** — firm's IP should live in their infrastructure, not solely in a SaaS vendor's database

PostgreSQL serves queries well but is not a natural collaboration surface. DOCX is a binary — `git diff` on a `.docx` file is meaningless. The canonical AST, once serialized to Markdown or JSON, is line-oriented text that git was designed for.

SpecR is already implementing the semantics of git (3-way merge, base versions, conflict detection) inside the database. Git itself could provide these semantics for the serialized form at no implementation cost, plus give organizations GitHub's collaboration infrastructure for free.

Two architectural questions arise:
- Should git *replace* the database as the source of truth?
- Should git be a downstream sync target only?

Replacing the database is not viable: the DB serves real-time API queries, cross-reference resolution, paragraph search, and relational joins across spec sections. Git is not a query engine. Abandoning the DB would require reimplementing all of that against git objects.

## Decision

**PostgreSQL remains the primary source of truth.** All reads and writes go through the SpecR API against the database. Git is a downstream sync layer — SpecR pushes to it, never reads from it for live queries.

Git sync is an optional organizational feature enabled per-org by providing a GitHub/GitLab repository and credentials. When enabled:

### Sync triggers

- **On merge accepted** (`POST /specs/:id/merge`): SpecR serializes the updated spec to Markdown and commits to the connected repo on the appropriate branch.
- **On TOC change** (`project_specs`): SpecR updates an index file (`toc.md` or `toc.json`) and commits.
- **On bulk import** (load-ufgs or future loaders): SpecR commits the seeded specs to the repo's seed branch.

### Branch structure

```
main                    ← current approved firm library (promoted explicitly)
firm/                   ← firm master library branches (per division or full)
project/<id>            ← per-project overrides, branched from firm/
seed/ufgs               ← UFGS public domain corpus (read-only reference)
```

This mirrors the four-tier hierarchy in ADR-006 as git branches, making the inheritance relationship inspectable and diffable.

### Serialization format

Markdown is the primary format (human-readable, LLM-friendly, git-diff-friendly). JSON is the secondary format (lossless, machine-readable, enables restore-from-git if the database is lost). Both formats are derived from the same AST renderer — adding JSON is a second format option on the existing renderer, not a separate pipeline.

### Reverse sync (advanced workflow)

An Owner can edit spec Markdown directly in a GitHub PR. SpecR detects the PR via webhook, parses the Markdown diff, and imports it as a pending diff against the spec — identical to the DOCX round-trip merge workflow (ADR-005). The spec writer accepts or rejects via `POST /specs/:id/merge`. This makes the Owner redline workflow possible entirely within GitHub, with no DOCX required.

This is an opt-in advanced workflow, not the default. The DOCX round-trip (ADR-004/005) remains the primary review mechanism.

## Consequences

- **Markdown output is a prerequisite.** ADR-008 deferred Markdown to Phase 6; ADR-010 (MCP) already pulled it forward to Phase 2. Git sync further validates that decision — Markdown must exist before git sync can ship.
- **No git dependency in Phase 0–5.** Git sync is Phase 6. No git client library enters the dependency graph before then. The DB schema and AST design must not be designed *around* git, but they already support it because the AST is plain text.
- **Org credentials are org-owned.** SpecR never holds a GitHub token with write access beyond the org's designated repo. The token is stored encrypted per-org, not shared.
- **DB is always recoverable from git.** The JSON serialization is lossless — if the database is lost, all spec content can be restored by importing from the git repo. This is a disaster recovery property, not a normal operational path.
- **`paragraph_versions` table becomes partially redundant** for orgs using git sync — git history is a richer audit trail than version integers. The DB version tracking still serves real-time merge operations; git history serves audit and recovery. Both coexist.
- **GitHub Actions hooks become possible.** An org's private spec repo can run CI against committed Markdown: cross-reference integrity checks, completeness validation, CSI section number verification — all using SpecR's own validation logic invoked against the serialized form.
