# Data Strategy

> ↩ [Architecture index](../../ARCHITECTURE.md)

## Deterministic-First: Grounded Data, Not RAG

SpecR's analytical outputs: the coordination / E&O report, submittal register, 3-way spec diff, broken and inbound reference sets, and open-comments report are **computed by deterministic endpoints over the structured CSI AST in PostgreSQL**, not produced by retrieving document text and asking a language model to summarize it. `GET /projects/:id/coordination-report` runs recursive-CTE queries and typed finding logic (`src/db/queries/coordination.ts`); `POST /projects/:id/submittal-register` matches products against submittal types; `POST /specs/:id/diff` matches paragraphs by UUID content-control anchor. Same input, same findings, every run.

The MCP contract (ADR-044) surfaces each operation as a tool (`coordination_report`, `submittal_register`, `get_spec_diff`, `get_references`, `open_comments_report`) with a CI gate that fails if a user-facing REST operation has no corresponding tool (or an explicit exemption). An agent therefore does not read spec blobs and infer; it calls a tool and gets computed ground truth.

This is a deliberate division of labor. Producing exact, exhaustive, self-consistent structured facts is what language models are least reliable at; narrating and synthesizing facts is what they are good at. SpecR supplies the facts; the agent composes. And because every paragraph carries a stable UUID (the same anchor the merge engine round-trips through), every finding traces back to a spec and paragraph id, so an agent's claims are citable, not merely plausible.

The contrast is with retrieval-augmented generation over document text, where the output is only as sound as the model's summary of the passages it retrieved. A Stanford RegLab study (Magesh et al., *Journal of Empirical Legal Studies*, 2025) found that even purpose-built, RAG-backed legal-research tools hallucinated on roughly 17–34% of queries. SpecR keeps the model out of the fact-production path.

## Document Concurrency

Writes are guarded so concurrent editors do not clobber each other (ADR-018). Paragraph updates are **optimistic** (version-checked); a spec carries an advisory **lock** (`GET/PUT/DELETE /specs/:id/lock`, acquire/refresh/steal-after-expiry/release); and specs move through a review/active **lifecycle** (`onboarding_status`), with issued package revisions frozen as immutable snapshots. The edit-gate and lock logic live in `src/api/locks.ts`, `src/api/edit-gate-response.ts`, and `src/db/queries/{locks,edit-gate,revisions}.ts`.
