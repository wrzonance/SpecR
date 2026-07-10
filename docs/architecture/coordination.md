# Coordination & Cross-References

> ↩ [Architecture index](../../ARCHITECTURE.md)

## Cross-Reference Awareness

Specs are not isolated documents: they form a web of dependencies within a project. SpecR must model and enforce this.

### Reference types extracted at parse time

| Type | Example | Source in .SEC |
|------|---------|----------------|
| Section | "See Section 09 91 00" | Text regex + `<REF>` blocks |
| Standard | "ASTM C150", "UFC 3-580-01" | `<REF>` / `<RID>` elements |
| Paragraph | "See paragraph 1.1 REFERENCES" | Text regex |

All references land in `spec_references` at parse time. `target_spec_id` is resolved against the library; unresolved refs start with `is_broken = false` (target may not be loaded yet).

### Two operation contexts — different cascade behaviors

**TOC edit (intentional):** Spec manager edits the project table of contents. Removing a section is a deliberate act: no warning prompt. System auto-cascades: `spec_references` rows pointing to the removed section are deleted; surviving paragraphs that referenced it have their `is_broken` flag set to `true`. Re-adding the section restores the resolved `target_spec_id` and clears `is_broken`.

**In-flight paragraph edit:** Granular changes during spec authoring. Broken references are flagged and surfaced via `GET /projects/:id/references/broken`. Spec writer resolves manually. 3-way merge history provides recovery if content was deleted by mistake.

### Revit sync (Phase 4 hook point)

When a Revit model sync pushes new Family Instance data, the system will surface:
- Proposed Part 2 paragraph additions (new equipment → new product paragraphs)
- Candidate new spec sections (new Revit category with no matching spec in TOC)

These appear in the web dashboard as pending additions, not auto-applied. The spec manager approves or rejects. The `spec_references` model supports this: a Revit-sourced paragraph can carry references the same way parsed content does.

## Coordination Report / Errors-&-Omissions

`GET /projects/:id/coordination-report` is a read-only, computed report over a project's TOC, authored intent, and extracted references. It never mutates state; it returns a discriminated union of `Finding` types plus per-type summary counts. Findings are backed by `src/db/queries/coordination.ts` and its helpers (`article-refs.ts`, `umbrella-callouts.ts`, `snippet.ts`) and the `src/coordination/` and `src/submittals/` modules. The finding vocabulary:

| Finding | Meaning | ADR |
|---------|---------|-----|
| `required_not_present` | Section authored as required but absent from the TOC | ADR-028/029 |
| `present_not_required` | Section in the TOC but not in the required baseline | ADR-028/029 |
| `dangling_ref` | Reference to a section not present (carries `sourceParagraphId` + `snippet`) | #269 |
| `related_listed_not_cited` | Listed in a Related Sections article but never cited in the body | #277 |
| `related_cited_not_listed` | Cited in the body but missing from Related Sections | #277 |
| `standard_cited_not_listed` | Standard cited in body but absent from the References article | #277 |
| `umbrella_not_called_out` | Umbrella section (Div 26/27/28) not cross-called by a subordinate | ADR-037 |
| `implied_related_section` | Advisory: a likely related section inferred by title-keyword match | ADR-035 |
| `product_*` / `submittal_type_*` | Product↔submittal-type gaps from the submittal register | ADR-036 |

The **submittal register** (`POST /projects/:id/submittal-register`) is a related, product-driven analysis returning the same-shaped findings for selected specs. Semantic **article-role tagging** (ADR-033) is the substrate several of these findings build on: see [Canonical CSI AST](canonical-ast.md).
