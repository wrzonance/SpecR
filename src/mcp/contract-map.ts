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
  ['get /specs/{}/hierarchy-report', 'get_hierarchy_report'], // WS2 #424 scoring report
  ['get /specs/{}/paragraphs/{}/history', 'get_paragraph_history'],
  ['get /specs/{}/history', 'get_spec_history'],
  ['get /specs/{}/history/diff', 'get_history_diff'],
  ['post /specs/{}/diff', 'get_spec_diff'],
  ['post /specs/{}/generate', 'generate_docx'],
  ['post /parse', 'parse_document'],
  ['get /projects/{}/coordination-report', 'coordination_report'],
  ['get /projects/{}/reference-graph', 'get_reference_graph'], // #447 read model
  ['get /libraries/{}/reference-graph', 'get_reference_graph'],
  ['get /projects/{}/keynotes', 'get_project_keynotes'],
  ['get /projects/{}/revit-links', 'list_revit_links'], // #103 — element<->spec inventory
  ['post /reports/compare', 'compare_specs'],
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
  ['post /specs/{}/paragraphs', 'insert_paragraph'],
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
  // wave 7e — numbering-profile management (library-scoped CRUD + snapshot)
  ['get /libraries/{}/numbering-profiles', 'list_library_numbering_profiles'],
  ['post /libraries/{}/numbering-profiles', 'create_library_numbering_profile'],
  ['get /numbering-profiles/{}', 'get_numbering_profile_by_id'],
  ['patch /numbering-profiles/{}', 'update_numbering_profile'],
  ['delete /numbering-profiles/{}', 'delete_numbering_profile'], // destructive tier
  ['post /numbering-profiles/snapshot', 'snapshot_numbering_profile'],
  // wave 7f — library management (rename / list specs / create client library)
  ['get /libraries/{}/specs', 'list_library_specs'],
  ['patch /libraries/{}', 'rename_library'],
  ['post /libraries/clients', 'create_client_library'],
  // wave 7g — division general-spec (library + project scope, get/set)
  ['get /libraries/{}/divisions/{}/general-spec', 'get_library_general_spec'],
  ['put /libraries/{}/divisions/{}/general-spec', 'set_library_general_spec'],
  ['get /projects/{}/divisions/{}/general-spec', 'get_project_general_spec'],
  ['put /projects/{}/divisions/{}/general-spec', 'set_project_general_spec'],
  // wave 2a — project section membership + sources
  ['post /projects/{}/specs', 'add_project_section'],
  ['delete /projects/{}/specs/{}', 'remove_project_section'], // destructive tier
  ['put /projects/{}/sources', 'set_project_sources'],
  // wave 2b — design packages (list / create / set specs / delete)
  ['get /projects/{}/packages', 'list_packages'],
  ['post /projects/{}/packages', 'create_package'],
  ['put /packages/{}/specs', 'set_package_specs'],
  ['delete /packages/{}', 'delete_package'], // destructive tier
  // wave 2c — package revisions (issue / read) — LAST ops; full REST↔MCP parity reached
  ['get /packages/{}/revisions', 'list_package_revisions'],
  ['post /packages/{}/revisions', 'issue_package_revision'],
  ['get /revisions/{}', 'get_revision'],
  // first-class clients (#391 / ADR-054); project association rides update_project
  ['get /clients', 'list_clients'],
  ['post /clients', 'create_client'],
  ['get /clients/{}', 'get_client'],
  ['patch /clients/{}', 'update_client'],
  // actor identity substrate (#381 / ADR-052 D6)
  ['get /users', 'list_users'],
  ['post /users', 'resolve_user'],
  ['get /users/{}', 'get_user'],
  // ranked full-text search (#445 / ADR-062) — REST twin of the existing tool
  ['get /search', 'search_library'],
  // discipline mapping (#448 / ADR-065) — read catalog, project spec listing, per-library rules
  ['get /disciplines', 'list_disciplines'],
  ['get /projects/{}/specs', 'list_project_specs'],
  ['put /libraries/{}/disciplines', 'set_library_disciplines'],
  ['delete /libraries/{}/disciplines', 'clear_library_disciplines'],
  // standards registry (#446 / ADR-064) — rollup reads + verdict upsert
  ['get /libraries/{}/standards', 'list_library_standards'],
  ['get /projects/{}/standards', 'list_project_standards'],
  ['put /standards/{}/{}', 'record_standard_verification'],
  // wave 7h — header/footer config CRUD + resolve (#476 / ADR-040)
  ['get /libraries/{}/header-footer', 'get_library_header_footer'],
  ['put /libraries/{}/header-footer', 'set_library_header_footer'],
  ['delete /libraries/{}/header-footer', 'clear_library_header_footer'],
  ['get /projects/{}/header-footer', 'get_project_header_footer'],
  ['put /projects/{}/header-footer', 'set_project_header_footer'],
  ['delete /projects/{}/header-footer', 'clear_project_header_footer'],
  ['get /packages/{}/header-footer', 'get_package_header_footer'],
  ['put /packages/{}/header-footer', 'set_package_header_footer'],
  ['delete /packages/{}/header-footer', 'clear_package_header_footer'],
  ['get /revisions/{}/header-footer', 'get_revision_header_footer'],
  ['put /revisions/{}/header-footer', 'set_revision_header_footer'],
  ['delete /revisions/{}/header-footer', 'clear_revision_header_footer'],
  ['get /projects/{}/header-footer/resolved', 'resolve_project_header_footer'],
  ['get /packages/{}/header-footer/resolved', 'resolve_package_header_footer'],
  ['get /revisions/{}/header-footer/resolved', 'resolve_revision_header_footer'],
]);

/**
 * REST ops intentionally NOT exposed as MCP tools. Each needs a reason. This is the
 * burn-down list: `pending — wave N` entries become OP_TO_TOOL entries as each write-tool
 * wave lands (Roadmap in the plan); permanent entries stay (egress, async polling, reads
 * an MCP-native tool already serves). The four INV-1/2/3 + disjointness tests keep this map
 * honest — a new REST route with no tool and no entry here fails CI.
 */
export const MCP_UNEXPOSED: ReadonlyMap<string, string> = new Map([
  // --- Permanent exemptions: async job polling, batch DOCX egress, and reference reads
  //     an MCP-native tool already serves. No tool planned. ---
  ['get /parse/jobs/{}', 'async parse-job polling — parse_document runs synchronously as a tool'],
  [
    'get /libraries/import/jobs/{}',
    'async import-job polling — bulk import runs inline via load_files',
  ],
  [
    'post /libraries/{}/import',
    'async single-master onboarding — returns a 202 job polled via the exempt ' +
      '/libraries/import/jobs/{} route; MCP tools are synchronous with no job channel. ' +
      'Agents ingest documents via load_files (MCP-native, inline).',
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
  // --- Pending burn-down: version-history checkpoints/pending-summary/reject
  //     (ADR-052 D3/D4/D9, issue #380). REST-first (task 9); MCP tools land
  //     in the immediate follow-up task of the same issue (task 10). ---
  ['post /specs/{}/checkpoints', 'pending — issue #380 task 10: seal a spec-scoped checkpoint'],
  ['get /specs/{}/checkpoints', 'pending — issue #380 task 10: list spec-scoped checkpoints'],
  [
    'post /projects/{}/checkpoints',
    'pending — issue #380 task 10: seal a project-scoped checkpoint',
  ],
  ['get /projects/{}/checkpoints', 'pending — issue #380 task 10: list project-scoped checkpoints'],
  ['get /checkpoints/{}', 'pending — issue #380 task 10: read a single checkpoint'],
  [
    'get /specs/{}/pending-summary',
    'pending — issue #380 task 10: pending-change summary for one spec',
  ],
  [
    'get /projects/{}/pending-summary',
    'pending — issue #380 task 10: pending-change summary across a project',
  ],
  [
    'patch /specs/{}/paragraphs/{}/reject',
    'pending — issue #380 task 10: revert a paragraph to its last-checkpoint state',
  ],
]);

/** Tools with no single REST equivalent — allowed to map to nothing (INV-2). */
export const MCP_NATIVE: ReadonlySet<string> = new Set([
  // search_library now pairs with GET /search (see OP_TO_TOOL, #445).
  'load_files', // bulk file loader (CLI-style), no REST equivalent
  'list_sections', // CSI section index with inDatabase flag
  'get_paragraph', // single paragraph + ancestor chain, no dedicated REST route
  'get_references', // reads inbound+outbound in one call (REST splits these across routes)
  'get_numbering_profile', // effective resolved profile
  'get_onboarding_report',
  'review_editability',
  'clear_editability_override',
]);

/**
 * INV-5 (ADR-044 response-shape gap, #403). Tools whose success output legitimately RESHAPES
 * its mapped REST op's body — it does not return the REST `data` 1:1, so INV-5 does not
 * schema-validate it against that op. Each entry carries a reason, mirroring how MCP_UNEXPOSED
 * documents coverage exemptions. Never silent.
 */
export const INV5_SHAPE_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'get_spec',
    'reshapes: returns { tree, references } nested plus MCP _meta navigation anchors, whereas ' +
      'REST GET /specs/{id} returns the flattened spec tree with styleSource/onboardingStatus/' +
      'withdrawnAt at the top level — a deliberately different agent-facing shape, not the REST ' +
      'body 1:1.',
  ],
  [
    'get_library_conventions',
    'reshapes: embeds `inherited` INSIDE the data payload, whereas REST GET ' +
      '/libraries/{id}/conventions returns the raw resolved convention as `data` and the flag as ' +
      '`meta.inherited` at the envelope top level — the tool does not mirror the REST body 1:1, so ' +
      'wrapping it as { success, data } would never match the mapped op schema. (Reconciling the ' +
      'MCP shape toward REST would mutate shipping tool output — deferred to a follow-up.)',
  ],
  [
    'get_project_revision_nomenclature',
    'reshapes: embeds `inherited` INSIDE the data payload, whereas REST GET ' +
      '/projects/{id}/revision-nomenclature returns the raw profile as `data` and the flag as ' +
      '`meta.inherited` at the envelope top level — the tool does not mirror the REST body 1:1. ' +
      '(Reconciling the MCP shape toward REST would mutate shipping tool output — deferred to a ' +
      'follow-up.)',
  ],
  [
    'list_disciplines',
    'reshapes: returns just the resolved disciplines array, whereas REST GET /disciplines returns ' +
      'that array as `data` PLUS `meta.inherited` at the envelope top level (a required field). ' +
      'Wrapping the bare array as { success, data } therefore never satisfies the mapped op schema, ' +
      'which requires meta — same posture as get_library_conventions (#448 / ADR-065).',
  ],
]);

/**
 * INV-5 burn-down. Read tools that DO mirror their mapped REST op's body but are not yet driven
 * by INV-5 because they need a seeded fixture graph (a parsed spec, a project, a template, …)
 * beyond `pnpm seed`. This is the same posture ADR-044 takes with MCP_UNEXPOSED's `pending`
 * entries: entries graduate into INV-5's driven set as fixtures land. INV-5's completeness
 * invariant proves no read-mapped tool is silently absent from both the driven set and these maps.
 */
export const INV5_READ_PENDING: ReadonlySet<string> = new Set([
  // search_library returns the same rows as GET /search 1:1, but a non-vacuous
  // assertion needs seeded paragraph content (a parsed spec) beyond `pnpm seed`.
  'search_library',
  'get_spec_lineage',
  'get_hierarchy_report',
  'get_paragraph_history',
  'get_spec_history',
  'get_history_diff',
  'coordination_report',
  'get_reference_graph',
  'get_project_keynotes',
  'list_revit_links',
  'open_comments_report',
  'get_project',
  'list_associations',
  'get_spec_lock',
  'get_template',
  'get_required_sections',
  'get_package_required_sections',
  'list_library_numbering_profiles',
  'get_numbering_profile_by_id',
  'list_library_specs',
  // list_project_specs mirrors GET /projects/{id}/specs 1:1, but a non-vacuous assertion needs a
  // project with a spec in its TOC (an imported spec beyond `pnpm seed`) — same as list_library_specs.
  'list_project_specs',
  'get_library_general_spec',
  'get_project_general_spec',
  'list_packages',
  'list_package_revisions',
  'get_revision',
  'get_client',
  // actor identity substrate (#381 / ADR-052 D6): mirrors GET /users/{id} 1:1. Read-pending,
  // not driven: INV5_DRIVEN's harness invokes arg-less list handlers and asserts a non-empty
  // array, whereas get_user takes a userId and returns a single object — a different driven
  // path. Its response shape (UserSummary) is already validated by the driven `list_users`
  // case, which returns UserSummary[]; a dedicated single-object case is deferred to #464.
  'get_user',
  // standards rollups (#446): mirror GET /…/standards 1:1 but need a seeded
  // citation graph (a parsed spec citing standards) beyond `pnpm seed`.
  'list_library_standards',
  'list_project_standards',
  // header/footer config reads (#476 / ADR-040): mirror their mapped REST GETs 1:1, but
  // need a seeded header_footer_configs row (a set_*_header_footer call) beyond `pnpm seed`.
  'get_library_header_footer',
  'get_project_header_footer',
  'get_package_header_footer',
  'get_revision_header_footer',
  'resolve_project_header_footer',
  'resolve_package_header_footer',
  'resolve_revision_header_footer',
]);
