// Pure translation between the demo's internal OpenAI chat-completions shapes
// and the Anthropic Messages API (POST /v1/messages). The demo's tool loops
// (server.mjs runChat, report-bridge.mjs runReport) speak OpenAI shapes
// end-to-end; when LLM_PROVIDER=anthropic, server.mjs translates at the wire
// with these functions. Everything here is I/O-free and unit-tested
// (llm-providers.test.mjs).

// One OpenAI function tool → one Anthropic tool. The internal __readOnly flag
// (and the {type:'function'} wrapper) never reach the wire — the same rule the
// OpenAI path enforces before hitting /chat/completions.
export function toAnthropicTools(tools) {
  return (tools || []).map(({ function: fn }) => ({
    name: fn.name,
    description: fn.description || '',
    input_schema:
      fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
  }));
}

function parseToolArguments(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {}; // mirrors execToolCall's tolerance for malformed model output
  }
}

// Assistant turn → Anthropic content blocks (text first, then tool_use).
// Returns null for a turn with nothing in it — Anthropic rejects empty
// assistant content, and an empty turn carries no information anyway.
function toAssistantBlocks(message) {
  const blocks = [];
  if (typeof message.content === 'string' && message.content !== '') {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input: parseToolArguments(call.function?.arguments),
    });
  }
  return blocks.length > 0 ? blocks : null;
}

// Fold one OpenAI role:'tool' message into the accumulator. All tool results
// answering the same assistant turn must land in ONE user message — the
// Messages API rejects them split across turns.
function appendToolResult(out, message) {
  const block = {
    type: 'tool_result',
    tool_use_id: message.tool_call_id,
    content: typeof message.content === 'string' ? message.content : '',
  };
  const prev = out[out.length - 1];
  if (prev?.role === 'user' && Array.isArray(prev.content)) {
    prev.content.push(block);
  } else {
    out.push({ role: 'user', content: [block] });
  }
}

// Fold a plain user turn into the accumulator. Consecutive user turns merge
// because the Messages API requires alternating user/assistant roles (the
// browser history can contain back-to-back user turns after a failed send).
function appendUserText(out, text) {
  const prev = out[out.length - 1];
  if (prev?.role === 'user') {
    if (Array.isArray(prev.content)) prev.content.push({ type: 'text', text });
    else prev.content = `${prev.content}\n\n${text}`;
    return;
  }
  out.push({ role: 'user', content: text });
}

// OpenAI-shaped history → { system, messages } for the Messages API. A leading
// system message becomes the top-level `system` parameter (both loops always
// put it first); anything unrecognized degrades to a user text turn.
export function toAnthropicRequest(messages) {
  let system;
  const out = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && index === 0) {
      system = message.content;
    } else if (message.role === 'assistant') {
      const blocks = toAssistantBlocks(message);
      if (blocks) out.push({ role: 'assistant', content: blocks });
    } else if (message.role === 'tool') {
      appendToolResult(out, message);
    } else {
      appendUserText(out, typeof message.content === 'string' ? message.content : '');
    }
  }
  return { system, messages: out };
}

// Anthropic response → the OpenAI chat-completion envelope the loops expect.
// tool_calls is present only when the model actually asked for tools, so
// runChat's "no calls → final answer" exit works unchanged.
export function fromAnthropicResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));
  const message = { role: 'assistant', content: text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { choices: [{ message }] };
}
