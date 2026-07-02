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
  ['post /parse', 'parse_document'],
  ['get /projects/{}/coordination-report', 'coordination_report'],
  ['post /projects/{}/submittal-register', 'submittal_register'],
  ['get /specs/{}/open-comments', 'open_comments_report'],
  ['get /projects/{}/open-comments', 'open_comments_report'],
  ['post /specs/{}/reclassify', 'reclassify_spec'],
  ['patch /specs/{}/paragraphs/{}/editability', 'set_editability_override'],
  ['post /projects', 'create_project'], // added in Task 7
  // …extend during Step 3 triage and in each write-tool wave.
]);

/** REST ops intentionally NOT exposed as MCP tools. Each needs a reason. Burned down over time. */
export const MCP_UNEXPOSED: ReadonlyMap<string, string> = new Map([
  ['get /health', 'liveness probe — not an agent action'],
  // Static/contract/doc routes and every not-yet-wired write op land here during triage.
]);

/** Tools with no single REST equivalent — allowed to map to nothing (INV-2). */
export const MCP_NATIVE: ReadonlySet<string> = new Set([
  'search_library', // no /search route; MCP-native affordance
  'load_files', // bulk file loader (CLI-style), no REST equivalent
  'list_sections', // CSI section index with inDatabase flag
  'get_paragraph', // single paragraph + ancestor chain, no dedicated REST route
  'get_references', // reads inbound+outbound in one call
  'get_numbering_profile', // effective resolved profile
  'generate_docx', // egress helper; REST generate route may differ in shape
  'get_onboarding_report',
  'review_editability',
  'clear_editability_override',
]);
