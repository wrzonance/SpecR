// examples/web_ui_demo/providers/anthropic.mjs
// Anthropic Messages API adapter. Symmetric to the OpenAI one: it owns an
// opaque transcript of Messages-API content blocks.
//
// Tool search runs SERVER-side here. The server_tool_use and
// tool_search_tool_result blocks it produces must be echoed back unchanged, and
// a tool_result must never be returned for a srvtoolu_ id — the API rejects it.
import { splitCoreAndDeferred } from './tools.mjs';
import { normalizeProviderError } from './errors.mjs';

const SEARCH_TOOL = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' };

function toAnthropicTool(tool) {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

// Symmetric with the OpenAI adapter: no deferred tools means nothing for search
// to find, so the search tool is omitted rather than occupying a slot and
// context on every request. Unlike the OpenAI side — where sending it in that
// state is a live-verified 400 — this is a consistency choice, not a known
// Anthropic constraint. It is safe either way: what remains is entirely
// non-deferred, which is exactly what the Messages API requires.
function buildTools(catalog, coreToolNames) {
  const { core, deferred } = splitCoreAndDeferred(catalog, coreToolNames);
  const declared = [
    ...core.map(toAnthropicTool),
    ...deferred.map((tool) => ({ ...toAnthropicTool(tool), defer_loading: true })),
  ];
  return deferred.length > 0 ? [SEARCH_TOOL, ...declared] : declared;
}

// The Messages API requires alternating roles starting on a user turn. The
// browser sends a fixed-size slice of its transcript (chat.js history.slice), so
// the history can open on an assistant reply or carry back-to-back user turns
// after a failed send. Normalizing here preserves the fix from PR #457, which
// lived in the module this adapter replaces.
function normalizeHistory(userMessages) {
  const out = [];
  for (const message of userMessages) {
    // An empty turn is rejected by the API outright, and merging one into a
    // neighbour would inject a blank line rather than content. Drop it here so
    // the wire history is valid no matter what the caller passed.
    if (typeof message.content !== 'string' || message.content.trim() === '') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = out[out.length - 1];
    if (role === 'user' && previous?.role === 'user') {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }
    out.push({ role, content: message.content });
  }
  while (out.length > 0 && out[0].role === 'assistant') out.shift();
  return out;
}

export function createAnthropicSession({ system, userMessages, catalog, coreToolNames, config, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const tools = buildTools(catalog, coreToolNames);
  const messages = normalizeHistory(userMessages);

  async function post(extra) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await doFetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': config.version,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          system,
          messages,
          tools,
          ...extra,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw normalizeProviderError('anthropic', res.status, await res.text().catch(() => ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function absorb(response) {
    const blocks = Array.isArray(response.content) ? response.content : [];
    // Echo the assistant turn verbatim — server_tool_use and
    // tool_search_tool_result included, or discovered tools are lost.
    if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      // Only client-executable tool_use blocks. server_tool_use is Anthropic's
      // own search call and is never ours to run.
      toolCalls: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
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
      // Every result answering one assistant turn must land in ONE user message.
      const content = results.map(({ id, text }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: text,
      }));
      if (content.length > 0) messages.push({ role: 'user', content });
    },
    async finalize() {
      const { text, usage } = absorb(await post({ tool_choice: { type: 'none' } }));
      return { text, usage };
    },
  };
}
