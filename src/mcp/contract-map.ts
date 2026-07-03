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
  // wave 3 — paragraphs, associations, comment resolution
  ['patch /specs/{}/paragraphs/{}', 'update_paragraph'],
  ['patch /specs/{}/paragraphs/{}/removal', 'remove_paragraph'],
  ['get /specs/{}/paragraphs/{}/associations', 'list_associations'],
  ['post /specs/{}/paragraphs/{}/associations', 'create_association'],
  ['delete /specs/{}/paragraphs/{}/associations/{}', 'delete_association'], // destructive tier
  ['post /specs/{}/paragraphs/{}/comments/{}/accept-as-note', 'accept_comment_as_note'],
  // wave 4 — spec lifecycle
  ['patch /specs/{}', 'update_spec'],
  ['post /specs/{}/finalize', 'finalize_spec'],
  ['post /specs/{}/reopen', 'reopen_spec'],
  ['post /specs/{}/restore', 'restore_spec'],
  ['delete /specs/{}', 'delete_spec'], // destructive tier — soft withdraw (ADR-030)
  // wave 5 — merge
  ['post /specs/{}/merge', 'apply_merge'],
  // wave 6 — assignment (numbering profile / style source / lock)
  ['put /specs/{}/numbering-profile', 'assign_numbering_profile'],
  ['delete /specs/{}/numbering-profile', 'clear_numbering_profile'],
  ['post /specs/{}/style-source', 'assign_style_source'],
  ['delete /specs/{}/style-source', 'clear_style_source'],
  ['get /specs/{}/lock', 'get_spec_lock'],
  ['put /specs/{}/lock', 'lock_spec'],
  ['delete /specs/{}/lock', 'unlock_spec'],
  // wave 7a — style-template config CRUD
  ['get /templates', 'list_templates'],
  ['get /templates/{}', 'get_template'],
  ['post /templates', 'create_template'],
  ['patch /templates/{}', 'update_template'],
  ['delete /templates/{}', 'delete_template'], // destructive tier
  ['post /templates/{}/rules', 'upsert_template_rules'],
  ['post /templates/import', 'import_template'],
  // wave 7b — editing-convention config CRUD
  ['get /conventions', 'list_conventions'],
  ['get /libraries/{}/conventions', 'get_library_conventions'],
  ['put /libraries/{}/conventions', 'set_library_conventions'],
  ['post /libraries/{}/conventions/clone', 'clone_conventions'],
  // wave 7c — required-sections config (project + package scope)
  ['get /projects/{}/required-sections', 'get_required_sections'],
  ['put /projects/{}/required-sections', 'set_required_sections'],
  ['get /projects/{}/packages/{}/required-sections', 'get_package_required_sections'],
  ['put /projects/{}/packages/{}/required-sections', 'set_package_required_sections'],
  // wave 7d — revision-nomenclature config (project scope)
  ['get /revision-nomenclature-profiles', 'list_revision_nomenclature_profiles'],
  ['get /projects/{}/revision-nomenclature', 'get_project_revision_nomenclature'],
  ['put /projects/{}/revision-nomenclature', 'set_project_revision_nomenclature'],
  ['post /projects/{}/revision-nomenclature/clone', 'clone_project_revision_nomenclature'],
  ['delete /projects/{}/revision-nomenclature', 'clear_project_revision_nomenclature'],
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
  // --- Wave 7 remaining: config CRUD (conventions / required-sections /
  //     revision-nomenclature / numbering-profile management / libraries / general-spec) ---
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
