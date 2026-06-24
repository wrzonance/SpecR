# ADR-033: Semantic article-role tagging

## Status

Accepted

## Context

The canonical CSI AST (ADR-003) is semantic-light: every PART child is a generic
`article` node (`src/ast/types.ts` — 12 node types, none role-typed). There is no
deterministic way to ask "which article is *Related Sections*? *References*?
*Submittals*?". Wishlist items decomposed from #256 are blocked on this: A2/A3
(Related Sections ↔ body), B2 (References ↔ body), and D (the submittal register).
This is the single most reusable foundation, so it lands first (keystone / Task-0).

CSI article headings are written to a strong convention ("RELATED SECTIONS",
"REFERENCES", "SUBMITTALS", "SUMMARY", "QUALITY ASSURANCE", …), but with three
sources of variance: (1) a leading CSI numbering prefix that may or may not have
been stripped by the parser ("1.1 REFERENCES" vs "REFERENCES"); (2) common title
variants ("Related Requirements" for Related Sections, "Reference Standards" for
References); (3) casing/whitespace noise. A handful of headings are genuinely
ambiguous and must not be force-classified.

## Decision

1. **Role is a pure derived field, not stored state.** `articleRole` is a
   deterministic function of the article's heading text. No DB column, no
   migration — it is shaped on read exactly like `meta.editability` and
   `meta.conflicts` are. The single source of truth is one pure deriver,
   `deriveArticleRole(text)`, in `src/ast/article-role.ts` (the foundational
   layer both `parser/` and `db/` already import from).

2. **Two application chokepoints, one function.** The deriver is applied (a) as a
   post-parse tree transform in `parser/index.ts` so freshly-parsed trees carry
   the role, and (b) in `db/queries/specs.ts buildNodeTree` so DB-reconstructed
   trees — the path `get_spec` and `GET /specs/:id/tree` use — carry it. Same
   pure function, two call sites; no drift possible.

3. **Surfaced as optional `meta.articleRole`.** Added to `SpecNodeMeta` without
   touching any existing field. A closed enum of recognized roles. Surfaces
   automatically through `get_spec` / `GET /specs/:id/tree` because both serialize
   the `SpecTree` directly; the optional field is documented in the `SpecNode`
   schema in `openapi.yaml`.

4. **Unknowns are absent, never wrong.** An article whose heading matches no rule
   carries NO `articleRole` (the key is omitted). We never guess. Genuinely
   ambiguous headings are recorded as `// KNOWN AMBIGUITY:` test cases (per the
   OOXML ambiguity rule) rather than silently resolved.

5. **Tolerant matching.** The deriver strips an optional leading CSI numbering
   prefix, uppercases, and collapses whitespace before matching a data table of
   role rules (canonical title + variants). This makes it robust whether or not a
   given parser stripped the prefix, and ilvl-agnostic — the 5-signal engine
   already normalizes the CPI ilvl offset into `node_type='article'` before the
   deriver runs, so CPI and ARCAT articles classify identically.

6. **Only `article` nodes are classified.** `note` and `continuation` nodes are
   never assigned a role: `tagArticleRoles` matches strictly on
   `node.type === 'article'`. A `note` whose text happens to read "REFERENCES"
   stays a `note` with no role. Role is orthogonal to the editorial-visibility
   axis (`vanish`/`note`).

## Consequences

- Downstream coordination checks (#256 A2/A3/B2) and the submittal register (D)
  can locate the Related Sections / References / Submittals article
  deterministically, with no heuristics of their own.
- Zero migration and zero new persisted state: re-deriving on every read is
  negligible (a few regex tests per article) and guarantees the role always
  reflects the current heading text — editing a heading re-classifies for free.
- The role vocabulary is a closed enum; adding a role is a one-line table + enum
  change plus a test, never a schema migration.
- Rejected alternative — a persisted `paragraphs.article_role` column: it would
  add a migration, a write path, and a staleness risk (a heading edit would leave
  the column wrong until re-written) for no benefit, since derivation is cheap and
  deterministic.
- Rejected alternative — a dedicated `role` node-type sibling to `article`: it
  would fork every existing `article` consumer (generator, markdown, merge) and
  conflate structure with semantics. `meta.articleRole` is additive and ignorable.
