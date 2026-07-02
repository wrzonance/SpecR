// src/mcp/contract-map.ts
// Parity contract between openapi.yaml operations and MCP tools (mirror of ADR-026's
// route↔spec coverage). OperationId format matches specOperationManifest: "method /path"
// with every path param collapsed to "{}". See docs/adr/044-mcp-contract-testing.md.

// An OperationId is a plain string in the format "method /path" (e.g. "post /projects"),
// every path param collapsed to "{}" — matching specOperationManifest's output.

/** User-facing REST operation → the MCP tool that performs it. */
export const OP_TO_TOOL: ReadonlyMap<string, string> = new Map([
  ['get /projects', 'list_projects'],
  ['get /specs/{}', 'get_spec'],
  ['get /specs/{}/lineage', 'get_spec_lineage'],
  ['post /specs/{}/diff', 'get_spec_diff'],
  ['post /specs/{}/generate', 'generate_docx'],
  ['post /parse', 'parse_document'],
  ['get /projects/{}/coordination-report', 'coordination_report'],
  ['post /projects/{}/submittal-register', 'submittal_register'],
  ['get /specs/{}/open-comments', 'open_comments_report'],
  ['get /projects/{}/open-comments', 'open_comments_report'],
  ['post /specs/{}/reclassify', 'reclassify_spec'],
  ['patch /specs/{}/paragraphs/{}/editability', 'set_editability_override'],
  ['post /projects', 'create_project'], // added in Task 7
  ['get /libraries', 'list_libraries'], // discover sourceLibraryIds that create_project needs
  // wave 2 — project lifecycle
  ['get /projects/{}', 'get_project'],
  ['patch /projects/{}', 'update_project'],
  ['delete /projects/{}', 'delete_project'], // destructive tier (gated off by default)
  ['post /projects/{}/restore', 'restore_project'],
  // …extend during each write-tool wave.
]);

/**
 * REST ops intentionally NOT exposed as MCP tools. Each needs a reason. This is the
 * burn-down list: `pending — wave N` entries become OP_TO_TOOL entries as each write-tool
 * wave lands (Roadmap in the plan); permanent entries stay (egress, async polling, reads
 * an MCP-native tool already serves). The four INV-1/2/3 + disjointness tests keep this map
 * honest — a new REST route with no tool and no entry here fails CI.
 */
export const MCP_UNEXPOSED: ReadonlyMap<string, string> = new Map([
  // --- Wave 2 remaining: packages / revisions / spec assignment ---
  ['post /projects/{}/specs', 'pending — wave 2 (assign specs to project)'],
  ['delete /projects/{}/specs/{}', 'pending — wave 2 (unassign project spec)'],
  ['put /projects/{}/sources', 'pending — wave 2 (project source libraries)'],
  ['get /projects/{}/packages', 'pending — wave 2 (list packages)'],
  ['post /projects/{}/packages', 'pending — wave 2 (create_package)'],
  ['delete /packages/{}', 'pending — wave 2 (delete package, destructive)'],
  ['put /packages/{}/specs', 'pending — wave 2 (assign_specs_to_package)'],
  ['post /packages/{}/revisions', 'pending — wave 2 (issue package revision)'],
  ['get /revisions/{}', 'pending — wave 2 (read issued revision)'],
  // --- Wave 3 (#44): paragraphs, associations, comment resolution ---
  ['patch /specs/{}/paragraphs/{}', 'pending — wave 3 (update_paragraph)'],
  ['patch /specs/{}/paragraphs/{}/removal', 'pending — wave 3 (remove_paragraph)'],
  ['get /specs/{}/paragraphs/{}/associations', 'pending — wave 3 (list paragraph associations)'],
  ['post /specs/{}/paragraphs/{}/associations', 'pending — wave 3 (add paragraph association)'],
  [
    'delete /specs/{}/paragraphs/{}/associations/{}',
    'pending — wave 3 (remove paragraph association)',
  ],
  [
    'post /specs/{}/paragraphs/{}/comments/{}/accept-as-note',
    'pending — wave 3 (accept comment as note)',
  ],
  // --- Wave 4: spec lifecycle ---
  ['patch /specs/{}', 'pending — wave 4 (update spec metadata)'],
  ['post /specs/{}/finalize', 'pending — wave 4 (finalize_spec)'],
  ['post /specs/{}/reopen', 'pending — wave 4 (reopen_spec)'],
  ['post /specs/{}/restore', 'pending — wave 4 (restore_spec)'],
  ['delete /specs/{}', 'pending — wave 4 (delete_spec, destructive)'],
  // --- Wave 5: merge ---
  ['post /specs/{}/merge', 'pending — wave 5 (apply_merge)'],
  // --- Wave 6: assignment (numbering profile / style source / lock) ---
  ['put /specs/{}/numbering-profile', 'pending — wave 6 (assign_numbering_profile)'],
  ['delete /specs/{}/numbering-profile', 'pending — wave 6 (clear numbering-profile assignment)'],
  ['post /specs/{}/style-source', 'pending — wave 6 (assign_style_source)'],
  ['delete /specs/{}/style-source', 'pending — wave 6 (clear style-source assignment)'],
  ['get /specs/{}/lock', 'pending — wave 6 (read spec lock)'],
  ['put /specs/{}/lock', 'pending — wave 6 (lock_spec)'],
  ['delete /specs/{}/lock', 'pending — wave 6 (unlock_spec)'],
  // --- Wave 7: config CRUD (templates / conventions / required-sections /
  //     revision-nomenclature / numbering-profile management / libraries / general-spec) ---
  ['get /templates', 'pending — wave 7 (list templates)'],
  ['get /templates/{}', 'pending — wave 7 (read template)'],
  ['post /templates', 'pending — wave 7 (create template)'],
  ['patch /templates/{}', 'pending — wave 7 (update template)'],
  ['delete /templates/{}', 'pending — wave 7 (delete template, destructive)'],
  ['post /templates/{}/rules', 'pending — wave 7 (add template rule)'],
  ['post /templates/import', 'pending — wave 7 (import template)'],
  ['get /conventions', 'pending — wave 7 (list conventions)'],
  ['get /libraries/{}/conventions', 'pending — wave 7 (read library conventions)'],
  ['put /libraries/{}/conventions', 'pending — wave 7 (set library conventions)'],
  ['post /libraries/{}/conventions/clone', 'pending — wave 7 (clone conventions)'],
  ['get /projects/{}/required-sections', 'pending — wave 7 (read required-sections)'],
  ['put /projects/{}/required-sections', 'pending — wave 7 (set required-sections)'],
  [
    'get /projects/{}/packages/{}/required-sections',
    'pending — wave 7 (read package required-sections)',
  ],
  [
    'put /projects/{}/packages/{}/required-sections',
    'pending — wave 7 (set package required-sections)',
  ],
  ['get /revision-nomenclature-profiles', 'pending — wave 7 (list revision-nomenclature profiles)'],
  ['get /projects/{}/revision-nomenclature', 'pending — wave 7 (read revision-nomenclature)'],
  ['put /projects/{}/revision-nomenclature', 'pending — wave 7 (set revision-nomenclature)'],
  [
    'delete /projects/{}/revision-nomenclature',
    'pending — wave 7 (clear revision-nomenclature override)',
  ],
  [
    'post /projects/{}/revision-nomenclature/clone',
    'pending — wave 7 (clone revision-nomenclature)',
  ],
  ['get /numbering-profiles/{}', 'pending — wave 7 (read numbering profile)'],
  ['patch /numbering-profiles/{}', 'pending — wave 7 (update numbering profile)'],
  ['delete /numbering-profiles/{}', 'pending — wave 7 (delete numbering profile, destructive)'],
  ['post /numbering-profiles/snapshot', 'pending — wave 7 (snapshot numbering profile)'],
  ['get /libraries/{}/numbering-profiles', 'pending — wave 7 (list library numbering profiles)'],
  ['post /libraries/{}/numbering-profiles', 'pending — wave 7 (create library numbering profile)'],
  ['patch /libraries/{}', 'pending — wave 7 (update library)'],
  ['get /libraries/{}/specs', 'pending — wave 7 (list library specs)'],
  ['post /libraries/clients', 'pending — wave 7 (create client library)'],
  ['post /libraries/{}/import', 'pending — wave 7 (import specs into library)'],
  ['get /libraries/{}/divisions/{}/general-spec', 'pending — wave 7 (read library general-spec)'],
  ['put /libraries/{}/divisions/{}/general-spec', 'pending — wave 7 (set library general-spec)'],
  ['get /projects/{}/divisions/{}/general-spec', 'pending — wave 7 (read project general-spec)'],
  ['put /projects/{}/divisions/{}/general-spec', 'pending — wave 7 (set project general-spec)'],
  // --- Permanent exemptions: async job polling, batch DOCX egress, and reference reads
  //     an MCP-native tool already serves. No tool planned. ---
  ['get /parse/jobs/{}', 'async parse-job polling — parse_document runs synchronously as a tool'],
  [
    'get /libraries/import/jobs/{}',
    'async import-job polling — bulk import runs inline via load_files',
  ],
  [
    'post /projects/{}/generate',
    'batch manual DOCX egress — generate_docx covers single-spec render',
  ],
  [
    'post /revisions/{}/generate',
    'issued-revision DOCX egress — generate_docx covers single-spec render',
  ],
  ['get /projects/{}/references/broken', 'broken-reference read — surfaced by coordination_report'],
  [
    'get /projects/{}/references/inbound',
    'inbound-reference read — covered by get_references (MCP-native)',
  ],
  [
    'get /projects/{}/specs/{}/references',
    'outbound-reference read — covered by get_references (MCP-native)',
  ],
]);

/** Tools with no single REST equivalent — allowed to map to nothing (INV-2). */
export const MCP_NATIVE: ReadonlySet<string> = new Set([
  'search_library', // no /search route; MCP-native affordance
  'load_files', // bulk file loader (CLI-style), no REST equivalent
  'list_sections', // CSI section index with inDatabase flag
  'get_paragraph', // single paragraph + ancestor chain, no dedicated REST route
  'get_references', // reads inbound+outbound in one call (REST splits these across routes)
  'get_numbering_profile', // effective resolved profile
  'get_onboarding_report',
  'review_editability',
  'clear_editability_override',
]);
