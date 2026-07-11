# ADR-062: Full-text retrieval is in-core and deterministic; embeddings deferred

**Status:** Accepted

## Context

SpecR is a headless API. Almost every downstream task — an SPA, an LLM/agent workflow
over MCP, a reporting integration — begins with "find the relevant paragraphs." Until
now the only deterministic retrieval was `searchParagraphs`, an `ILIKE '%q%'` substring
scan (`src/db/queries/search.ts`): no ranking, no stemming, no snippets, and poor recall
for natural-language queries ("firestopping at conduit penetrations" would miss a
paragraph that said "firestop the conduit penetration"). Retrieval quality caps the
quality of everything built on top of it, so the deterministic layer should own it.

Two broad families could improve retrieval:

1. **Lexical full-text search (FTS)** — PostgreSQL's built-in `tsvector`/`tsquery` with
   stemming, stop-word handling, ranking (`ts_rank`/`ts_rank_cd`), and highlighted
   snippets (`ts_headline`). In-database, deterministic, no new runtime dependency, no
   model, no network egress of spec content.

2. **Semantic similarity (embeddings)** — encode paragraphs and queries as vectors
   (e.g. pgvector + an embedding model) and rank by cosine distance. Higher recall on
   paraphrase, but it introduces a model dependency, a re-embedding pipeline, cost, and
   a non-deterministic ranking that is hard to regression-test — and it would send spec
   content to an embedding provider unless self-hosted.

## Decision

**Full-text search is the in-core retrieval mechanism. Semantic similarity is explicitly
out of core for now** and, if adopted, gets its own ADR (weighing pgvector, a
self-hosted vs. hosted embedder, the re-embedding trigger, and the determinism/cost
trade-off) rather than arriving implicitly.

Concretely:

- A **STORED generated** `tsvector` column `paragraphs.search_vector`
  (`to_tsvector('english', coalesce(text, ''))`) plus a **GIN index** (migration 042).
  Generated + STORED keeps the vector consistent with `text` with no trigger and no
  application write path — the column cannot drift.
- `searchParagraphs` ranks with **`websearch_to_tsquery('english', q)`** (accepts
  user-grade query syntax: quoted phrases, `or`, `-negation`) and **`ts_rank_cd`**
  (cover-density, proximity-aware) so a tight cluster of the query terms outranks the
  same terms scattered across a long paragraph — the "exact-phrase beats scattered
  terms" behavior the API promises. Highlighted context comes from `ts_headline`.
- **Degenerate queries** (all stop-words, punctuation only → an empty `tsquery`) fall
  back to a single `ILIKE` substring branch so the caller still gets substring recall
  instead of a silent empty result. A blank/whitespace query returns `[]`.
- **Search does not filter `meta.vanish`.** Retrieval surfaces all stored content;
  suppression of hidden content is a *render*-layer concern (the markdown renderer), not
  a retrieval one. Filtering it here would silently drop recall and diverge the API from
  what is actually stored.
- **English configuration only.** The corpus (CSI MasterFormat, UFGS) is English. A
  future multilingual need is a separate decision, not a reason to parameterize now.

## Consequences

- Retrieval is deterministic and regression-testable: ranking is a pure function of the
  stored text and the query, so a fixture can assert "tight cluster ranks first" without
  a model in the loop.
- No new runtime dependency, no model, no spec-content egress. The GIN index cost is
  paid at write time (generated column) and storage; read is index-backed.
- `GET /search` (REST) and MCP `search_library` share this one query path, so they
  return identical rows for identical inputs (ADR-044 REST↔MCP parity).
- Paraphrase/synonym recall beyond stemming is a known ceiling. When it matters, the
  embeddings ADR revisits it — this decision deliberately does not close that door, it
  defers it.
- Because the tsvector is generated, no backfill or reparse is needed; existing rows gain
  a populated `search_vector` the moment the migration runs.
