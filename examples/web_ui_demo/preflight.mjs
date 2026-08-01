// examples/web_ui_demo/preflight.mjs
// One real round-trip to the configured LLM provider before the demo starts, so
// a broken key surfaces at launch instead of on the user's first message.
//
// WHY THIS IS NOT A "HELLO" PING: a bare Responses/Messages call can succeed on
// a key that the demo still cannot use. A restricted OpenAI key was observed
// answering a plain `input: "hi"` with HTTP 200 and then rejecting the demo's
// actual request with `Missing scopes: api.responses.write` — the demo asks for
// hosted tool search and encrypted-reasoning echo, and those need permissions a
// plain completion does not. A naive probe would have reported "OK" while the
// chat stayed dead.
//
// So the probe goes through createSession — the SAME adapter /chat and /report
// use — with a catalog shaped like the real one: one core tool and one DEFERRED
// tool, which is what makes the adapter emit its tool-search tool. If this call
// succeeds, the request shape the demo sends is authorized.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadLocalEnv } from './env-file.mjs';
import { createSession } from './providers/index.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function stubTool(name, description) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  };
}

// One core + one deferred. The deferred entry is load-bearing: with nothing
// deferred the adapters omit their search tool (OpenAI rejects a search tool
// that has no deferred tools), and the probe would no longer cover the
// tool-search path the demo depends on.
export const PREFLIGHT_CATALOG = [
  stubTool('preflight_core', 'Connectivity probe — always loaded.'),
  stubTool('preflight_deferred', 'Connectivity probe — discovered on demand.'),
];
export const PREFLIGHT_CORE_TOOLS = ['preflight_core'];

// Resolve the active provider the same way server.mjs does. Returns null when
// LLM_PROVIDER names something unsupported — server.mjs owns that fatal check;
// the preflight only reports.
export function resolveProvider(env = process.env) {
  const name = (env.LLM_PROVIDER || 'openai').toLowerCase();
  if (name === 'openai') {
    const model = env.OPENAI_MODEL || 'gpt-5.6-luna';
    return {
      name,
      model,
      keyName: 'OPENAI_API_KEY',
      hasKey: (env.OPENAI_API_KEY || '') !== '',
      config: {
        model,
        apiKey: env.OPENAI_API_KEY || '',
        baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        timeoutMs: 20_000,
      },
    };
  }
  if (name === 'anthropic') {
    const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    return {
      name,
      model,
      keyName: 'ANTHROPIC_API_KEY',
      hasKey: (env.ANTHROPIC_API_KEY || '') !== '',
      config: {
        model,
        apiKey: env.ANTHROPIC_API_KEY || '',
        baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        version: '2023-06-01',
        maxTokens: 64,
        timeoutMs: 20_000,
      },
    };
  }
  return null;
}

// Returns { status, message, detail } — never throws, and never blocks startup.
// status: 'ok' | 'skipped' | 'failed'
export async function runProviderCheck(provider, { createSessionImpl = createSession } = {}) {
  if (!provider) {
    return { status: 'skipped', message: 'unknown LLM_PROVIDER — no check run', detail: '' };
  }
  if (!provider.hasKey) {
    return {
      status: 'skipped',
      message: `no ${provider.keyName} set — chat and Compose are disabled`,
      detail: '',
    };
  }
  try {
    const session = createSessionImpl({
      provider: provider.name,
      system: 'Connectivity check. Reply with the single word OK.',
      userMessages: [{ role: 'user', content: 'ping' }],
      catalog: PREFLIGHT_CATALOG,
      coreToolNames: PREFLIGHT_CORE_TOOLS,
      config: provider.config,
    });
    await session.send();
    return {
      status: 'ok',
      message: `${provider.name} reachable and authorized (model ${provider.model}, tool search accepted)`,
      detail: '',
    };
  } catch (err) {
    // normalizeProviderError has already turned a provider body into a clean
    // sentence plus any actionable hint (see providers/errors.mjs), so the
    // operator gets the fix, not a JSON dump.
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      detail: typeof err?.detail === 'string' ? err.detail : '',
    };
  }
}

export function formatResult(result) {
  if (result.status === 'ok') return [`Provider check: OK — ${result.message}`];
  if (result.status === 'skipped') return [`Provider check: skipped — ${result.message}`];
  return [
    `Provider check: FAILED — ${result.message}`,
    'The demo will still start, but Ask SpecR and Compose will fail until this is fixed.',
  ];
}

async function main() {
  loadLocalEnv(join(ROOT, '.env'));
  const result = await runProviderCheck(resolveProvider());
  for (const line of formatResult(result)) console.log(line);
  // Always exit 0: the rest of the demo (spec browsing, compare, downloads)
  // works without an LLM, so a provider problem must not stop it from starting.
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
