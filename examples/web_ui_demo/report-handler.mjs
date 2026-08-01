// examples/web_ui_demo/report-handler.mjs
// POST /report (#353): streams the agent's tool-calling steps live as
// newline-delimited JSON (one object per line: step | usage | done | error).
// Reuses the same MCP + LLM plumbing as /chat, but hands the model only
// read-only tools — see report-bridge.mjs's runReport for the loop itself.
import { runReport } from './report-bridge.mjs';
import { createSession } from './providers/index.mjs';
import { readBoundedBody } from './http-utils.mjs';

// A report streams for as long as the loop runs, so the client can disconnect
// mid-flight. runReport keeps going (request-scoped cancellation is out of
// scope), and every later write would then target a destroyed socket and raise
// an unhandled error on the response stream. Skipping the write is enough to
// keep that path quiet without touching the session interface.
function reportEmitter(res) {
  return (obj) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(obj)}\n`, () => {});
  };
}

function parseReportRequest(payload, maxRequestChars) {
  const request = payload?.request;
  if (typeof request !== 'string' || request.trim() === '')
    return { error: 'request text required' };
  if (request.length > maxRequestChars) return { error: 'request too long' };
  // buildReportInput appends the label to the user content, so it inflates the
  // provider prompt exactly like `request` does — bound it the same way rather
  // than letting it run to the body cap.
  const rawLabel = payload?.scope?.label;
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (label.length > maxRequestChars) return { error: 'scope label too long' };
  const scope = label ? { label } : undefined;
  return { request, scope };
}

// Read + JSON-parse the bounded request body, or a message for the caller to
// stream back as an `error` event.
async function readReportPayload(req, maxBodyBytes) {
  try {
    const raw = await readBoundedBody(req, maxBodyBytes);
    return { payload: raw ? JSON.parse(raw.toString('utf8')) : null };
  } catch (err) {
    return {
      error: err?.code === 'BODY_TOO_LARGE' ? 'request body too large' : 'invalid JSON body',
    };
  }
}

// `provider` is one PROVIDERS entry and `bridge` is the createMcpBridge(apiBase)
// result, both resolved once at boot in server.mjs and injected here.
export function createReportHandler({ provider, bridge, limits, maxBodyBytes, maxRequestChars }) {
  return async function handleReport(req, res) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = reportEmitter(res);
    if (!provider.hasKey) {
      emit({
        type: 'error',
        code: 'no-key',
        error: `${provider.keyName} not configured on the demo server`,
      });
      res.end();
      return;
    }
    const { payload, error: bodyError } = await readReportPayload(req, maxBodyBytes);
    if (bodyError) {
      emit({ type: 'error', error: bodyError });
      res.end();
      return;
    }
    const { request, scope, error } = parseReportRequest(payload, maxRequestChars);
    if (error) {
      emit({ type: 'error', error });
      res.end();
      return;
    }
    try {
      const result = await runReport({
        request,
        scope,
        emit,
        limits,
        deps: {
          listTools: bridge.listMcpTools,
          createSession: (opts) =>
            createSession({ ...opts, provider: provider.name, config: provider.config }),
          execTool: bridge.execToolCall,
        },
      });
      emit({ type: 'done', ...result, provider: provider.name, model: provider.model });
    } catch (err) {
      // Same shape /chat returns for a provider failure ({code, error, detail}),
      // so the report UI can tell an auth failure from a rate limit instead of
      // receiving one undifferentiated sentence. A non-Error throw would make
      // `err.message` undefined, hence the String() fallback.
      emit({
        type: 'error',
        code: err?.code ?? null,
        error: `report failed: ${err?.message ?? String(err)}`,
        detail: err?.detail ?? '',
      });
    } finally {
      res.end();
    }
  };
}
