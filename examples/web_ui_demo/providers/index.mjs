// examples/web_ui_demo/providers/index.mjs
// Single entry point for the chat/report loops. Both surfaces build a session
// and then speak only send / addToolResults / finalize — never a provider shape.
import { createOpenAiSession } from './openai.mjs';
import { createAnthropicSession } from './anthropic.mjs';

export { CHAT_CORE_TOOLS, REPORT_CORE_TOOLS } from './tools.mjs';
export { ProviderError } from './errors.mjs';

export function createSession({ provider, ...rest }) {
  if (provider === 'openai') return createOpenAiSession(rest);
  if (provider === 'anthropic') return createAnthropicSession(rest);
  throw new Error(`unknown provider "${provider}" — use "openai" or "anthropic"`);
}
