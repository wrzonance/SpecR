// Pure orchestration for the demo's agent-driven grounded reporting (#353).
//
// SpecR's differentiator is deterministic-first, not RAG: the analytical facts
// (comparison matrix, coordination E&O, spec diff, references, submittal register)
// are COMPUTED by MCP tools over the CSI AST — the agent only narrates and
// synthesizes them. This module runs that read-only tool-calling loop and derives
// citations deterministically from each tool's `_meta['specr/anchors']`, never by
// parsing the model's prose. Everything here is I/O-free: the OpenAI + MCP calls
// are injected as `deps`, so the loop is unit-testable (report-bridge.test.mjs).

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

// Keep only tools the MCP server flagged read-only (annotations.readOnlyHint).
// This is the demo's structural answer to the "human-in-the-loop for writes"
// footgun: the reporting agent is handed no write/destructive tool, so it cannot
// mutate state during composition.
export function filterReadOnlyTools(tools) {
  return tools.filter((tool) => tool && tool.__readOnly === true);
}

// Collapse duplicate navigation anchors and cap the payload so a broad report
// cannot flood the UI. Mirrors server.mjs's dedupe for the /chat focus channel.
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

// Rough token estimate (≈4 chars/token) to drive the cost/scope meter and the
// token budget guardrail. Deliberately cheap — an approximation, not a tokenizer.
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += typeof m?.content === 'string' ? m.content.length : 0;
  return Math.ceil(chars / 4);
}

export function buildReportMessages(request, scope, systemPrompt) {
  const label = scope && typeof scope.label === 'string' ? scope.label.trim() : '';
  const userContent = label ? `${request}\n\nScope in this workspace — ${label}` : request;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

// Execute one allow-listed model tool call against MCP via the injected exec,
// emit the paired running/done step events, and fold its anchors + trace into the
// accumulators. Only reached after the deny-by-default + budget gates pass.
async function executeToolCall(call, ctx) {
  const name = call.function?.name;
  const step = {
    type: 'step',
    n: ++ctx.stepNo,
    tool: name,
    label: humanizeToolStep(name, safeArgs(call)),
    status: 'running',
  };
  ctx.emit(step);
  const { text, ok, anchors } = await ctx.deps.execTool(call);
  ctx.toolCalls.push({ name, ok });
  if (Array.isArray(anchors)) ctx.anchors.push(...anchors);
  ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: text });
  ctx.emit({ ...step, status: ok ? 'done' : 'error' });
}

// Deny-by-default at the EXECUTION boundary. A call whose name was never
// advertised as a read-only tool — a model hallucination, or a name smuggled in
// via untrusted tool-result / document content (prompt injection) — must never
// reach MCP. Filtering the advertised tool list is not enough: the model can emit
// any name. We answer the tool_call_id with an error (so the message history
// stays valid for the final turn) and never invoke execTool.
function rejectDisallowedCall(call, ctx) {
  const name = call.function?.name;
  ctx.toolCalls.push({ name, ok: false });
  ctx.messages.push({
    role: 'tool',
    tool_call_id: call.id,
    content: `tool error: "${name}" is not an available read-only reporting tool; it was blocked and not executed.`,
  });
  ctx.emit({
    type: 'step',
    n: ++ctx.stepNo,
    tool: name,
    label: `Blocked ${name} — not a read-only tool`,
    status: 'error',
  });
}

// Call budget exhausted mid-batch: skip the remaining calls without touching MCP,
// but still answer each tool_call_id so the final compose turn has a valid history.
// This bounds a single multi-call assistant message to the tool-call budget.
function skipForBudget(call, ctx) {
  const name = call.function?.name;
  ctx.messages.push({
    role: 'tool',
    tool_call_id: call.id,
    content: 'tool error: report call budget reached; this call was not executed.',
  });
  ctx.emit({
    type: 'step',
    n: ++ctx.stepNo,
    tool: name,
    label: `Skipped ${name} — call budget reached`,
    status: 'error',
  });
}

// Route one tool call through the gates: budget first (bounds the batch), then the
// read-only allow-list (deny-by-default), then execute. Blocked and skipped calls
// each still push a tool response, so every tool_call_id is answered.
async function processCall(call, ctx, limits) {
  if (overBudget(ctx, limits)) return skipForBudget(call, ctx);
  if (!ctx.allowed.has(call.function?.name)) return rejectDisallowedCall(call, ctx);
  return executeToolCall(call, ctx);
}

function safeArgs(call) {
  try {
    return JSON.parse(call.function?.arguments || '{}');
  } catch {
    return {};
  }
}

function overBudget(ctx, limits) {
  return (
    ctx.toolCalls.length >= limits.maxToolCalls || estimateTokens(ctx.messages) > limits.tokenBudget
  );
}

function usageOf(ctx, round) {
  return { rounds: round, toolCalls: ctx.toolCalls.length, tokens: estimateTokens(ctx.messages) };
}

// The read-only tool-calling loop. Asks the model, runs any tool calls it makes
// against MCP, feeds results back, and repeats until the model answers with plain
// text or a guardrail trips — then forces one final, tool-less narrative turn.
export async function runReport({ request, scope, deps, limits, emit }) {
  const tools = filterReadOnlyTools(await deps.listTools());
  // The allow-list enforced at execution time — the set of read-only tool names
  // the model is permitted to actually invoke, independent of what it emits.
  const allowed = new Set(tools.map((tool) => tool.function?.name).filter(Boolean));
  const messages = buildReportMessages(request, scope, REPORT_SYSTEM_PROMPT);
  const ctx = { deps, emit, messages, toolCalls: [], anchors: [], stepNo: 0, allowed };

  for (let round = 1; round <= limits.maxRounds; round++) {
    const completion = await deps.callModel(messages, tools);
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('model returned no message');
    messages.push(message);
    const calls = message.tool_calls;
    if (!calls || calls.length === 0) {
      return finish(message.content || '', ctx, round);
    }
    for (const call of calls) await processCall(call, ctx, limits);
    emit({ type: 'usage', ...usageOf(ctx, round) });
    if (overBudget(ctx, limits)) break;
  }
  // Guardrail or round cap tripped — force a closing answer with tools disabled.
  const final = await deps.callModel(messages, []);
  return finish(
    final.choices?.[0]?.message?.content || 'Reached the report scope limit.',
    ctx,
    limits.maxRounds
  );
}

function finish(reply, ctx, round) {
  return {
    reply,
    citations: dedupeAnchors(ctx.anchors),
    toolCalls: ctx.toolCalls,
    usage: usageOf(ctx, round),
  };
}
