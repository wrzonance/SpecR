// examples/web_ui_demo/providers/openai.mjs
// OpenAI Responses API adapter. Owns its transcript as an opaque array of
// Response Items; runChat/runReport never see this shape.
//
// Progressive discovery is native: {type:'tool_search'} plus defer_loading on
// every non-core tool. All definitions are still SENT each request — the API
// keeps deferred ones out of the model's context until it searches for them.
import { splitCoreAndDeferred } from './tools.mjs';
import { normalizeProviderError } from './errors.mjs';

// Responses uses flat, internally-tagged function tools — no nested wrapper.
function toFunctionTool(tool) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

// The search tool ships only when something is actually deferred. The API
// rejects the alternative outright — "tools.tool_search requires at least one
// deferred tool" — which is reachable whenever the catalog is a subset of the
// core names (tier gating, or /report's read-only narrowing) or is empty.
// Nothing is lost by omitting it: with no deferred tools every definition is
// already declared and directly callable, so search has nothing to find.
function buildTools(catalog, coreToolNames) {
  const { core, deferred } = splitCoreAndDeferred(catalog, coreToolNames);
  const declared = [
    ...core.map(toFunctionTool),
    ...deferred.map((tool) => ({ ...toFunctionTool(tool), defer_loading: true })),
  ];
  return deferred.length > 0 ? [{ type: 'tool_search' }, ...declared] : declared;
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {}; // tolerate malformed model output rather than failing the turn
  }
}

function readText(output) {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('');
}

function readToolCalls(output) {
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      id: item.call_id,
      name: item.name,
      args: parseArguments(item.arguments),
    }));
}

export function createOpenAiSession({ system, userMessages, catalog, coreToolNames, config, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const tools = buildTools(catalog, coreToolNames);
  // The running transcript: seeded with the user turns, then grown with every
  // output item the API returns plus our tool results.
  const input = userMessages.map((m) => ({
    type: 'message',
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  async function post(extra) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await doFetch(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          instructions: system,
          input,
          tools,
          // The demo persists nothing server-side; encrypted reasoning rides in
          // the transcript instead.
          store: false,
          include: ['reasoning.encrypted_content'],
          ...extra,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw normalizeProviderError('openai', res.status, await res.text().catch(() => ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function absorb(response) {
    const output = Array.isArray(response.output) ? response.output : [];
    // Echo every item back verbatim next round — reasoning included, or the
    // model loses its chain of thought across the tool boundary.
    input.push(...output);
    return {
      text: readText(output),
      toolCalls: readToolCalls(output),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  return {
    async send() {
      return absorb(await post({}));
    },
    addToolResults(results) {
      for (const { id, text } of results) {
        input.push({ type: 'function_call_output', call_id: id, output: text });
      }
    },
    async finalize() {
      // Tools stay DECLARED — only new calls are suppressed. A transcript with
      // tool calls but no declared tools is rejected.
      const { text, usage } = absorb(await post({ tool_choice: 'none' }));
      return { text, usage };
    },
  };
}
