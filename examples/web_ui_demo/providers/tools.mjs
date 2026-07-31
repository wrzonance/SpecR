// examples/web_ui_demo/providers/tools.mjs
// Partitions the MCP catalog into an always-loaded core set and a deferred
// remainder. Both providers' tool search loads deferred definitions on demand;
// both reject a request where every tool is deferred, so the core set is a
// protocol requirement rather than an optimization.
//
// Core slots cost context on every request and buy a fast, reliable FIRST turn.
// They do not affect capability — deferred tools stay reachable via search.

// Chat: the five tools a spec-editor question most often opens with.
// get_references is here because the chat greeting advertises
// "which sections cite 09 22 00?" (index.html) as an example question.
export const CHAT_CORE_TOOLS = [
  'list_projects',
  'list_sections',
  'search_library',
  'get_spec',
  'get_references',
];

// Report: exactly the discovery tools REPORT_SYSTEM_PROMPT instructs the model
// to call first ("discover ids first with list_projects, list_sections, or
// search_library").
export const REPORT_CORE_TOOLS = ['list_projects', 'list_sections', 'search_library'];

export function splitCoreAndDeferred(catalog, coreNames) {
  const wanted = new Set(coreNames);
  const core = [];
  const deferred = [];
  for (const tool of catalog) {
    if (wanted.has(tool.name)) core.push(tool);
    else deferred.push(tool);
  }
  // A core tool can be absent from the catalog entirely when MCP_ALLOWED_TIERS
  // gates it away. Partitioning over what tools/list actually returned means a
  // gated tool simply doesn't appear — never a phantom entry the API would reject.
  if (core.length === 0) {
    throw new Error(
      'tool partition produced an empty core set — at least one non-deferred tool is required'
    );
  }
  return { core, deferred };
}
