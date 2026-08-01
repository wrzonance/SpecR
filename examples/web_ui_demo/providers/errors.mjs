// examples/web_ui_demo/providers/errors.mjs
// One typed error for every provider failure. The clean sentence, the provider's
// code, and the raw body are kept as SEPARATE fields — never concatenated. The
// UI shows the sentence and hides the detail behind a disclosure.

export class ProviderError extends Error {
  constructor(message, { code = null, status = null, detail = '', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// Two provider errors are really CONFIGURATION problems, and both are made
// reachable by this demo's move to native tool search. Reported verbatim they
// are provider jargon; translated, each names the exact setting to change.

// 1. Tool search needs a model floor on both platforms (gpt-5.4+ / Opus 4.5+).
//    The providers report that as a generic unknown-parameter error.
function modelFloorHint(provider, message) {
  if (!/tool_search|defer_loading/i.test(message)) return null;
  return provider === 'openai'
    ? 'This demo needs an OpenAI model of gpt-5.4 or newer (set OPENAI_MODEL).'
    : 'This demo needs a Claude model of Sonnet 4.5 / Opus 4.5 or newer (set ANTHROPIC_MODEL).';
}

// 2. Tool search runs on OpenAI's Responses API, so a RESTRICTED key granted
//    only Chat Completions authenticates fine and then fails on the first turn.
//    The provider's own sentence never mentions which key or which product.
function scopeHint(provider, message) {
  if (provider !== 'openai') return null;
  if (!/missing scopes|insufficient permissions/i.test(message)) return null;
  if (!/responses/i.test(message)) return null;
  return (
    'This demo calls the OpenAI Responses API, so OPENAI_API_KEY needs the ' +
    'Responses write permission — enable it on the key (API keys → your key → ' +
    'Permissions), or use an unrestricted key.'
  );
}

function hintFor(provider, message) {
  return modelFloorHint(provider, message) ?? scopeHint(provider, message);
}

export function normalizeProviderError(provider, status, bodyText) {
  const detail = typeof bodyText === 'string' ? bodyText : '';
  let message = '';
  let code = null;
  try {
    const parsed = JSON.parse(detail);
    // OpenAI and Anthropic both nest the human-readable text at error.message.
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
    else if (typeof parsed?.error?.type === 'string') code = parsed.error.type;
  } catch {
    // Non-JSON body (gateway HTML, empty response) — fall through to the generic
    // message below and keep the raw text as detail.
  }
  if (message === '') message = `${provider} request failed with HTTP ${status}.`;
  const hint = hintFor(provider, message);
  if (hint) message = `${message} ${hint}`;
  return new ProviderError(message, { code, status, detail });
}
