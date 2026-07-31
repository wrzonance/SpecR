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

// Tool search needs a model floor on both platforms (gpt-5.4+ / Opus 4.5+). The
// providers report that as a generic unknown-parameter error, which tells a demo
// user nothing actionable — so we translate it.
function hintFor(provider, message) {
  if (!/tool_search|defer_loading/i.test(message)) return null;
  return provider === 'openai'
    ? 'This demo needs an OpenAI model of gpt-5.4 or newer (set OPENAI_MODEL).'
    : 'This demo needs a Claude model of Sonnet 4.5 / Opus 4.5 or newer (set ANTHROPIC_MODEL).';
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
