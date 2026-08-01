// examples/web_ui_demo/chat-handler.mjs
// POST /chat: the browser's conversation goes to the active provider's chat
// loop (OpenAI or Anthropic) with tool-calling, and every tool call the model
// makes is executed against SpecR's stateless MCP endpoint. The key never
// leaves the server process.
import { createSession, CHAT_CORE_TOOLS } from './providers/index.mjs';
import { runChat } from './chat-loop.mjs';
import { sendJson, readBoundedBody } from './http-utils.mjs';

export const SYSTEM_PROMPT = [
  'You are the SpecR assistant, embedded in a CSI MasterFormat specification tool.',
  'Answer questions about the specs, projects, and libraries the user has loaded by',
  'calling the provided MCP tools — never invent spec content, section numbers, or IDs.',
  'Most tools need UUIDs: discover them first with list_projects, list_sections, or',
  'search_library, then call the specific tool. Cross-references need a projectId.',
  'Keep answers concise and cite section numbers (e.g. "09 22 00") where relevant.',
  'If a tool returns an error or empty result, say so plainly rather than guessing.',
  'Most tools are discovered on demand — search for them by capability. Categories:',
  'projects, specs and paragraphs, packages and issued revisions, headers/footers,',
  'language rules, coordination and reporting, templates and numbering profiles.',
].join(' ');

// Keep only well-formed user/assistant turns with string content, length-capped.
// Empty content is dropped, not forwarded: both providers reject a turn whose
// content is the empty string, and an assistant turn can end up empty when a
// previous send failed before any text arrived.
function sanitizeMessages(messages) {
  const clean = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    const content = message.content.slice(0, 4000);
    if (content.trim() === '') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    clean.push({ role, content });
  }
  return clean;
}

// Parse + validate the /chat request body down to a clean message list, or an
// error string for the caller to surface as a 400. Isolated from handleChat
// so the handler itself stays a short, flat sequence of guard clauses.
//
// The read is BOUNDED, matching /report: maxMessages and sanitizeMessages'
// per-turn slice both run after parsing, so neither bounds memory — only
// refusing to buffer an oversized body does.
async function parseChatBody(req, maxMessages, maxBodyBytes) {
  let payload;
  try {
    const raw = await readBoundedBody(req, maxBodyBytes);
    payload = raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch (err) {
    return {
      error: err?.code === 'BODY_TOO_LARGE' ? 'request body too large' : 'invalid JSON body',
    };
  }
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { error: 'messages[] required' };
  if (messages.length > maxMessages) return { error: 'conversation too long' };
  const clean = sanitizeMessages(messages);
  if (clean.length === 0) return { error: 'no valid messages' };
  return { messages: clean };
}

// `provider` is one PROVIDERS entry (name/model/keyName/hasKey/config) and
// `bridge` is the createMcpBridge(apiBase) result — both resolved once at
// boot in server.mjs and injected here so this module never reads process.env.
export function createChatHandler({ provider, bridge, maxMessages, maxRounds, maxBodyBytes }) {
  return async function handleChat(req, res) {
    if (!provider.hasKey) {
      sendJson(res, 200, {
        success: false,
        code: 'no-key',
        error: `${provider.keyName} not configured on the demo server`,
      });
      return;
    }
    const parsed = await parseChatBody(req, maxMessages, maxBodyBytes);
    if (parsed.error) {
      sendJson(res, 400, { success: false, error: parsed.error });
      return;
    }
    try {
      const catalog = await bridge.listMcpTools();
      const session = createSession({
        provider: provider.name,
        system: SYSTEM_PROMPT,
        userMessages: parsed.messages,
        catalog,
        coreToolNames: CHAT_CORE_TOOLS,
        config: provider.config,
      });
      const { reply, toolCalls, focus } = await runChat({
        session,
        execTool: bridge.execToolCall,
        maxRounds,
      });
      sendJson(res, 200, {
        success: true,
        data: { reply, toolCalls, focus, provider: provider.name, model: provider.model },
      });
    } catch (err) {
      sendJson(res, 502, {
        success: false,
        code: err.code ?? null,
        error: err.message,
        detail: err.detail ?? '',
      });
    }
  };
}
