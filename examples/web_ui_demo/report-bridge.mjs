// Pure orchestration for the demo's agent-driven grounded reporting (#353).
//
// SpecR's differentiator is deterministic-first, not RAG: the analytical facts
// (comparison matrix, coordination E&O, spec diff, references, submittal register)
// are COMPUTED by MCP tools over the CSI AST — the agent only narrates and
// synthesizes them. This module runs that read-only tool-calling loop and derives
// citations deterministically from each tool's `_meta['specr/anchors']`, never by
// parsing the model's prose. Everything here is I/O-free: the session + MCP calls
// are injected as `deps`, so the loop is unit-testable (report-bridge.test.mjs).
import { REPORT_CORE_TOOLS } from './providers/tools.mjs';

// The agent composes reports; it does not invent facts. This prompt keeps the
// model out of the fact-production path and steers it to the grounded tools.
export const REPORT_SYSTEM_PROMPT = [
  'You are the SpecR reporting agent. You compose grounded, cited reports about CSI',
  'MasterFormat specifications by CALLING read-only MCP tools and synthesizing their',
  'computed results. You never invent spec content, section numbers, product names,',
  'or UUIDs — every fact in your report comes from a tool result.',
  '',
  'Workflow: discover ids first with list_projects, list_sections, or search_library,',
  'then call the grounded reporting tools that best answer the request:',
  '- compare_specs — deterministic cross-spec comparison matrix (exactly two live specs;',
  '  for three-way asks, run pairwise comparisons and reconcile the results).',
  '- coordination_report — project errors-and-omissions (missing/extra sections, dangling',
  '  cross-references, article↔body reference consistency).',
  '- get_spec_diff — UUID-anchored 3-way diff between spec revisions.',
  '- get_references — inbound/outbound cross-references for a section.',
  '- submittal_register / open_comments_report / get_onboarding_report — supporting reports.',
  '',
  'Rules:',
  '- Prefer a grounded tool over guessing. If a deterministic tool answers it, call it.',
  '- Keep scope narrow: name the specific sections/projects the user asked about. Do NOT',
  '  diff or compare an entire corpus of hundreds of specs — ask the user to narrow if',
  '  the scope is unbounded.',
  '- When a tool returns an empty result, state "not present" plainly. Never fabricate to',
  '  fill a gap.',
  '- Cite section numbers (e.g. "03 30 00") in your narrative. The UI attaches click-through',
  '  sources automatically from the tool results, so you do not need to format citations.',
  '- Most tools are not preloaded — search for them by capability, then call them.',
  '- End with a concise, well-structured narrative that a spec writer can act on.',
].join('\n');

// Friendly, human-readable labels for the streamed step trace ("show the grounding").
// Known grounded tools get a verb phrase; anything else falls back to the tool name.
const STEP_LABELS = new Map([
  ['list_projects', () => 'Listing projects…'],
  ['list_sections', () => 'Listing sections…'],
  ['search_library', () => 'Searching the library…'],
  ['compare_specs', (a) => `Comparing ${count(a?.sources)} specs…`],
  ['coordination_report', () => 'Reading the coordination report…'],
  ['get_spec_diff', () => 'Diffing spec revisions…'],
  ['get_references', () => 'Resolving cross-references…'],
  ['get_spec', () => 'Reading a spec…'],
  ['get_paragraph', () => 'Reading a paragraph…'],
  ['submittal_register', () => 'Building the submittal register…'],
  ['open_comments_report', () => 'Reading open comments…'],
  ['get_onboarding_report', () => 'Reading the onboarding report…'],
]);

function count(arr) {
  return Array.isArray(arr) ? arr.length : 'the';
}

export function humanizeToolStep(name, args) {
  const make = STEP_LABELS.get(name);
  return make ? make(args) : `Calling ${name}…`;
}

// Keep only tools the MCP server flagged read-only (annotations.readOnlyHint,
// carried onto McpTool.readOnly by server.mjs's toMcpTool). This is the demo's
// structural answer to the "human-in-the-loop for writes" footgun. Under
// progressive discovery this matters MORE, not less: a deferred write tool
// would still be DISCOVERABLE by search, so write tools must be excluded from
// the catalog entirely rather than merely deferred.
export function filterReadOnlyTools(tools) {
  return tools.filter((tool) => tool && tool.readOnly === true);
}

// Collapse duplicate navigation anchors and cap the payload so a broad report
// cannot flood the UI. Mirrors chat-loop.mjs's dedupe for the /chat focus channel.
export function dedupeAnchors(anchors) {
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    if (!a || typeof a.section !== 'string' || a.section === '') continue;
    const key = `${a.section}|${a.specId ?? ''}|${a.paragraphId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= 50) break;
  }
  return out;
}

// A single MCP result is clamped before it is fed back to the session, so one
// broad tool payload cannot blow the token budget or bloat the forced final
// compose turn. Fail-closed at the module boundary — independent of any
// truncation the transport (server.mjs) also applies.
export const MAX_TOOL_RESULT_CHARS = 8000;

export function clampToolText(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

export function buildReportInput(request, scope) {
  const label = scope && typeof scope.label === 'string' ? scope.label.trim() : '';
  const userContent = label ? `${request}\n\nScope in this workspace — ${label}` : request;
  return { userContent };
}

function overBudget(ctx, limits) {
  return ctx.toolCalls.length >= limits.maxToolCalls || ctx.tokens > limits.tokenBudget;
}

function usageOf(ctx, round) {
  return { rounds: round, toolCalls: ctx.toolCalls.length, tokens: ctx.tokens };
}

// Emit the two-phase step event js/compose.js's renderStep requires: a
// 'running' event when the call starts, then 'done'|'error' once it finishes.
// Every branch below still returns a session-shaped { id, text } tool result,
// so the transcript stays valid for the model's next turn.
async function processCall(call, ctx, limits, deps) {
  ctx.stepNo += 1;
  const n = ctx.stepNo;
  // Budget first (bounds a single multi-call batch), then the read-only
  // allow-list (deny-by-default) — mirroring the pre-migration gate order.
  if (overBudget(ctx, limits)) {
    ctx.emit({
      type: 'step',
      n,
      tool: call.name,
      label: `Skipped ${call.name} — call budget reached`,
      status: 'error',
    });
    // Not pushed to ctx.toolCalls: this call never reached MCP, so counting it
    // would inflate the reported "grounded call" total (out.toolCalls / usage.
    // toolCalls) beyond the calls actually executed. The overBudget gate above
    // is driven by the same counter and is monotonic once tripped, so omitting
    // skipped calls here does not change which calls get skipped.
    return {
      id: call.id,
      text: 'tool error: report call budget reached; this call was not executed.',
    };
  }
  if (!ctx.allowed.has(call.name)) {
    ctx.emit({
      type: 'step',
      n,
      tool: call.name,
      label: `Blocked ${call.name} — not a read-only tool`,
      status: 'error',
    });
    ctx.toolCalls.push({ name: call.name, ok: false });
    return {
      id: call.id,
      text: `tool error: "${call.name}" is not an available read-only reporting tool; it was blocked and not executed.`,
    };
  }
  const step = {
    type: 'step',
    n,
    tool: call.name,
    label: humanizeToolStep(call.name, call.args),
    status: 'running',
  };
  ctx.emit(step);
  const { text, ok, anchors } = await deps.execTool(call);
  ctx.toolCalls.push({ name: call.name, ok });
  if (ok && Array.isArray(anchors) && anchors.length > 0) ctx.anchors.push(...anchors);
  ctx.emit({ ...step, status: ok ? 'done' : 'error' });
  return { id: call.id, text: clampToolText(text) };
}

// The read-only tool-calling loop. Asks the session, runs any tool calls it
// makes against MCP, feeds results back, and repeats until the session answers
// with plain text or a guardrail trips — then forces one final, tool-less
// narrative turn via session.finalize().
export async function runReport({ request, scope, deps, limits, emit }) {
  // Read-only pool ONLY — see filterReadOnlyTools. Everything here is a
  // candidate for discovery, so anything that could mutate state must be gone
  // from the catalog BEFORE the session is built, not merely deferred.
  const catalog = filterReadOnlyTools(await deps.listTools());
  // The allow-list enforced at execution time — independent of what the model
  // emits (a hallucination, or a name smuggled in via untrusted content).
  const allowed = new Set(catalog.map((tool) => tool.name));
  const { userContent } = buildReportInput(request, scope);
  const session = deps.createSession({
    system: REPORT_SYSTEM_PROMPT,
    userMessages: [{ role: 'user', content: userContent }],
    catalog,
    coreToolNames: REPORT_CORE_TOOLS,
  });

  const ctx = { emit, toolCalls: [], anchors: [], stepNo: 0, allowed, tokens: 0 };
  let roundsUsed = 0;

  for (let round = 1; round <= limits.maxRounds; round++) {
    roundsUsed = round;
    const { text, toolCalls: calls, usage } = await session.send();
    ctx.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (!calls || calls.length === 0) return finish(text || '', ctx, round);

    const results = [];
    for (const call of calls) results.push(await processCall(call, ctx, limits, deps));
    session.addToolResults(results);
    emit({ type: 'usage', ...usageOf(ctx, round) });
    if (overBudget(ctx, limits)) break;
  }
  // Guardrail or round cap tripped — force ONE closing answer with new tool
  // calls suppressed. Report the actual rounds used, not the max. This forced
  // call costs real provider tokens too, so it counts toward ctx.tokens just
  // like every session.send() call above.
  const final = await session.finalize();
  ctx.tokens += (final.usage?.inputTokens ?? 0) + (final.usage?.outputTokens ?? 0);
  return finish(final.text || 'Reached the report scope limit.', ctx, roundsUsed);
}

function finish(reply, ctx, round) {
  return {
    reply,
    citations: dedupeAnchors(ctx.anchors),
    toolCalls: ctx.toolCalls,
    usage: usageOf(ctx, round),
  };
}
